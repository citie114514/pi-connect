/**
 * The Cline channel.
 *
 * ## What is different about this one
 *
 * 1. **The bearer carries a literal prefix**: `Authorization: Bearer workos:<jwt>`.
 *    Stripping `workos:` before sending produces a 401 whose message blames the
 *    client version. The prefix is only removed when decoding the JWT locally.
 * 2. **Sign-in is a WorkOS device grant.** It fits the same flow as MiniMax, so
 *    it reuses `device-login.js`; the only extra step is registering the granted
 *    token with Cline's own API before it can be used.
 * 3. **The roster comes from two endpoints** — `recommended-models` for the free
 *    set and `/models` for the full id list — and neither alone is the right
 *    answer.
 *
 * @module pi-connect-free/providers/cline
 */

import { FreeModelError, KIND } from './types.js'
import { getJson, postJson, readErrorBody, httpError } from '../http.js'
import { runDeviceLogin, str, num } from '../device-login.js'
import { readCredential, writeCredential, clearCredential, isExpired } from '../credential-store.js'

const WHAT = 'Cline'
const API_BASE = 'https://api.cline.bot'
const CHAT_PATH = '/api/v1/chat/completions'
const MODELS_PATH = '/api/v1/models'
const RECOMMENDED_PATH = '/api/v1/ai/cline/recommended-models'
const REGISTER_PATH = '/api/v1/auth/register'
const REFRESH_PATH = '/api/v1/auth/refresh'
const WORKOS_BASE = 'https://api.workos.com'
const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
const TOKEN_PREFIX = 'workos:'

/**
 * Ensure the access token carries the `workos:` prefix, idempotently.
 *
 * The server sometimes hands back the prefix and sometimes a bare JWT; both are
 * valid, and only one of them works as a bearer value.
 */
export function bearerValue(accessToken) {
  const token = accessToken.trim()
  return token.startsWith(TOKEN_PREFIX) ? token : `${TOKEN_PREFIX}${token}`
}

function headers(token, accept = 'application/json') {
  return { authorization: `Bearer ${bearerValue(token)}`, accept }
}

/** Sign in through WorkOS, then register the token with Cline. */
export async function login({ onPrompt, onStatus, signal } = {}) {
  const grant = await runDeviceLogin({
    what: WHAT,
    deviceUrl: `${WORKOS_BASE}/user_management/authorize/device`,
    tokenUrl: `${WORKOS_BASE}/user_management/authenticate`,
    clientId: WORKOS_CLIENT_ID,
    onPrompt,
    onStatus,
    signal,
  })
  const accessToken = str(grant.access_token)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} returned no access token`)
  // Registering is what turns a WorkOS token into a Cline session; skipping it
  // leaves a credential that authenticates at WorkOS and 401s at Cline.
  const registered = await postJson(`${API_BASE}${REGISTER_PATH}`, {
    body: { accessToken: bearerValue(accessToken), refreshToken: str(grant.refresh_token) },
    what: `${WHAT} token registration`,
    signal,
  })
  const data = registered?.data ?? {}
  const finalAccess = bearerValue(str(data.accessToken) || accessToken)
  const finalRefresh = str(data.refreshToken) || str(grant.refresh_token)
  const expiresAt = Date.parse(str(data.expiresAt))
  const credential = {
    provider: 'cline',
    uid: str(data.userInfo?.clineUserId) || `token:${finalAccess.slice(-12)}`,
    accessToken: finalAccess,
    refreshToken: finalRefresh,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    nickname: str(data.userInfo?.name) || 'Cline',
    source: 'app',
  }
  writeCredential('cline', credential)
  return credential
}

/** Forget this channel's stored sign-in. */
export function logout() {
  clearCredential('cline')
}

export async function findCredential() {
  return readCredential('cline')
}

/**
 * Renew an expired token.
 *
 * Two things here are load-bearing and both come from the reference
 * implementation's field notes: the request body is camelCase (`refreshToken`,
 * `grantType`) rather than the OAuth standard, and the server may answer with a
 * new access token and no new refresh token — in which case the old one must be
 * kept, or the account becomes unrenewable after a single refresh.
 */
export async function refresh(credential, signal) {
  const refreshToken = str(credential.refreshToken)
  if (refreshToken === '') {
    throw new FreeModelError(KIND.auth, `${WHAT} has no refresh token; sign in again`)
  }
  const document = await postJson(`${API_BASE}${REFRESH_PATH}`, {
    body: { refreshToken, grantType: 'refresh_token' },
    what: `${WHAT} token refresh`,
    signal,
  })
  const data = document?.data ?? {}
  const accessToken = str(data.accessToken)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} refresh returned no token; sign in again`)
  const expiresAt = Date.parse(str(data.expiresAt))
  const renewed = {
    ...credential,
    accessToken: bearerValue(accessToken),
    refreshToken: str(data.refreshToken) || refreshToken,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  }
  writeCredential('cline', renewed)
  return renewed
}

