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
} catch {}

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
async function isFreeOnDays({ days, calendarId = 'primary', timeZone = 'Asia/Hong_Kong' }) {
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

  const timeMin = startOfDayISO(earliest, timeZone)
  const timeMax = endOfDayISO(latest, timeZone)

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

  // default all queried days to free, then mark busy if overlaps
  for (const day of unique) {
    result.set(day.toISOString().slice(0, 10), true)
  }

  // If there is any busy slot on that day, treat it as not free.
  // (Simple day-level availability; we can refine to time-window later.)
  for (const slot of busy) {
    const start = new Date(slot.start)
    const end = new Date(slot.end)
    for (const day of unique) {
      const dayStart = new Date(day)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(day)
      dayEnd.setHours(23, 59, 59, 999)
      const overlaps = start <= dayEnd && end >= dayStart
      if (overlaps) result.set(day.toISOString().slice(0, 10), false)
    }
  }

  return result
}

module.exports = {
  isFreeOnDays,
}

