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

const axios = require("axios");
const FormData = require("form-data");
const { bot } = require("../lib");
const { generateDraftReplies, withRetry, throttledStderr, summarizeContext } = require("../lib/draftstyle");
const store = require("../lib/draftstore");
const { jidToNum } = require("../lib");
const chatHistory = require("../lib/chathistory");
const { extractDateOptions } = require("../lib/dateOptions");
const { isFreeOnDays } = require("../lib/googleCalendar");

// Close Contacts List — the bot will NOT auto-reply to these numbers.
// Add phone numbers (digits only, with country code) for contacts you want to reply to personally.
const CLOSE_CONTACTS_LIST = [
  "14155098648",
  "85261701066",
  "85267473751",
  "85291266039",
  "447913950794",
  "07913950794",
  "07475073883",
  "85261924337",
];
const autoReplyLastSentAt = new Map(); // jid -> timestamp (kept for future use)

// ── helpers ──────────────────────────────────────────────────────────────────

/** Wait a random delay between minMs and maxMs milliseconds. */
function randomDelay(minMs = 30000, maxMs = 60000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(`[auto-reply] waiting ${Math.round(ms / 1000)}s before replying…`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function getCloseContactsList(ctx) {
  const envRaw = (
    ctx?.CLOSE_CONTACTS_LIST ||
    process.env.CLOSE_CONTACTS_LIST ||
    ""
  )
    .split(",")
    .map((x) => normalizePhone(x))
    .filter(Boolean);
  return envRaw.length ? envRaw : CLOSE_CONTACTS_LIST;
}

function shouldAutoReplyToContact(message, ctx) {
  if (!message || message.isGroup) return false;
  const enabled = truthy(
    ctx?.AUTO_DRAFT_ENABLED || process.env.AUTO_DRAFT_ENABLED || "true",
  );
  if (!enabled) return false;

  const contactNum = normalizePhone(jidToNum(message.jid));
  const closeContacts = getCloseContactsList(ctx);
  const isCloseContact = closeContacts.includes(contactNum);
  console.log(`[auto-reply] close contacts check: jid=${message.jid} contactNum="${contactNum}" isCloseContact=${isCloseContact}`);
  return !isCloseContact;
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

function isOtpMessage(text) {
  const t = String(text || "").toLowerCase();
  const keywords = [
    /verification\s*code/,
    /security\s*code/,
    /confirmation\s*code/,
    /authentication\s*code/,
    /\botp\b/,
    /one[- ]time\s*password/,
    /never\s*share/,
    /do\s*not\s*share/,
    /\bcode\s*is\s*[:\-]?\s*[a-z0-9]{4,8}\b/,
    /\bcode\s*:\s*[a-z0-9]{4,8}\b/,
    /\buse\s+code\s*[a-z0-9]{4,8}\b/
  ];
  for (const regex of keywords) {
    if (regex.test(t)) return true;
  }
  return false;
}

// Map phone country code prefixes → IANA timezone.
// Longer prefixes are matched first so e.g. 852 wins over 85.
const COUNTRY_CODE_TZ = [
  // Asia
  ["852", "Asia/Hong_Kong"],
  ["853", "Asia/Macau"],
  ["886", "Asia/Taipei"],
  ["855", "Asia/Phnom_Penh"],
  ["856", "Asia/Vientiane"],
  ["880", "Asia/Dhaka"],
  ["960", "Indian/Maldives"],
  ["86", "Asia/Shanghai"],
  ["81", "Asia/Tokyo"],
  ["82", "Asia/Seoul"],
  ["65", "Asia/Singapore"],
  ["60", "Asia/Kuala_Lumpur"],
  ["66", "Asia/Bangkok"],
  ["84", "Asia/Ho_Chi_Minh"],
  ["62", "Asia/Jakarta"],
  ["63", "Asia/Manila"],
  ["91", "Asia/Kolkata"],
  ["92", "Asia/Karachi"],
  ["94", "Asia/Colombo"],
  ["971", "Asia/Dubai"],
  ["972", "Asia/Jerusalem"],
  ["966", "Asia/Riyadh"],
  ["90", "Europe/Istanbul"],
  // Oceania
  ["61", "Australia/Sydney"],
  ["64", "Pacific/Auckland"],
  // Europe
  ["44", "Europe/London"],
  ["33", "Europe/Paris"],
  ["49", "Europe/Berlin"],
  ["34", "Europe/Madrid"],
  ["39", "Europe/Rome"],
  ["31", "Europe/Amsterdam"],
  ["41", "Europe/Zurich"],
  ["46", "Europe/Stockholm"],
  ["47", "Europe/Oslo"],
  ["45", "Europe/Copenhagen"],
  ["32", "Europe/Brussels"],
  ["48", "Europe/Warsaw"],
  ["43", "Europe/Vienna"],
  ["351", "Europe/Lisbon"],
  ["7", "Europe/Moscow"],
  // Americas
  ["1", "America/New_York"],
  ["55", "America/Sao_Paulo"],
  ["52", "America/Mexico_City"],
  ["54", "America/Argentina/Buenos_Aires"],
  ["56", "America/Santiago"],
  ["57", "America/Bogota"],
  // Africa
  ["27", "Africa/Johannesburg"],
  ["20", "Africa/Cairo"],
  ["234", "Africa/Lagos"],
  ["254", "Africa/Nairobi"],
]

// Sort longest prefix first to avoid false matches (e.g. 852 matched before 85)
const SORTED_COUNTRY_CODE_TZ = [...COUNTRY_CODE_TZ].sort((a, b) => b[0].length - a[0].length)

/**
 * Given a WhatsApp JID like "85261924337@s.whatsapp.net",
 * extract the phone number and infer IANA timezone from its country code.
 * Returns null if unknown.
 */
function timezoneFromJid(jid) {
  const num = String(jid || "").split("@")[0].replace(/\D/g, "")
  if (!num) return null
  for (const [prefix, tz] of SORTED_COUNTRY_CODE_TZ) {
    if (num.startsWith(prefix)) return tz
  }
  return null
}

async function tryCalendarPick(messageText, ctx, senderJid = null) {
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
  // Infer timezone from sender's phone country code, fall back to config/env
  const inferredTz = senderJid ? timezoneFromJid(senderJid) : null;
  const timeZone = (
    inferredTz ||
    ctx?.GOOGLE_TIMEZONE ||
    process.env.GOOGLE_TIMEZONE ||
    "Asia/Hong_Kong"
  ).trim();
  if (inferredTz) {
    console.log(`[auto-reply] inferred timezone from sender (${senderJid}): ${inferredTz}`);
  }

  const dayStrs = parsed.days.map((d) => d.toISOString().slice(0, 10));
  const hasTimes = parsed.times && parsed.times.length > 0;
  if (hasTimes) {
    console.log(`[auto-reply] checking Google Calendar for days: ${dayStrs.join(", ")} at times: ${parsed.times.map(t => `${t.hours}:${String(t.mins).padStart(2, '0')}`).join(', ')} (tz=${timeZone})`);
  } else {
    console.log(`[auto-reply] checking Google Calendar for days: ${dayStrs.join(", ")} (calendarId=${calendarId}, tz=${timeZone})`);
  }

  let availability;
  try {
    availability = await isFreeOnDays({
      days: parsed.days,
      times: parsed.times,
      calendarId,
      timeZone,
    });
    const results = dayStrs.map((d) => `${d}=${availability.get(d)}`).join(", ");
    console.log(`[auto-reply] calendar availability: ${results}`);
  } catch (_e) {
    process.stderr.write(`[auto-reply] calendar API error: ${_e?.message || _e}\n`);
    return null;
  }

  const freeDays = parsed.days.filter(
    (d) => availability.get(d.toISOString().slice(0, 10)) === true,
  );
  const busyDays = parsed.days.filter(
    (d) => availability.get(d.toISOString().slice(0, 10)) === false,
  );

  if (freeDays.length === 0) {
    const opts = parsed.days.map(formatDay).join(" or ");
    if (hasTimes && parsed.times.length === 1) {
      const t = parsed.times[0];
      const suffix = t.hours < 12 ? 'am' : 'pm';
      const displayH = t.hours > 12 ? t.hours - 12 : t.hours || 12;
      const displayTime = `${displayH}${t.mins > 0 ? ':' + String(t.mins).padStart(2, '0') : ''}${suffix}`;
      return `Hmm I think I'm busy at ${displayTime} on ${opts} 😣 could you suggest a different time or date? 🙏🏻`;
    }
    return `Hmm I think I'm booked on ${opts} 😣 could you suggest a couple other dates? 🙏🏻`;
  }

  // pick first free day (usually earlier)
  freeDays.sort((a, b) => a.getTime() - b.getTime());
  const pick = freeDays[0];
  const pickStr = formatDay(pick);

  // Build time string if a specific time was requested
  let timeStr = '';
  if (hasTimes && parsed.times.length === 1) {
    const t = parsed.times[0];
    const suffix = t.hours < 12 ? 'am' : 'pm';
    const displayH = t.hours > 12 ? t.hours - 12 : (t.hours === 0 ? 12 : t.hours);
    timeStr = ` at ${displayH}${t.mins > 0 ? ':' + String(t.mins).padStart(2, '0') : ''}${suffix}`;
  }

  // If there were multiple options, acknowledge choice
  if (parsed.days.length >= 2) {
    return `${pickStr}${timeStr} works for me 😊`;
  }
  return `That${timeStr ? ' time' : ''} works for me 😊`;
}

async function safeHistory(key) {
  try {
    if (chatHistory.needsSummarization(key)) {
      const older = chatHistory.getOlderMessagesText(key)
      const summary = await summarizeContext(older)
      if (summary) chatHistory.setHistorySummary(key, summary)
    }
    const h = chatHistory.formatHistoryForContext(key)
    return typeof h === 'string' ? h : ''
  } catch {
    return ''
  }
}

function apiErrorMessage(err) {
  const status = err?.response?.status
  if (status === 401) return "looks like there's an issue with my AI setup — I'll fix it and reply soon!"
  if (status === 429) return "getting a lot of messages right now — give me a moment and I'll get back to you!"
  return "sorry, give me a sec — I'll get back to you! 😅"
}

async function transcribeAudio(buffer) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  const form = new FormData()
  form.append('file', buffer, { filename: 'voice.ogg', contentType: 'audio/ogg' })
  form.append('model', 'whisper-1')
  const { data } = await withRetry(() => axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    { headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() }, timeout: 60000 }
  ), { label: 'transcribeAudio' })
  return (data?.text || '').trim()
}

