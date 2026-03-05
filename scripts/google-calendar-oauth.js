#!/usr/bin/env node
/**
 * One-time OAuth helper for Google Calendar (personal account).
 *
 * You need to create OAuth Client ID (Desktop App) in Google Cloud Console,
 * enable Google Calendar API, then set env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * This script opens a local callback server, prints an auth URL to open in
 * your browser, waits for the redirect, then prints the refresh token to put
 * into VPS config.env as: GOOGLE_REFRESH_TOKEN=...
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-calendar-oauth.js
 */

const http = require('http')
const { google } = require('googleapis')

const PORT = 3456
const REDIRECT_URI = `http://localhost:${PORT}/callback`

async function main() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim()
  if (!clientId || !clientSecret) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.')
    process.exit(1)
  }

  const oauth2 = new google.auth.OAuth2({ clientId, clientSecret, redirectUri: REDIRECT_URI })

  const scopes = ['https://www.googleapis.com/auth/calendar.readonly']
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes })

  console.log('\nOpen this URL in your browser:\n')
  console.log(url)
  console.log('\nWaiting for Google to redirect back to localhost...\n')

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI)
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>Done! You can close this tab.</h2>')
      server.close()
      if (err) reject(new Error(`OAuth error: ${err}`))
      else resolve(code)
    })
    server.listen(PORT)
  })

  const { tokens } = await oauth2.getToken(code)
  if (!tokens?.refresh_token) {
    console.error('\nNo refresh_token returned. Revoke app access in your Google account and retry.\n')
    process.exit(1)
  }

  console.log('\nSave this in your VPS config.env:\n')
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log('\n(Keep it secret.)\n')
}

main().catch((e) => {
  console.error('OAuth failed:', e?.message || e)
  process.exit(1)
})

