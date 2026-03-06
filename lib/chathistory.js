/**
 * Lightweight in-memory chat history buffer for context-aware auto-replies.
 *
 * Stores recent messages (incoming + outgoing) per chat to feed as context
 * when generating AI replies.
 */

const MAX_MESSAGES_PER_CHAT = 20
const HISTORY_TTL_MS = 30 * 60 * 1000 // 30 minutes
const VERBATIM_TURNS = 6       // always keep this many recent messages as-is
const CONTEXT_CHAR_LIMIT = 3000 // ~750 tokens — trigger summarization above this

const chatHistories = new Map() // jid -> { messages: [...], lastAccessAt, summary? }

/**
 * Message record shape:
 *   timestamp – Date
 *   fromMe    – boolean
 *   text      – string
 */

function purgeExpired() {
  const now = Date.now()
  for (const [jid, hist] of chatHistories) {
    if (now - hist.lastAccessAt > HISTORY_TTL_MS) {
      chatHistories.delete(jid)
    }
  }
}

/**
 * Add a message to the chat history for this jid.
 */
function addMessage(jid, { fromMe, text }) {
  purgeExpired()
  if (!jid || !text) return

  let hist = chatHistories.get(jid)
  if (!hist) {
    hist = { messages: [], lastAccessAt: Date.now() }
    chatHistories.set(jid, hist)
  }

  hist.messages.push({
    timestamp: new Date(),
    fromMe: !!fromMe,
    text: String(text).trim(),
  })

  // Keep only last MAX_MESSAGES_PER_CHAT; if we drop messages, cached summary is stale
  if (hist.messages.length > MAX_MESSAGES_PER_CHAT) {
    hist.messages = hist.messages.slice(-MAX_MESSAGES_PER_CHAT)
    hist.summary = null
  }

  hist.lastAccessAt = Date.now()
}

/**
 * Get recent messages for this chat (oldest first).
 * Returns array of { fromMe, text, timestamp }.
 */
function getHistory(jid) {
  purgeExpired()
  const hist = chatHistories.get(jid)
  if (!hist || !hist.messages.length) return []
  hist.lastAccessAt = Date.now()
  return hist.messages.slice()
}

function msgLine(msg) {
  return `${msg.fromMe ? '[You]' : '[Them]'}: ${msg.text}`
}

/**
 * Format chat history as a readable conversation thread for AI context.
 * If the full history is too long, uses a cached summary for older turns
 * and keeps the last VERBATIM_TURNS messages verbatim.
 * Falls back to verbatim-only (with a note) if no summary is cached yet.
 */
function formatHistoryForContext(jid) {
  const history = getHistory(jid)
  if (!history.length) return ''

  const full = history.map(msgLine).join('\n')
  if (full.length <= CONTEXT_CHAR_LIMIT) return full

  // Too long — use last VERBATIM_TURNS verbatim + summary of older turns
  const recent = history.slice(-VERBATIM_TURNS).map(msgLine).join('\n')
  const hist = chatHistories.get(jid)
  if (hist?.summary) {
    return `[Earlier context]: ${hist.summary}\n\n${recent}`
  }
  // Summary not yet generated — return verbatim recent with a note
  const omitted = history.length - VERBATIM_TURNS
  return `[${omitted} earlier message(s) omitted — summary pending]\n\n${recent}`
}

/**
 * Returns true if the history is long enough to need summarization
 * and no cached summary exists yet.
 */
function needsSummarization(jid) {
  const hist = chatHistories.get(jid)
  if (!hist || hist.messages.length <= VERBATIM_TURNS) return false
  if (hist.summary) return false
  const full = hist.messages.map(msgLine).join('\n')
  return full.length > CONTEXT_CHAR_LIMIT
}

/**
 * Returns older messages (before the last VERBATIM_TURNS) as a plain string
 * suitable for summarization.
 */
function getOlderMessagesText(jid) {
  const hist = chatHistories.get(jid)
  if (!hist) return ''
  const older = hist.messages.slice(0, -VERBATIM_TURNS)
  return older.map(msgLine).join('\n')
}

/**
 * Store a generated summary for older turns.
 */
function setHistorySummary(jid, summary) {
  const hist = chatHistories.get(jid)
  if (!hist) return
  hist.summary = String(summary || '').trim()
}

module.exports = {
  addMessage,
  getHistory,
  formatHistoryForContext,
  needsSummarization,
  getOlderMessagesText,
  setHistorySummary,
}
