#!/usr/bin/env node
/**
 * Build a WhatsApp style profile from exported chat .txt files.
 *
 * Input: directory containing WhatsApp "Export Chat" .txt files.
 * Output: JSON file with { persona, examples[] }.
 *
 * Examples are extracted as:
 *   input  = messages received (non-me), possibly multiple consecutive
 *   output = actual reply (me), possibly multiple consecutive
 *
 * Usage:
 *   node scripts/build-style-profile.js --input "/path/to/whatsapp-chats" --out "style/profile.json"
 *   node scripts/build-style-profile.js --input "/path/to/whatsapp-chats" --out "style/profile.json" --me "Lou"
 */

const fs = require('fs')
const path = require('path')

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1] ?? fallback
}

function intArg(name, fallback) {
  const v = arg(name, null)
  const n = v == null ? NaN : parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function stripBidi(s) {
  return String(s || '').replace(/^[\u200e\u200f\u202a-\u202e]+/, '')
}

function isLikelyHeaderLine(line) {
  // WhatsApp export lines typically start with [date, time]
  const l = stripBidi(line).trim()
  return l.startsWith('[') && l.includes('] ')
}

function parseExportFile(text) {
  const lines = text.split(/\r?\n/)
  const messages = []

  let current = null
  for (const rawLine of lines) {
    const line = stripBidi(rawLine)

    if (isLikelyHeaderLine(line)) {
      // flush
      if (current) messages.push(current)
      current = null

      const closeIdx = line.indexOf(']')
      if (closeIdx === -1) continue
      const tsRaw = line.slice(1, closeIdx).trim()
      const rest = line.slice(closeIdx + 1).trim()

      // system messages often do not have "Name: ..."
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) {
        continue
      }

      const sender = rest.slice(0, colonIdx).trim()
      const body = rest.slice(colonIdx + 1).trim().replace(/^[-\s]+/, '')
      if (!sender) continue

      current = { tsRaw, sender, text: body }
    } else if (current) {
      // continuation of previous message (multi-line)
      current.text += (current.text ? '\n' : '') + line
    }
  }

  if (current) messages.push(current)

  // cleanup: drop empty + encryption banner type lines
  return messages
    .map((m) => ({ ...m, text: (m.text || '').trim() }))
    .filter((m) => m.text.length > 0)
    .filter(
      (m) =>
        !m.text.includes('Messages and calls are end-to-end encrypted') &&
        !m.text.includes('Only people in this chat can read, listen to, or share them')
    )
}

