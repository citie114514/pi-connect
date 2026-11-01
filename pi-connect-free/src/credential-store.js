/**
 * Credential storage for channels that sign in themselves.
 *
 * ## What is stored, and what is not
 *
 * One JSON file per channel under this package's own cache directory, mode
 * `0600`. It holds the access token, the refresh token, the expiry and the
 * account id — the same material the vendor's own client keeps on disk. Nothing
 * is sent anywhere; the file exists so a sign-in survives a restart.
 *
 * ## Why not the OS keychain
 *
 * Every supported platform has one and each is a different native dependency.
 * This package has no dependencies by design, and the vendor clients these
 * channels belong to already store the same tokens as plain files in the user's
 * profile. Adding a keychain would not raise the bar against a local attacker
 * who can already read those files.
 *
 * @module pi-connect-free/src/credential-store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** This package's own state directory, alongside the sibling packages' caches. */
export function ownDir() {
  return join(homedir(), '.pi', 'agent', 'cache', 'pi-connect-free')
}

function storePath(channelId) {
  return join(ownDir(), `credential-${channelId}.json`)
}

/**
 * Read one channel's stored credential.
 *
 * A damaged file is treated as "not signed in" rather than an error: the user's
 * remedy is the same either way (sign in again), and throwing here would take
 * down the whole channel's model list for a truncated write.
 *
 * @param {string} channelId
 * @returns {import('../providers/types.js').ProviderCredential | undefined}
 */
export function readCredential(channelId) {
  const path = storePath(channelId)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== 1) return undefined
    const credential = parsed.credential
    if (typeof credential !== 'object' || credential === null) return undefined
    if (typeof credential.accessToken !== 'string' || credential.accessToken === '') return undefined
    return credential
  } catch {
    return undefined
  }
}

/**
 * Write one channel's credential.
 *
 * Temp file then rename: a crash mid-write leaves the previous credential in
 * place rather than a half-written file that reads as "not signed in".
 *
 * @param {string} channelId
 * @param {import('../providers/types.js').ProviderCredential} credential
 */
export function writeCredential(channelId, credential) {
  const path = storePath(channelId)
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), credential }, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode bits; the file is already in the user's profile.
  }
}

/** Forget one channel's stored credential. */
export function clearCredential(channelId) {
  const path = storePath(channelId)
  for (const target of [path, `${path}.tmp`]) {
    try {
      if (existsSync(target)) unlinkSync(target)
    } catch {
      // Nothing to reclaim.
    }
  }
}

/**
 * Whether a credential is past its expiry, with a margin.
 *
 * The margin matters: a token that expires during a turn fails that turn, and
 * the retry then looks like a channel outage rather than an expiring token.
 *
 * @param {import('../providers/types.js').ProviderCredential} credential
 * @param {number} [marginMs]
 */
export function isExpired(credential, marginMs = 60000) {
  if (credential.expiresAt === 0) return false
  return credential.expiresAt <= Date.now() + marginMs
}
