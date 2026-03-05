/**
 * Draft / approval plugin — "write like me" mode
 *
 * Commands
 * ────────
 * .draft             → reply to a message to generate 1 draft reply
 * .send [id]         → approve and copy the draft reply
 *                       (id is optional if only one pending draft)
 * .cancel [id]        → discard a pending draft
 * .drafts             → list pending drafts for this chat
 *
 * env vars
 * ────────
 * OPENAI_API_KEY     – required
 * OPENAI_MODEL       – optional, defaults to gpt-4o-mini
 * DRAFT_PERSONA      – optional, free-text personality description
 * DRAFT_EXAMPLES     – optional, JSON array of {from, reply} pairs
 * DRAFT_DM_ONLY      – optional, if true always DM drafts to requester
 * DRAFT_GROUP_ACK    – optional, if true posts a small "check DM" ack in group
 */

const { bot } = require("../lib");
const { generateDraftReplies } = require("../lib/draftstyle");
const store = require("../lib/draftstore");
const { jidToNum } = require("../lib");
const chatHistory = require("../lib/chathistory");
const { extractDateOptions } = require("../lib/dateOptions");
const { isFreeOnDays } = require("../lib/googleCalendar");

// Temporary allowlist for auto-reply test
const DEFAULT_AUTO_REPLY_TARGETS = [
  "85261924337",
  "85298017183",
  "85269981788",
  "85297513151",
  "85298635033",
  "85254841551",
  "85290633373",
  "85263794109",
];
const AUTO_REPLY_COOLDOWN_MS = 15000;
const autoReplyLastSentAt = new Map(); // jid -> timestamp

// ── helpers ───────────2─────────────────────────────────────────────────────

function truthy(v) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(v || "")
      .trim()
      .toLowerCase(),
  );
}

function normalizePhone(raw) {
  return String(raw || "").replace(/\D+/g, "");
}

function getAutoReplyTargets(ctx) {
  const envRaw = (
    ctx?.AUTO_DRAFT_TARGETS ||
    process.env.AUTO_DRAFT_TARGETS ||
    ""
  )
    .split(",")
    .map((x) => normalizePhone(x))
    .filter(Boolean);
  return envRaw.length ? envRaw : DEFAULT_AUTO_REPLY_TARGETS;
}

function shouldAutoReplyToContact(message, ctx) {
  if (!message || message.isGroup) return false;
  const enabled = truthy(
    ctx?.AUTO_DRAFT_ENABLED || process.env.AUTO_DRAFT_ENABLED || "true",
  );
  if (!enabled) return false;

  const contactNum = normalizePhone(jidToNum(message.jid));
  const targets = getAutoReplyTargets(ctx);
  return targets.includes(contactNum);
}

function firstNameFromMessage(message) {
  const display = String(message?.pushName || "").trim();
  if (!display) return "";
  return display.split(/\s+/)[0] || "";
}

function isInTownQuestion(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  if (!t) return false;
  // English variants
  if (/\bare\s+(you|u)\s+in\s+town\b/.test(t)) return true;
  if (/\bu\s+in\s+town\b/.test(t)) return true;
  if (/\bback\s+in\s+town\b/.test(t)) return true;

  // HK variants (e.g. "Back hk yet?", "back in hk yet", "back to hong kong yet")
  if (/\bback\s+(in\s+)?hk\s+yet\b/.test(t)) return true;
  if (/\b(back\s+)?hong\s*kong\s+yet\b/.test(t)) return true;
  if (/\bback\s+to\s+hk\b/.test(t)) return true;
  if (/\bback\s+to\s+hong\s*kong\b/.test(t)) return true;

  // Chinese variants (e.g. "你幾時再返香港?")
  // Match broadly for "返香港" with optional time words.
  if (/返\s*香港/.test(t)) return true;
  return false;
}

