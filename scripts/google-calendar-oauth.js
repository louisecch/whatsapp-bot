#!/usr/bin/env node
/**
 * One-time OAuth helper for Google Calendar (personal account).
 *
 * You need to create OAuth Client ID (Desktop App) in Google Cloud Console,
 * enable Google Calendar API, then set env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * This script prints an auth URL; open it, consent, copy code, paste here.
 * Then it prints a refresh token you can put into VPS config.env as:
 *   GOOGLE_REFRESH_TOKEN=...
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-calendar-oauth.js
 */

const readline = require('readline')
const { google } = require('googleapis')

async function main() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim()
  if (!clientId || !clientSecret) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.')
    process.exit(1)
  }

  const oauth2 = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  })

  const scopes = ['https://www.googleapis.com/auth/calendar.readonly']
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  })

  console.log('\nOpen this URL in your browser, then paste the code below:\n')
  console.log(url)
  console.log('\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = await new Promise((resolve) => rl.question('Paste code: ', resolve))
  rl.close()

  const { tokens } = await oauth2.getToken(code.trim())
  if (!tokens?.refresh_token) {
    console.error('\nNo refresh_token returned.\nTry again and ensure prompt=consent, or revoke app access and retry.\n')
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