async function describeImage(buffer, mimetype) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  const model = (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini'
  const base64 = Buffer.from(buffer).toString('base64')
  const { data } = await withRetry(() => axios.post(
    'https://api.openai.com/v1/responses',
    {
      model,
      input: [{
        role: 'user', content: [
          { type: 'input_text', text: 'Briefly describe what is in this image in 1-2 sentences.' },
          { type: 'input_image', image_url: `data:${mimetype};base64,${base64}` },
        ]
      }],
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  ), { label: 'describeImage' })
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  const chunks = []
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('\n').trim() || '[image]'
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
        await safeHistory(sourceJid);
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
console.log("[auto-reply] draft.js loaded — registering autoDraftReply handler");
// Debug: log ALL text messages regardless of fromMe, to check what value the framework passes
bot(
  { on: "text", fromMe: true, type: "autoDraftReplyDebug" },
  async (message) => {
    console.log(`[auto-reply-debug fromMe:true] jid=${message.jid} fromMe=${message.fromMe} text="${message.text?.trim()}"`);
  },
);
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

    // ignore OTP messages
    if (isOtpMessage(message.text.trim())) {
      console.log(`[auto-reply] skipped: message looks like an OTP (jid=${message.jid})`);
      return;
    }

    const key = message.jid;
    // Capture incoming message in history immediately (before queueing)
    chatHistory.addMessage(key, { fromMe: false, text: message.text.trim() });

    // Queue AI generation — messages are processed in order, never dropped mid-conversation
    store.enqueue(key, async () => {
      await randomDelay();
      const now = Date.now();
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
        const calendarReply = await tryCalendarPick(message.text, ctx, message.jid);
        if (calendarReply) {
          console.log(`[auto-reply] calendar reply selected: "${calendarReply}"`);
          await message.send(calendarReply, { quoted: message.data });
          chatHistory.addMessage(key, { fromMe: true, text: calendarReply });
          autoReplyLastSentAt.set(key, now);
          return;
        }

        const conversationHistory = await safeHistory(key);
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
        throttledStderr(`auto-reply:${_e?.response?.status || 'err'}`, `[auto-reply] error for ${message.jid}: ${_e?.message || _e}\n`)
        console.log(`[auto-reply] sending fallback message to ${message.jid}`)
        try { await message.send(apiErrorMessage(_e)) } catch (sendErr) {
          process.stderr.write(`[auto-reply] fallback send failed: ${sendErr?.message || sendErr}\n`)
        }
      }
    }).catch(err => {
      process.stderr.write(`[auto-reply] queue error for ${message.jid}: ${err?.message || err}\n`)
    })
  },
);