/** The credential to use right now, refreshed first if it has expired. */
async function usable(credential, signal) {
  if (!isExpired(credential)) return credential
  return refresh(credential, signal)
}

/**
 * List the roster.
 *
 * The two endpoints answer different questions, so both are read and merged:
 * `recommended-models` marks which entries are free, `/models` carries the ids
 * the chat endpoint will accept. Reading only one produces a list that is either
 * missing models or missing the free flag.
 */
export async function listModels(credential, signal) {
  const active = await usable(credential, signal)
  const failures = []
  const recommended = await getJson(`${API_BASE}${RECOMMENDED_PATH}`, {
    headers: headers(active.accessToken),
    signal,
    what: `${WHAT} recommended models`,
  }).catch((error) => {
    failures.push(error.message)
    return undefined
  })
  const all = await getJson(`${API_BASE}${MODELS_PATH}`, {
    headers: headers(active.accessToken),
    signal,
    what: `${WHAT} model listing`,
  }).catch((error) => {
    failures.push(error.message)
    return undefined
  })
  const freeIds = new Set()
  for (const entry of Array.isArray(recommended?.data) ? recommended.data : Array.isArray(recommended) ? recommended : []) {
    const id = str(entry?.id)
    if (id !== '') freeIds.add(id)
  }
  const entries = Array.isArray(all?.data) ? all.data : Array.isArray(all) ? all : []
  const models = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.id)
    if (id === '') continue
    models.push({
      id,
      name: str(entry.name) || id,
      contextWindow: num(entry.context_window) ?? num(entry.contextWindow) ?? 0,
      maxOutput: num(entry.max_tokens) ?? num(entry.maxOutput) ?? 0,
      supportsImage: entry.supports_images === true || entry.supportsImages === true,
      isFree: freeIds.has(id),
    })
  }
  if (models.length === 0) {
    throw new FreeModelError(
      KIND.empty,
      `${WHAT} published no models${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`,
    )
  }
  return models
}

/**
 * Send one turn.
 *
 * Cline's chat endpoint is OpenAI-shaped, so the response is handed back
 * untouched. The one protocol detail that matters is the reasoning field: this
 * upstream emits `delta.reasoning` where most emit `reasoning_content`, and a
 * client that only looks for the latter shows a model that "thinks silently".
 * The frames are passed through as they are; normalising them here would mean
 * rewriting every chunk for a cosmetic difference.
 */
export async function chat(credential, request) {
  const active = await usable(credential, request.signal)
  let response
  try {
    response = await fetch(`${API_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: { ...headers(active.accessToken, 'text/event-stream'), 'content-type': 'application/json' },
      body: JSON.stringify({ ...(request.body ?? {}), model: request.model, stream: request.body?.stream !== false }),
      signal: request.signal,
    })
  } catch (error) {
    if (request.signal?.aborted === true || error?.name === 'AbortError') {
      throw new FreeModelError(KIND.aborted, `${WHAT} request was aborted`, { cause: error })
    }
    throw new FreeModelError(KIND.transport, `${WHAT} request failed: ${error?.message ?? error}`, { cause: error })
  }
  if (!response.ok) throw httpError(`${WHAT} request`, response, await readErrorBody(response))
  if (response.body === null) throw new FreeModelError(KIND.empty, `${WHAT} answered with no body`)
  return response
}

/** @type {import('./types.js').Provider} */
export const provider = {
  id: 'cline',
  name: 'Cline',
  capabilities: {
    listModels: true,
    chat: true,
    balance: false,
    checkin: false,
    refresh: true,
    balanceBlockedReason: 'the quota endpoint was not verified for this channel, so it is not claimed',
    checkinBlockedReason: 'Cline has no daily check-in',
  },
  findCredential,
  listModels,
  chat,
  refresh,
  login,
  logout,
}

export const providers = [provider]