function normaliseMediaPlaceholders(s) {
  let t = String(s || '').trim()
  // remove WhatsApp bidi marks that often prefix media placeholders
  t = t.replace(/[\u200e\u200f\u202a-\u202e]/g, '')
  // keep sticker behavior but make it consistent
  t = t.replace(/sticker omitted/gi, '[sticker]')
  t = t.replace(/image omitted/gi, '[image]')
  t = t.replace(/audio omitted/gi, '[audio]')
  t = t.replace(/video omitted/gi, '[video]')
  t = t.replace(/document omitted/gi, '[document]')
  t = t.replace(/gif omitted/gi, '[gif]')
  // compress multiple placeholder lines
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

function detectMeName(allMessages) {
  const counts = new Map()
  for (const m of allMessages) counts.set(m.sender, (counts.get(m.sender) || 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return top?.[0] || null
}

function extractPairs(messages, meName) {
  // Group consecutive messages by sender (turn-taking)
  const turns = []
  for (const m of messages) {
    const text = normaliseMediaPlaceholders(m.text)
    if (!text) continue
    const last = turns[turns.length - 1]
    if (last && last.sender === m.sender) {
      last.text += (last.text ? '\n' : '') + text
    } else {
      turns.push({ sender: m.sender, text })
    }
  }

  const examples = []
  for (let i = 0; i < turns.length - 1; i++) {
    const a = turns[i]
    const b = turns[i + 1]
    if (a.sender === meName) continue
    if (b.sender !== meName) continue

    const from = a.text
    const reply = b.text

    // Basic quality filters (avoid giant job posts / long form)
    if (from.length > 500) continue
    if (reply.length > 350) continue
    if (from.length < 1 || reply.length < 1) continue

    examples.push({ from, reply })
  }
  return examples
}

function scoreExample(ex) {
  const from = ex.from || ''
  const reply = ex.reply || ''

  const hasAlphaNum = /[A-Za-z0-9]/.test(reply)
  const hasEmoji = (() => {
    try {
      return /\p{Extended_Pictographic}/u.test(reply)
    } catch {
      return false
    }
  })()

  // Prefer replies that contain actual text (not only emoji)
  let score = 0
  if (hasAlphaNum) score += 5
  if (hasEmoji) score += 1

  // Prefer a natural chat reply length
  const len = reply.length
  if (len >= 6 && len <= 140) score += 4
  else if (len >= 3 && len <= 220) score += 2
  else if (len > 300) score -= 6

  // Penalize pairs where "from" is too long / looks like a job spec dump
  if (from.length > 350) score -= 4
  if (/casting schedule|usage\\s*:|shooting date\\s*:/i.test(from)) score -= 6

  // Keep some media reactions, but don't let them dominate
  if (!hasAlphaNum && /^\[sticker\]$/i.test(reply.trim())) score += 1
  if (!hasAlphaNum && reply.trim().length <= 4) score -= 3

  return score
}

function buildPersonaFromExamples(examples, extraStop = new Set()) {
  // Lightweight heuristic persona. You can override with DRAFT_PERSONA later.
  const sample = examples.slice(0, 200)
  const replyLens = sample.map((e) => e.reply.length)
  const avg = replyLens.reduce((a, b) => a + b, 0) / Math.max(1, replyLens.length)
  const shortish = avg < 80

  // common tokens
  const tokens = new Map()
  const addToken = (w) => tokens.set(w, (tokens.get(w) || 0) + 1)
  const stop = new Set([
    'sticker',
    'omitted',
    'image',
    'audio',
    'video',
    'document',
    'gif',
    'http',
    'https',
    'www',
    'com',
    'you',
    'your',
    'i',
    'im',
    "i'm",
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'for',
    'of',
    'in',
    'on',
    'is',
    'are',
    'it',
  ])
  for (const w of extraStop) stop.add(w)
  for (const e of sample) {
    const s = e.reply.toLowerCase()
    for (const w of s.split(/[^a-z0-9'’]+/).filter(Boolean)) {
      if (w.length <= 1) continue
      if (stop.has(w)) continue
      addToken(w)
    }
  }
  const common = [...tokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w)

  return [
    'You are mimicking the texting style of a real person based on their real WhatsApp replies.',
    shortish
      ? 'Keep replies short and natural (often 1–2 sentences).'
      : 'Keep replies natural and conversational.',
    'Match tone, emoji usage, and informal phrasing from the examples.',
    'If the best reply is a sticker-like reaction, you may output "[sticker]" (rarely).',
    common.length ? `Common phrasing to mirror when appropriate: ${common.join(', ')}` : null,
    'Do NOT add disclaimers, assistant-like phrases, or formal email tone.',
  ]
    .filter(Boolean)
    .join('\n')
}

function main() {
  const inputDir = arg('input')
  const outPath = arg('out', 'style/profile.json')
  const meArg = arg('me', null)
  const maxExamples = intArg('maxExamples', 400)

  if (!inputDir) {
    console.error('Missing --input "/path/to/whatsapp-chats"')
    process.exit(1)
  }

  const absIn = path.resolve(inputDir)
  const absOut = path.resolve(outPath)

  const files = fs
    .readdirSync(absIn)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .map((f) => path.join(absIn, f))

  if (files.length === 0) {
    console.error('No .txt files found in input dir:', absIn)
    process.exit(1)
  }

  const parsedByFile = []
  const all = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const msgs = parseExportFile(text)
    parsedByFile.push({ file: f, messages: msgs })
    all.push(...msgs)
  }

  const meName = meArg || detectMeName(all)
  if (!meName) {
    console.error('Could not detect your name. Use --me "YourNameInExport".')
    process.exit(1)
  }

  let examples = []
  for (const { file, messages } of parsedByFile) {
    const pairs = extractPairs(messages, meName).map((e) => ({ ...e, meta: { file: path.basename(file) } }))
    examples.push(...pairs)
  }

  // Deduplicate exact pairs
  const seen = new Set()
  examples = examples.filter((e) => {
    const k = `${e.from}\n→\n${e.reply}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Score + sort by usefulness (avoid emoji-only dominating)
  for (const e of examples) e._score = scoreExample(e)
  examples.sort((a, b) => (b._score || 0) - (a._score || 0))

  const trimmed = []
  let emojiOnlyCount = 0
  for (const e of examples) {
    const reply = String(e.reply || '').trim()
    const hasAlphaNum = /[A-Za-z0-9]/.test(reply)
    const isEmojiOnly = !hasAlphaNum && reply.length <= 6 && !/^\[sticker\]$/i.test(reply)
    if (isEmojiOnly) {
      if (emojiOnlyCount >= 25) continue
      emojiOnlyCount++
    }
    trimmed.push(e)
    if (trimmed.length >= maxExamples) break
  }
  examples = trimmed.map(({ _score, ...rest }) => rest)

  // Add participant name tokens to persona stopwords (removes \"ron\", \"gloria\", etc.)
  const extraStop = new Set()
  for (const m of all) {
    for (const part of String(m.sender || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      if (part.length <= 1) continue
      extraStop.add(part)
    }
  }

  const persona = buildPersonaFromExamples(examples, extraStop)

  const profile = {
    me: meName,
    generatedAt: new Date().toISOString(),
    sourceDir: absIn,
    stats: {
      files: files.length,
      examples: examples.length,
    },
    persona,
    examples: examples.map(({ from, reply, meta }) => ({ from, reply, meta })),
  }

  fs.mkdirSync(path.dirname(absOut), { recursive: true })
  fs.writeFileSync(absOut, JSON.stringify(profile, null, 2), 'utf8')

  console.log('Wrote:', absOut)
  console.log('Me:', meName)
  console.log('Examples:', examples.length)
}

main()

