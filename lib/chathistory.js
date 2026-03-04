/**
 * Lightweight in-memory chat history buffer for context-aware auto-replies.
 *
 * Stores recent messages (incoming + outgoing) per chat to feed as context
 * when generating AI replies.
 */

const MAX_MESSAGES_PER_CHAT = 20
const HISTORY_TTL_MS = 30 * 60 * 1000 // 30 minutes

const chatHistories = new Map() // jid -> { messages: [...], lastAccessAt: timestamp }

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

  // Keep only last MAX_MESSAGES_PER_CHAT
  if (hist.messages.length > MAX_MESSAGES_PER_CHAT) {
    hist.messages = hist.messages.slice(-MAX_MESSAGES_PER_CHAT)
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

/**
 * Format chat history as a readable conversation thread for AI context.
 * Returns a string like:
 *   [Them]: hey, are you free tmr?
 *   [You]: ya should be
 *   [Them]: cool let's meet
 */
function formatHistoryForContext(jid) {
  const history = getHistory(jid)
  if (!history.length) return ''

  return history
    .map((msg) => {
      const label = msg.fromMe ? '[You]' : '[Them]'
      return `${label}: ${msg.text}`
    })
    .join('\n')
}

module.exports = {
  addMessage,
  getHistory,
  formatHistoryForContext,
}
