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
- Write in a casual, conversational tone (lowercase unless emphasising)
- Keep replies short (1–2 sentences max, often just a phrase or word)
- Use abbreviations and informal language naturally (e.g. "ya", "la", "lol", "tbh", "ngl")
- No formal punctuation at end of sentences unless for emphasis
- React authentically — jokes, sarcasm, and humour are welcome
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
Return ONLY a JSON string — no commentary, no keys, no markdown.
Example output format: "sure la"`

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

  const model = (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini'

  let userContent = ''
  if (conversationHistory) {
    userContent += `Recent conversation:\n${conversationHistory}\n\n`
  }
  if (extraContext) {
    userContent += `${extraContext}\n\n`
  }
  userContent += `Incoming message: "${incomingText}"`

  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userContent },
      ],
      temperature: 0.9,
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  )

  const raw = data?.choices?.[0]?.message?.content?.trim() || ''

  // Parse JSON, with graceful fallback
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()]
    if (Array.isArray(parsed) && parsed.length >= 1) {
      const first = String(parsed[0] || '').trim()
      return [first || '...']
    }
  } catch {}

  // Fallback: treat raw response as a single option
  const single = (raw || '...').trim()
  return [single]
}

module.exports = { generateDraftReplies }
