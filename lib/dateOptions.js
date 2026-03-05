/**
 * Parse date options from free-text messages like:
 * - "23 or 24 Jan"
 * - "6or7 Jan shooting"
 * - "23/24 Jan"
 *
 * Returns candidate Date objects (local) with inferred year.
 */

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

function clampDay(n) {
  if (!Number.isFinite(n)) return null
  if (n < 1 || n > 31) return null
  return n
}

function inferYear(monthIdx, day) {
  const now = new Date()
  const thisYear = now.getFullYear()
  const candidate = new Date(thisYear, monthIdx, day)
  // If it's more than ~3 months in the past, assume next year
  if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 90) {
    return thisYear + 1
  }
  return thisYear
}

function uniqDates(dates) {
  const out = []
  const seen = new Set()
  for (const d of dates) {
    if (!(d instanceof Date) || isNaN(d.getTime())) continue
    const key = d.toISOString().slice(0, 10)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

function parseMonthToken(tok) {
  if (!tok) return null
  const k = String(tok).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(MONTHS, k) ? MONTHS[k] : null
}

/**
 * @param {string} text
 * @returns {{ days: Date[], monthName?: string } | null}
 */
function extractDateOptions(text) {
  const t = String(text || '')
  if (!t.trim()) return null

  // Normalize separators
  const norm = t
    .replace(/(\d)\s*or\s*(\d)/gi, '$1 or $2')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    .replace(/(\d)\s*-\s*(\d)/g, '$1-$2')

  // Pattern: "6or7 Jan" (no spaces)
  const glued = norm.match(/\b(\d{1,2})\s*or\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (glued) {
    const d1 = clampDay(parseInt(glued[1], 10))
    const d2 = clampDay(parseInt(glued[2], 10))
    const m = parseMonthToken(glued[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      return { days: uniqDates([new Date(y1, m, d1), new Date(y2, m, d2)]), monthName: glued[3] }
    }
  }

  // Pattern: "23 or 24 Jan"
  const m1 = norm.match(/\b(\d{1,2})\s*or\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (m1) {
    const d1 = clampDay(parseInt(m1[1], 10))
    const d2 = clampDay(parseInt(m1[2], 10))
    const m = parseMonthToken(m1[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      return { days: uniqDates([new Date(y1, m, d1), new Date(y2, m, d2)]), monthName: m1[3] }
    }
  }

  // Pattern: "23/24 Jan"
  const m2 = norm.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (m2) {
    const d1 = clampDay(parseInt(m2[1], 10))
    const d2 = clampDay(parseInt(m2[2], 10))
    const m = parseMonthToken(m2[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      return { days: uniqDates([new Date(y1, m, d1), new Date(y2, m, d2)]), monthName: m2[3] }
    }
  }

  // Pattern: single date — "Mar 24", "March 24", "24 Mar", "24th Mar", "the 24th Mar"
  // Try all global matches for "Month Day" and "Day Month", pick first valid one
  const singleCandidates = [
    ...Array.from(norm.matchAll(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)),
    ...Array.from(norm.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/gi)),
  ]
  for (const s of singleCandidates) {
    const tryMonth1 = parseMonthToken(s[1])
    const tryMonth2 = parseMonthToken(s[2])
    let day, monthIdx, monthName
    if (tryMonth1 != null) {
      monthIdx = tryMonth1; monthName = s[1]; day = clampDay(parseInt(s[2], 10))
    } else if (tryMonth2 != null) {
      monthIdx = tryMonth2; monthName = s[2]; day = clampDay(parseInt(s[1], 10))
    }
    if (day != null && monthIdx != null) {
      const y = inferYear(monthIdx, day)
      return { days: uniqDates([new Date(y, monthIdx, day)]), monthName }
    }
  }

  return null
}

module.exports = { extractDateOptions }

