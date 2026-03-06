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
  const thisYear = now.getUTCFullYear()
  const candidate = new Date(Date.UTC(thisYear, monthIdx, day))
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

  let result = null

  // Pattern: "6or7 Jan" (no spaces)
  const glued = norm.match(/\b(\d{1,2})\s*or\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (glued) {
    const d1 = clampDay(parseInt(glued[1], 10))
    const d2 = clampDay(parseInt(glued[2], 10))
    const m = parseMonthToken(glued[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      result = { days: uniqDates([new Date(Date.UTC(y1, m, d1)), new Date(Date.UTC(y2, m, d2))]), monthName: glued[3] }
    }
  }

  // Pattern: "23 or 24 Jan"
  const m1 = norm.match(/\b(\d{1,2})\s*or\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (!result && m1) {
    const d1 = clampDay(parseInt(m1[1], 10))
    const d2 = clampDay(parseInt(m1[2], 10))
    const m = parseMonthToken(m1[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      result = { days: uniqDates([new Date(Date.UTC(y1, m, d1)), new Date(Date.UTC(y2, m, d2))]), monthName: m1[3] }
    }
  }

  // Pattern: "23/24 Jan"
  const m2 = norm.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*([A-Za-z]{3,9})\b/i)
  if (!result && m2) {
    const d1 = clampDay(parseInt(m2[1], 10))
    const d2 = clampDay(parseInt(m2[2], 10))
    const m = parseMonthToken(m2[3])
    if (d1 && d2 && m != null) {
      const y1 = inferYear(m, d1)
      const y2 = inferYear(m, d2)
      result = { days: uniqDates([new Date(Date.UTC(y1, m, d1)), new Date(Date.UTC(y2, m, d2))]), monthName: m2[3] }
    }
  }

  // Pattern: single date — "Mar 24", "March 24", "24 Mar", "24th Mar", "the 24th Mar"
  if (!result) {
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
        result = { days: uniqDates([new Date(Date.UTC(y, monthIdx, day))]), monthName }
        break
      }
    }
  }

  // Pattern: "26/3 or 27/3"
  if (!result) {
    const m3 = norm.match(/\b(\d{1,2})\/(\d{1,2})\s*or\s*(\d{1,2})\/(\d{1,2})\b/i)
    if (m3) {
      const d1 = clampDay(parseInt(m3[1], 10))
      const mIdx1 = parseInt(m3[2], 10) - 1
      const d2 = clampDay(parseInt(m3[3], 10))
      const mIdx2 = parseInt(m3[4], 10) - 1
      if (d1 && d2 && mIdx1 >= 0 && mIdx1 <= 11 && mIdx2 >= 0 && mIdx2 <= 11) {
        const y1 = inferYear(mIdx1, d1)
        const y2 = inferYear(mIdx2, d2)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        result = { days: uniqDates([new Date(Date.UTC(y1, mIdx1, d1)), new Date(Date.UTC(y2, mIdx2, d2))]), monthName: monthNames[mIdx1] }
      }
    }
  }

  // Pattern: "26/3" (Day/Month)
  if (!result) {
    const dM = norm.match(/\b(\d{1,2})\/(\d{1,2})\b/)
    if (dM) {
      const d = clampDay(parseInt(dM[1], 10))
      const mIdx = parseInt(dM[2], 10) - 1
      if (d && mIdx >= 0 && mIdx <= 11) {
        const y = inferYear(mIdx, d)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        result = { days: uniqDates([new Date(Date.UTC(y, mIdx, d))]), monthName: monthNames[mIdx] }
      }
    }
  }

  if (result) {
    const times = [];
    const timeRegex = /\b(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)\b|\b(\d{1,2})[.:](\d{2})\b/gi;
    let match;
    while ((match = timeRegex.exec(norm)) !== null) {
      let hours = parseInt(match[1] || match[4], 10);
      const mins = parseInt(match[2] || match[5] || "0", 10);
      const meridiem = (match[3] || "").toLowerCase();

      if (hours > 24 || mins >= 60) continue;
      if (meridiem) {
        if (hours > 12) continue;
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
      }

      times.push({ hours, mins });
    }
    if (times.length > 0) result.times = times;
  }

  return result
}

module.exports = { extractDateOptions }

