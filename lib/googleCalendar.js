const path = require('path')
const { existsSync } = require('fs')

// Load env similarly to other plugins/libs
try {
  const configEnvPath = path.join(__dirname, '../config.env')
  const dotEnvPath = path.join(__dirname, '../.env')
  const envPath = existsSync(configEnvPath)
    ? configEnvPath
    : existsSync(dotEnvPath)
      ? dotEnvPath
      : null
  if (envPath) require('dotenv').config({ path: envPath })
} catch { }

const { google } = require('googleapis')

let cached = null

function getRequiredEnv() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim()
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim()

  if (!clientId) throw new Error('Missing GOOGLE_CLIENT_ID')
  if (!clientSecret) throw new Error('Missing GOOGLE_CLIENT_SECRET')
  if (!refreshToken) throw new Error('Missing GOOGLE_REFRESH_TOKEN')

  return { clientId, clientSecret, refreshToken }
}

function getOAuthClient() {
  if (cached?.oauth2) return cached.oauth2

  const { clientId, clientSecret, refreshToken } = getRequiredEnv()

  const oauth2 = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  })

  oauth2.setCredentials({ refresh_token: refreshToken })
  cached = { oauth2 }
  return oauth2
}

function startOfDayISO(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}T00:00:00Z`
}

function endOfDayISO(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}T23:59:59Z`
}

/**
 * Query Google Calendar free/busy for the provided days.
 *
 * @param {Object} opts
 * @param {Date[]} opts.days - list of day Date objects (local date; time ignored)
 * @param {string} [opts.calendarId] - default "primary"
 * @param {string} [opts.timeZone] - default "Asia/Hong_Kong"
 * @returns {Promise<Map<string, boolean>>} Map YYYY-MM-DD -> isFree
 */
function getUtcEpoch(dayStr, hours, mins, timeZone) {
  const naiveUtc = new Date(`${dayStr}T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset'
  }).formatToParts(naiveUtc)

  const tzPart = parts.find(p => p.type === 'timeZoneName').value
  let h = 0, m = 0, sign = 1
  if (tzPart !== 'GMT' && tzPart !== 'UTC') {
    const match = tzPart.match(/[-+](\d{1,2})(?::(\d{2}))?/)
    if (match) {
      sign = tzPart.includes('-') ? -1 : 1
      h = parseInt(match[1], 10)
      m = parseInt(match[2] || "0", 10)
    }
  }
  return naiveUtc.getTime() - (sign * ((h * 60) + m) * 60000)
}

async function isFreeOnDays({ days, times, calendarId = 'primary', timeZone = 'Asia/Hong_Kong' }) {
  const oauth2 = getOAuthClient()
  const calendar = google.calendar({ version: 'v3', auth: oauth2 })

  const unique = []
  const seen = new Set()
  for (const day of days || []) {
    if (!(day instanceof Date) || isNaN(day.getTime())) continue
    const key = day.toISOString().slice(0, 10)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(day)
  }

  if (unique.length === 0) return new Map()

  const earliest = new Date(Math.min(...unique.map((d) => d.getTime())))
  const latest = new Date(Math.max(...unique.map((d) => d.getTime())))

  const extendedLatest = new Date(latest.getTime() + 86400000)

  const timeMin = startOfDayISO(earliest)
  const timeMax = endOfDayISO(extendedLatest)

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone,
      items: [{ id: calendarId }],
    },
  })

  const busy = data?.calendars?.[calendarId]?.busy || []
  const result = new Map()

  for (const day of unique) {
    result.set(day.toISOString().slice(0, 10), true)
  }

  for (const day of unique) {
    const dayStr = day.toISOString().slice(0, 10)

    if (times && times.length > 0) {
      let anyTimeFree = false
      for (const t of times) {
        const checkStartMs = getUtcEpoch(dayStr, t.hours, t.mins, timeZone)
        const checkEndMs = checkStartMs + 60 * 60 * 1000 // 1 hour block

        let thisTimeOverlaps = false
        for (const slot of busy) {
          const slotStart = new Date(slot.start).getTime()
          const slotEnd = new Date(slot.end).getTime()
          if (slotStart < checkEndMs && slotEnd > checkStartMs) {
            thisTimeOverlaps = true
            break
          }
        }
        if (!thisTimeOverlaps) {
          anyTimeFree = true
          break
        }
      }
      if (!anyTimeFree) {
        result.set(dayStr, false)
      }
    } else {
      const dayStartMs = getUtcEpoch(dayStr, 0, 0, timeZone)
      const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000 - 1
      for (const slot of busy) {
        const slotStart = new Date(slot.start).getTime()
        const slotEnd = new Date(slot.end).getTime()
        if (slotStart <= dayEndMs && slotEnd >= dayStartMs) {
          result.set(dayStr, false)
          break
        }
      }
    }
  }

  return result
}

module.exports = {
  isFreeOnDays,
}