// ── auto-reply: voice notes ──────────────────────────────────────────────────
bot(
  { on: 'audio', fromMe: false, type: 'autoDraftReplyAudio' },
  async (message, _match, ctx) => {
    console.log(`[auto-reply-audio] handler triggered for jid=${message.jid} mimetype=${message.mimetype}`)
    if (!shouldAutoReplyToContact(message, ctx)) {
      console.log(`[auto-reply-audio] skipped: not an allowlisted contact (jid=${message.jid})`)
      return
    }

    const key = message.jid
    store.enqueue(key, async () => {
      await randomDelay();
      const now = Date.now()
      try {
        console.log(`[auto-reply-audio] downloading voice note from ${message.jid}`)
        const buf = await message.downloadMediaMessage()
        if (!buf) {
          console.log(`[auto-reply-audio] download returned empty buffer for ${message.jid}`)
          return
        }
        console.log(`[auto-reply-audio] transcribing ${buf.length} bytes from ${message.jid}`)
        const transcript = await transcribeAudio(buf)
        console.log(`[auto-reply-audio] transcript from ${message.jid}: "${transcript}"`)
        if (!transcript) {
          console.log(`[auto-reply-audio] empty transcript, skipping reply`)
          return
        }
        chatHistory.addMessage(key, { fromMe: false, text: `[voice note]: ${transcript}` })

        // in-town override
        if (isInTownQuestion(transcript)) {
          const first = firstNameFromMessage(message)
          const prefix = first ? `Hi ${first}, ` : 'Hi, '
          const canned = prefix + "I'm not in town yet. Will definitely let you guys know when I've booked the ticket! 🙏🏻😊 Thank you so much."
          await message.send(canned, { quoted: message.data })
          chatHistory.addMessage(key, { fromMe: true, text: canned })
          autoReplyLastSentAt.set(key, now)
          return
        }

        // calendar check
        const calendarReply = await tryCalendarPick(transcript, ctx, message.jid)
        if (calendarReply) {
          console.log(`[auto-reply-audio] calendar reply: "${calendarReply}"`)
          await message.send(calendarReply, { quoted: message.data })
          chatHistory.addMessage(key, { fromMe: true, text: calendarReply })
          autoReplyLastSentAt.set(key, now)
          return
        }

        const conversationHistory = await safeHistory(key)
        const options = await generateDraftReplies(transcript, '', conversationHistory)
        const reply = String(options?.[0] || '').trim()
        if (!reply) {
          console.log(`[auto-reply-audio] generateDraftReplies returned empty reply`)
          return
        }
        console.log(`[auto-reply-audio] sending reply to ${message.jid}: "${reply}"`)
        await message.send(reply, { quoted: message.data })
        chatHistory.addMessage(key, { fromMe: true, text: reply })
        autoReplyLastSentAt.set(key, now)
      } catch (_e) {
        throttledStderr(`auto-reply-audio:${_e?.response?.status || 'err'}`, `[auto-reply-audio] error for ${message.jid}: ${_e?.message || _e}\n`)
        console.log(`[auto-reply-audio] sending fallback message to ${message.jid}`)
        try { await message.send(apiErrorMessage(_e)) } catch (sendErr) {
          process.stderr.write(`[auto-reply-audio] fallback send failed: ${sendErr?.message || sendErr}\n`)
        }
      }
    }).catch(err => {
      process.stderr.write(`[auto-reply-audio] queue error for ${message.jid}: ${err?.message || err}\n`)
    })
  },
)

