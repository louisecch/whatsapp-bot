/**
 * Builds the style-profile prompt and calls OpenAI to generate draft replies.
 *
 * env vars consumed:
 *   OPENAI_API_KEY  – required
 *   OPENAI_MODEL    – optional, defaults to gpt-4o-mini
 *   DRAFT_PERSONA   – optional, free-text description of your personality
 *   DRAFT_EXAMPLES  – optional, JSON array of {from, reply} pairs
 *   DRAFT_PROFILE_PATH – optional, path to JSON profile (preferred for big datasets)
 *                     e.g. '[{"from":"when you free?","reply":"tmrw la prob"},{"from":"lol really","reply":"ya man 😂"}]'
 *
 * Each call returns an array with exactly 1 candidate reply.
 */

const axios = require('axios')
const path = require('path')
const { existsSync, readFileSync } = require('fs')

// Throttle duplicate stderr messages — same key is suppressed within cooldownMs
const _loggedAt = new Map()
function throttledStderr(key, msg, cooldownMs = 60000) {
  const now = Date.now()
  if (_loggedAt.has(key) && now - _loggedAt.get(key) < cooldownMs) return
  _loggedAt.set(key, now)
  process.stderr.write(msg)
}

/**
 * Retry helper with exponential backoff.
 * - 401/403: throw immediately (bad key — retrying won't help)
 * - 429: honor Retry-After header, then retry
 * - other: exponential backoff up to maxAttempts
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 800, label = 'withRetry' } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = err?.response?.status
      // Auth errors — no point retrying
      if (status === 401 || status === 403) throw err
      if (attempt >= maxAttempts) {
        throttledStderr(`fail:${label}:${status}`, `[${label}] all ${maxAttempts} attempts failed (HTTP ${status}): ${err?.message}\n`)
        break
      }
      let delay
      if (status === 429) {
        const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '0', 10)
        delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * Math.pow(2, attempt - 1)
        throttledStderr(`429:${label}`, `[${label}] rate limited (429); retrying in ${Math.round(delay / 1000)}s\n`, 30000)
      } else {
        delay = baseDelayMs * Math.pow(2, attempt - 1)
        process.stderr.write(`[${label}] attempt ${attempt}/${maxAttempts} failed (${err?.message}); retrying in ${delay}ms\n`)
      }
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

try {
  const configEnvPath = path.join(__dirname, '../config.env')
  const dotEnvPath = path.join(__dirname, '../.env')
  const envPath = existsSync(configEnvPath)
    ? configEnvPath
    : existsSync(dotEnvPath)
      ? dotEnvPath
      : null
  if (envPath) require('dotenv').config({ path: envPath })
} catch {}

const DEFAULT_PERSONA = `
You are mimicking the texting style of a real person.
Key traits to replicate:
- Mirror the register of the incoming message: casual chat gets casual replies (lowercase, abbreviations like "ya", "la", "lol", short phrases); professional or business enquiries get professional, well-structured replies with proper grammar and formatting
- Match reply length to the message: short casual messages get short replies (1–2 sentences or a phrase); detailed messages with multiple questions deserve a fuller answer that addresses each point
- React authentically — jokes, sarcasm, and humour are welcome in casual contexts
- Do NOT add disclaimers, apologies, or robotic filler phrases
`.trim()

function loadProfile() {
  const envPath = (process.env.DRAFT_PROFILE_PATH || '').trim()
  const defaultPath = path.join(__dirname, '../style/profile.json')
  const p = envPath || defaultPath

  try {
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function loadExamples() {
  // env overrides profile
  const raw = (process.env.DRAFT_EXAMPLES || '').trim()
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(0, 20) // cap at 20 examples to save tokens
  } catch {
    return []
  }
}

function buildSystemPrompt() {
  const profile = loadProfile()
  const persona =
    (process.env.DRAFT_PERSONA || '').trim() ||
    (typeof profile?.persona === 'string' ? profile.persona.trim() : '') ||
    DEFAULT_PERSONA

  let examples = loadExamples()
  if (examples.length === 0 && Array.isArray(profile?.examples)) {
    examples = profile.examples
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ from: String(e.from || ''), reply: String(e.reply || '') }))
      .filter((e) => e.from.trim() && e.reply.trim())
      .slice(0, 40) // keep prompt light
  }

  let sys = persona + '\n\n'

  if (examples.length > 0) {
    sys += 'Here are examples of how this person actually writes:\n'
    for (const ex of examples) {
      sys += `Incoming: "${ex.from}"\nReply: "${ex.reply}"\n`
    }
    sys += '\n'
  }

  sys += `When given an incoming message, produce exactly 1 best reply option.
Return ONLY a plain JSON string (no object, no array, no keys, no markdown).
The entire output must be a single JSON-encoded string value.
Do NOT use markdown: no **bold**, no numbered lists, no bullet points, no headers.
Write in natural flowing prose, even for detailed answers — use line breaks sparingly and only where they feel natural in a real conversation.
Correct: "sure la"
Correct: "hi! thanks for reaching out. for a restaurant site like that i'd typically use wordpress so you can update things yourself. cost-wise usually somewhere between £800-1500, and takes about 2-3 weeks. happy to jump on a call if you want to go through the details?"
Wrong: {"message":"..."} — do NOT wrap in an object.
Wrong: "1. **Cost**: ..." — do NOT use numbered lists or bold.`

  return sys
}

/**
 * @param {string} incomingText – the message you received
 * @param {string} [extraContext] – optional extra context (e.g. "in a group chat")
 * @param {string} [conversationHistory] – optional full conversation thread for context
 * @returns {Promise<string[]>} array of exactly 1 reply string
 */
async function generateDraftReplies(incomingText, extraContext = '', conversationHistory = '') {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const primaryModel = (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini'
  const fallbackModel = (process.env.OPENAI_FALLBACK_MODEL || '').trim() || 'gpt-3.5-turbo'

  let userContent = ''
  if (conversationHistory) {
    userContent += `Recent conversation:\n${conversationHistory}\n\n`
  }
  if (extraContext) {
    userContent += `${extraContext}\n\n`
  }
  userContent += `Incoming message: "${incomingText}"`

  const callModel = (model) => withRetry(() => axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userContent },
      ],
      temperature: 0.9,
      max_tokens: 1000,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  ))

  let response
  try {
    response = await callModel(primaryModel)
  } catch (primaryErr) {
    if (fallbackModel && fallbackModel !== primaryModel) {
      process.stderr.write(`[draftstyle] ${primaryModel} failed (${primaryErr?.message}); trying fallback ${fallbackModel}\n`)
      response = await callModel(fallbackModel)
    } else {
      throw primaryErr
    }
  }

  const { data } = response

  const raw = data?.choices?.[0]?.message?.content?.trim() || ''

  // Parse JSON, with graceful fallback
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()]
    if (Array.isArray(parsed) && parsed.length >= 1) {
      const first = String(parsed[0] || '').trim()
      return [first || '...']
    }
    if (parsed && typeof parsed === 'object') {
      // e.g. {"message":"..."} or {"reply":"..."} — grab the first string value
      const val = Object.values(parsed).find(v => typeof v === 'string' && v.trim())
      if (val) return [val.trim()]
    }
  } catch {}

  // Fallback: treat raw response as a single option
  const single = (raw || '...').trim()
  return [single]
}

module.exports = { generateDraftReplies, withRetry, throttledStderr }
