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
const GLOBAL_MAX_CONCURRENT = 3     // max simultaneous AI calls across all chats
const CHAT_QUEUE_MAX = 3            // max pending tasks per chat (drop if exceeded)

const drafts = new Map() // id → draft record
const chatQueue = new Map() // jid → boolean (used by .draft command)

// ── per-chat queue + global semaphore ──────────────────────────────────────

let _globalActive = 0
const _globalWaiters = [] // resolve fns waiting for a global slot

function _acquireGlobal() {
  if (_globalActive < GLOBAL_MAX_CONCURRENT) {
    _globalActive++
    return Promise.resolve()
  }
  return new Promise(r => _globalWaiters.push(r))
}

function _releaseGlobal() {
  if (_globalWaiters.length > 0) {
    _globalWaiters.shift()() // pass slot directly to next waiter
  } else {
    _globalActive--
  }
}

const _chatSlots = new Map() // jid → { active: bool, queue: [{fn,resolve,reject}] }

function _drainChat(jid) {
  const slot = _chatSlots.get(jid)
  if (!slot || slot.active || slot.queue.length === 0) {
    if (slot && !slot.active && slot.queue.length === 0) _chatSlots.delete(jid)
    return
  }
  slot.active = true
  const { fn, resolve, reject } = slot.queue.shift()
  _acquireGlobal().then(async () => {
    try {
      resolve(await fn())
    } catch (err) {
      reject(err)
    } finally {
      _releaseGlobal()
      slot.active = false
      _drainChat(jid)
    }
  })
}

/**
 * Enqueue an async task for a specific chat.
 * Tasks run one-at-a-time per chat, at most GLOBAL_MAX_CONCURRENT across all chats.
 * If the per-chat queue is full (CHAT_QUEUE_MAX), the task is dropped and null returned.
 */
function enqueue(jid, fn) {
  let slot = _chatSlots.get(jid)
  if (!slot) {
    slot = { active: false, queue: [] }
    _chatSlots.set(jid, slot)
  }
  if (slot.queue.length >= CHAT_QUEUE_MAX) {
    process.stderr.write(`[queue] per-chat queue full for ${jid}, dropping task\n`)
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    slot.queue.push({ fn, resolve, reject })
    _drainChat(jid)
  })
}

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
 * Returns true if a generation is running or queued for this chat.
 * Checks both the .draft command boolean lock and the auto-reply queue.
 */
function isGenerating(jid) {
  if (chatQueue.get(jid) === true) return true
  const slot = _chatSlots.get(jid)
  return !!(slot?.active || slot?.queue.length > 0)
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
  enqueue,
  saveDraft,
  getDraft,
  markSent,
  markCancelled,
  pendingForChat,
}
