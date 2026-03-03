/**
 * In-memory draft store with TTL expiry + per-chat concurrency queue.
 *
 * A "draft" record:
 *   id          – short random ID shown to the user (e.g. "d3f7")
 *   jid         – owner chat JID the draft is stored under (usually your DM)
 *   sessionId   – bot session (message.id)
 *   sourceJid   – where the draft request came from (group jid or dm jid)
 *   sourceIsGroup – boolean
 *   targetText  – text of the message being replied to
 *   options     – string[1] of candidate replies
 *   status      – "pending" | "sent" | "cancelled"
 *   createdAt   – Date
 *   expiresAt   – Date (now + TTL_MS)
 */

const DRAFT_TTL_MS = 15 * 60 * 1000 // 15 minutes

const drafts = new Map() // id → draft record
const chatQueue = new Map() // jid → boolean (generation in-flight?)

// ── helpers ────────────────────────────────────────────────────────────────

function makeId() {
  return Math.random().toString(36).slice(2, 6)
}

function purgeExpired() {
  const now = Date.now()
  for (const [id, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(id)
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Returns true if a generation is already running for this chat.
 */
function isGenerating(jid) {
  return chatQueue.get(jid) === true
}

/**
 * Mark a chat as "generating" (call before OpenAI request).
 */
function setGenerating(jid, val) {
  if (val) chatQueue.set(jid, true)
  else chatQueue.delete(jid)
}

/**
 * Save a new draft and return its record.
 */
function saveDraft({ jid, sessionId, sourceJid, sourceIsGroup, targetText, options }) {
  purgeExpired()
  const id = makeId()
  const now = Date.now()
  const draft = {
    id,
    jid,
    sessionId,
    sourceJid,
    sourceIsGroup: !!sourceIsGroup,
    targetText,
    options,
    status: 'pending',
    createdAt: new Date(now),
    expiresAt: new Date(now + DRAFT_TTL_MS),
  }
  drafts.set(id, draft)
  return draft
}

/**
 * Retrieve a draft by id. Returns null if not found or expired.
 */
function getDraft(id) {
  const draft = drafts.get(id)
  if (!draft) return null
  if (draft.expiresAt <= Date.now()) {
    drafts.delete(id)
    return null
  }
  return draft
}

/**
 * Mark draft as sent (idempotent — ignores if already sent).
 * Returns the draft or null if invalid/expired.
 */
function markSent(id) {
  const draft = getDraft(id)
  if (!draft) return null
  if (draft.status !== 'pending') return draft // already handled
  draft.status = 'sent'
  return draft
}

/**
 * Mark draft as cancelled.
 */
function markCancelled(id) {
  const draft = getDraft(id)
  if (!draft) return null
  draft.status = 'cancelled'
  return draft
}

/**
 * Return all pending drafts for a given jid (most recent first).
 */
function pendingForChat(jid) {
  purgeExpired()
  return [...drafts.values()]
    .filter((d) => d.jid === jid && d.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
}

module.exports = {
  isGenerating,
  setGenerating,
  saveDraft,
  getDraft,
  markSent,
  markCancelled,
  pendingForChat,
}