function formatDay(d) {
  // e.g. "24 Jan"
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

async function tryCalendarPick(messageText, ctx) {
  const enabled = truthy(
    ctx?.AUTO_DRAFT_CALENDAR || process.env.AUTO_DRAFT_CALENDAR || "true",
  );
  if (!enabled) {
    console.log("[auto-reply] calendar check disabled (AUTO_DRAFT_CALENDAR)");
    return null;
  }

  const parsed = extractDateOptions(messageText);
  if (!parsed?.days?.length) {
    console.log("[auto-reply] no date options found in message, skipping calendar check");
    return null;
  }

  const calendarId = (
    ctx?.GOOGLE_CALENDAR_ID ||
    process.env.GOOGLE_CALENDAR_ID ||
    "primary"
  ).trim();
  const timeZone = (
    ctx?.GOOGLE_TIMEZONE ||
    process.env.GOOGLE_TIMEZONE ||
    "Asia/Hong_Kong"
  ).trim();

  const dayStrs = parsed.days.map((d) => d.toISOString().slice(0, 10));
  console.log(`[auto-reply] checking Google Calendar for days: ${dayStrs.join(", ")} (calendarId=${calendarId}, tz=${timeZone})`);

  let availability;
  try {
    availability = await isFreeOnDays({
      days: parsed.days,
      calendarId,
      timeZone,
    });
    const results = dayStrs.map((d) => `${d}=${availability.get(d)}`).join(", ");
    console.log(`[auto-reply] calendar availability: ${results}`);
  } catch (_e) {
    console.log(`[auto-reply] calendar API error: ${_e?.message || _e}`);
    return null;
  }

  const freeDays = parsed.days.filter(
    (d) => availability.get(d.toISOString().slice(0, 10)) === true,
  );
  const busyDays = parsed.days.filter(
    (d) => availability.get(d.toISOString().slice(0, 10)) === false,
  );

  if (freeDays.length === 0) {
    // both busy: ask for alternatives
    const opts = parsed.days.map(formatDay).join(" or ");
    return `Hmm I think I'm booked on ${opts} 😣 could you suggest a couple other dates? 🙏🏻`;
  }

  // pick first free day (usually earlier)
  freeDays.sort((a, b) => a.getTime() - b.getTime());
  const pick = freeDays[0];
  const pickStr = formatDay(pick);

  // If there were multiple options, acknowledge choice
  if (parsed.days.length >= 2) {
    return `${pickStr} works for me 😊`;
  }
  return `That works for me 😊`;
}

async function sendText(message, toJid, text, options = {}) {
  // Same chat: use framework helper (supports quoted, etc.)
  if (!toJid || toJid === message.jid) {
    return await message.send(text, options);
  }

  // Cross-chat (DM): use baileys client directly (no quoting across chats)
  if (typeof message?.client?.sendMessage === "function") {
    return await message.client.sendMessage(toJid, {
      text: String(text || ""),
    });
  }

  // Fallback (will be public)
  return await message.send(text, options);
}

function fmtDraft(draft) {
  const expiresIn = Math.round((draft.expiresAt - Date.now()) / 60000);
  const reply = draft.options?.[0] || "";
  const where = draft.sourceIsGroup ? "group" : "chat";
  const lines = [
    `*Draft ID:* \`${draft.id}\`  (expires in ${expiresIn}m)`,
    `*Original:* _"${truncate(draft.targetText, 80)}"_`,
    draft.sourceJid ? `*From:* ${where} \`${draft.sourceJid}\`` : null,
    "",
    `*Draft:* ${reply}`,
    "",
    `Approve with: \`.send ${draft.id}\`  (or just \`.send\`)  •  Cancel: \`.cancel ${draft.id}\``,
  ];
  return lines.filter(Boolean).join("\n");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ── .draft ─────────────────────────────────────────────────────────────────

bot(
  {
    pattern: "draft ?(.*)",
    desc: 'Generate "write like me" draft replies for the quoted message',
    type: "AI",
  },
  async (message, match, ctx) => {
    if (!ctx.OPENAI_API_KEY && !(process.env.OPENAI_API_KEY || "").trim()) {
      return await message.send(
        "⚠️ *OPENAI_API_KEY* is not set. Add it to your `config.env` to use draft mode.",
      );
    }

    const sessionId = message.id;
    const dmOnly = truthy(ctx.DRAFT_DM_ONLY || process.env.DRAFT_DM_ONLY);
    const groupAck = truthy(ctx.DRAFT_GROUP_ACK || process.env.DRAFT_GROUP_ACK);

    const sourceJid = message.jid;
    const sourceIsGroup = !!message.isGroup;

    // In groups: DM the requester (so others don't see the draft/status)
    const ownerJid = message.isGroup ? message.participant : message.jid;
    const replyJid = dmOnly || message.isGroup ? ownerJid : message.jid;
    if (!replyJid) {
      return await message.send(
        "❌ Could not determine who to DM. Try in a private chat.",
      );
    }

    // Must reply to a message
    if (!message.reply_message || !message.reply_message.text) {
      return await sendText(
        message,
        replyJid,
        "*Usage:* Reply to a message with `.draft` to get AI-generated draft replies in your style.",
      );
    }

    // Concurrency guard — one generation per chat at a time
    if (store.isGenerating(replyJid)) {
      return await sendText(
        message,
        replyJid,
        "⏳ Already generating a draft. Please wait…",
      );
    }

    const targetText = message.reply_message.text;
    const extraContext = match ? match.trim() : "";

    store.setGenerating(replyJid, true);

    if (replyJid !== message.jid && message.isGroup && groupAck) {
      await message.send("✅ Check your DM.");
    }
    await sendText(message, replyJid, "✍️ Generating a draft reply…");

    try {
      const conversationHistory =
        chatHistory.formatHistoryForContext(sourceJid);
      const options = await generateDraftReplies(
        targetText,
        extraContext,
        conversationHistory,
      );
      const draft = store.saveDraft({
        jid: replyJid,
        sessionId,
        sourceJid,
        sourceIsGroup,
        targetText,
        options,
      });
      const sendOpts = replyJid === message.jid ? { quoted: message.data } : {};
      await sendText(message, replyJid, fmtDraft(draft), sendOpts);
    } catch (e) {
      const errMsg = String(
        e?.response?.data?.error?.message || e?.message || e,
      );
      await sendText(
        message,
        replyJid,
        `❌ Failed to generate draft: ${errMsg}`,
      );
    } finally {
      store.setGenerating(replyJid, false);
    }
  },
);

// ── auto-reply (private, allowlisted contact only) ────────────────────────
bot(
  { on: "text", fromMe: false, type: "autoDraftReply" },
  async (message, _match, ctx) => {
    console.log(`[auto-reply] handler triggered for jid=${message.jid} text="${message.text?.trim()}"`);
    if (!shouldAutoReplyToContact(message, ctx)) {
      console.log(`[auto-reply] skipped: not an allowlisted contact (jid=${message.jid})`);
      return;
    }
    if (!message.text || !message.text.trim()) return;
    // ignore command-like messages
    if (/^[./!#]/.test(message.text.trim())) return;

    const now = Date.now();
    const key = message.jid;
    const last = autoReplyLastSentAt.get(key) || 0;
    if (now - last < AUTO_REPLY_COOLDOWN_MS) {
      console.log(`[auto-reply] skipped: cooldown active for ${message.jid}`);
      return;
    }

    // Capture incoming message in history
    chatHistory.addMessage(key, { fromMe: false, text: message.text.trim() });

    // Avoid overlapping generations per chat
    if (store.isGenerating(key)) return;
    store.setGenerating(key, true);
    try {
      // Hard-coded rule override
      if (isInTownQuestion(message.text)) {
        const first = firstNameFromMessage(message);
        const prefix = first ? `Hi ${first}, ` : "Hi, ";
        const canned =
          prefix +
          "I'm not in town yet. Will definitely let you guys know when I've booked the ticket! 🙏🏻😊 Thank you so much.";
        await message.send(canned, { quoted: message.data });
        chatHistory.addMessage(key, { fromMe: true, text: canned });
        autoReplyLastSentAt.set(key, now);
        return;
      }

      // Calendar-aware date picking
      console.log(`[auto-reply] received message from ${message.jid}: "${message.text.trim()}"`);
      const calendarReply = await tryCalendarPick(message.text, ctx);
      if (calendarReply) {
        console.log(`[auto-reply] calendar reply selected: "${calendarReply}"`);
        await message.send(calendarReply, { quoted: message.data });
        chatHistory.addMessage(key, { fromMe: true, text: calendarReply });
        autoReplyLastSentAt.set(key, now);
        return;
      }

      const conversationHistory = chatHistory.formatHistoryForContext(key);
      const options = await generateDraftReplies(
        message.text.trim(),
        "",
        conversationHistory,
      );
      const reply = String(options?.[0] || "").trim();
      if (!reply) return;
      await message.send(reply, { quoted: message.data });
      chatHistory.addMessage(key, { fromMe: true, text: reply });
      autoReplyLastSentAt.set(key, now);
    } catch (_e) {
      // Silent fail for background auto-reply
    } finally {
      store.setGenerating(key, false);
    }
  },
);

// ── .send ──────────────────────────────────────────────────────────────────

bot(
  {
    pattern: "send ?(.*)",
    desc: "Approve and copy a draft reply: .send [draft-id]",
    type: "AI",
  },
  async (message, match) => {
    const jid = message.isGroup ? message.participant : message.jid;
    const replyJid = jid || message.jid;
    const arg = (match || "").trim();
    const parts = arg ? arg.split(/\s+/) : [];

    // Backwards compatible:
    // - `.send`                   -> approve option 1 from the only pending draft
    // - `.send <draftId>`         -> approve option 1 from that draft
    // - `.send 1 <draftId>`       -> still accepted (choice is ignored if draft has only 1 option)
    let choice = 1;
    let idArg = null;

    if (parts.length === 0) {
      // resolve later from pending list
    } else if (parts.length === 1) {
      const maybeChoice = parseInt(parts[0], 10);
      if (!isNaN(maybeChoice) && maybeChoice >= 1 && maybeChoice <= 3) {
        choice = maybeChoice;
      } else {
        idArg = parts[0];
      }
    } else {
      const maybeChoice = parseInt(parts[0], 10);
      if (!isNaN(maybeChoice) && maybeChoice >= 1 && maybeChoice <= 3) {
        choice = maybeChoice;
        idArg = parts[1];
      } else {
        // treat first token as id, ignore rest
        idArg = parts[0];
      }
    }

    // Resolve which draft to act on
    let draft = null;
    if (idArg) {
      draft = store.getDraft(idArg);
      if (!draft) {
        return await sendText(
          message,
          replyJid,
          `❌ Draft \`${idArg}\` not found or expired.`,
        );
      }
    } else {
      const pending = store.pendingForChat(jid);
      if (pending.length === 0) {
        return await sendText(
          message,
          replyJid,
          "❌ No pending drafts. Use `.draft` first.",
        );
      }
      if (pending.length > 1) {
        const ids = pending.map((d) => `\`${d.id}\``).join(", ");
        return await sendText(
          message,
          replyJid,
          `⚠️ Multiple pending drafts: ${ids}\nSpecify which one: \`.send <draftId>\``,
        );
      }
      draft = pending[0];
    }

    if (draft.status !== "pending") {
      return await sendText(
        message,
        replyJid,
        `ℹ️ Draft \`${draft.id}\` is already *${draft.status}*. Nothing to send.`,
      );
    }

    const maxChoice = Math.max(1, draft.options?.length || 0);
    if (choice > maxChoice) {
      return await sendText(
        message,
        replyJid,
        `❌ That draft only has ${maxChoice} option(s). Use \`.send ${draft.id}\``,
      );
    }

    const reply = (draft.options || [])[choice - 1];
    if (!reply) {
      return await sendText(
        message,
        replyJid,
        `❌ Option ${choice} not found in draft \`${draft.id}\`.`,
      );
    }

    store.markSent(draft.id);

    // Show the approved text — user copies & pastes it themselves
    await sendText(
      message,
      replyJid,
      `✅ *Draft approved!*\n\nCopy and send this reply:\n\n${reply}`,
    );
  },
);

// ── .cancel ────────────────────────────────────────────────────────────────

bot(
  {
    pattern: "cancel ?(.*)",
    desc: "Cancel a pending draft: .cancel [draft-id]",
    type: "AI",
  },
  async (message, match) => {
    const idArg = (match || "").trim() || null;
    const jid = message.isGroup ? message.participant : message.jid;
    const replyJid = jid || message.jid;

    let draft = null;
    if (idArg) {
      draft = store.getDraft(idArg);
      if (!draft) {
        return await sendText(
          message,
          replyJid,
          `❌ Draft \`${idArg}\` not found or already expired.`,
        );
      }
    } else {
      const pending = store.pendingForChat(jid);
      if (pending.length === 0) {
        return await sendText(
          message,
          replyJid,
          "❌ No pending drafts to cancel.",
        );
      }
      if (pending.length > 1) {
        const ids = pending.map((d) => `\`${d.id}\``).join(", ");
        return await sendText(
          message,
          replyJid,
          `⚠️ Multiple pending drafts: ${ids}\nSpecify which: \`.cancel <draftId>\``,
        );
      }
      draft = pending[0];
    }

    store.markCancelled(draft.id);
    await sendText(message, replyJid, `🗑️ Draft \`${draft.id}\` cancelled.`);
  },
);

// ── .drafts ────────────────────────────────────────────────────────────────

bot(
  {
    pattern: "drafts ?(.*)",
    desc: "List pending drafts for this chat",
    type: "AI",
  },
  async (message) => {
    const jid = message.isGroup ? message.participant : message.jid;
    const replyJid = jid || message.jid;
    const pending = store.pendingForChat(jid);

    if (pending.length === 0) {
      return await sendText(message, replyJid, "📭 No pending drafts.");
    }

    const lines = [`*${pending.length} pending draft(s):*\n`];
    for (const d of pending) {
      lines.push(fmtDraft(d));
      lines.push("─────────────────");
    }
    await sendText(message, replyJid, lines.join("\n"));
  },
);