// ── auto-reply: images ───────────────────────────────────────────────────────
bot(
  { on: 'image', fromMe: false, type: 'autoDraftReplyImage' },
  async (message, _match, ctx) => {
    console.log(`[auto-reply-image] handler triggered for jid=${message.jid} mimetype=${message.mimetype}`)
    if (!shouldAutoReplyToContact(message, ctx)) {
      console.log(`[auto-reply-image] skipped: not an allowlisted contact (jid=${message.jid})`)
      return
    }

    const key = message.jid
    store.enqueue(key, async () => {
      await randomDelay();
      const now = Date.now()
      try {
        console.log(`[auto-reply-image] downloading image from ${message.jid}`)
        const buf = await message.downloadMediaMessage()
        if (!buf) {
          console.log(`[auto-reply-image] download returned empty buffer for ${message.jid}`)
          return
        }
        const mimetype = (message.mimetype || 'image/jpeg').split(';')[0].trim()
        console.log(`[auto-reply-image] describing ${buf.length} bytes (${mimetype}) from ${message.jid}`)
        const description = await describeImage(buf, mimetype)
        console.log(`[auto-reply-image] description from ${message.jid}: "${description}"`)
        const caption = message.text?.trim() || ''
        const incomingText = caption
          ? `[sent an image: ${description}] "${caption}"`
          : `[sent an image: ${description}]`
        chatHistory.addMessage(key, { fromMe: false, text: incomingText })
        const conversationHistory = await safeHistory(key)
        const options = await generateDraftReplies(incomingText, '', conversationHistory)
        const reply = String(options?.[0] || '').trim()
        if (!reply) {
          console.log(`[auto-reply-image] generateDraftReplies returned empty reply`)
          return
        }
        console.log(`[auto-reply-image] sending reply to ${message.jid}: "${reply}"`)
        await message.send(reply, { quoted: message.data })
        chatHistory.addMessage(key, { fromMe: true, text: reply })
        autoReplyLastSentAt.set(key, now)
      } catch (_e) {
        throttledStderr(`auto-reply-image:${_e?.response?.status || 'err'}`, `[auto-reply-image] error for ${message.jid}: ${_e?.message || _e}\n`)
        console.log(`[auto-reply-image] sending fallback message to ${message.jid}`)
        try { await message.send(apiErrorMessage(_e)) } catch (sendErr) {
          process.stderr.write(`[auto-reply-image] fallback send failed: ${sendErr?.message || sendErr}\n`)
        }
      }
    }).catch(err => {
      process.stderr.write(`[auto-reply-image] queue error for ${message.jid}: ${err?.message || err}\n`)
    })
  },
)

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
