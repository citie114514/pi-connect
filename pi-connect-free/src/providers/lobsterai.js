/**
 * The LobsterAI (Youdao) channel.
 *
 * ## What is different about this one
 *
 * 1. **The chat endpoint is stream-only.** `stream: false` is answered with a
 *    500, so the flag is forced on rather than forwarded.
 * 2. **The roster endpoint filters by a capability header.** Without
 *    `X-LobsterAI-Client-Capabilities` the server returns a smaller set —
 *    `kimi-k3` simply does not appear. A parser that is otherwise correct still
 *    loses models, which reads as "the channel is incomplete".
 * 3. **Sign-in needs a loopback callback.** The upstream hands the authorization
 *    code back to `127.0.0.1:<port>`; unlike the Workers-targeted reference
 *    implementation, this package runs as a local process, so it can host that
 *    listener itself. That is why this channel signs in here when the reference
 *    one could not.
 *
 * @module pi-connect-free/providers/lobsterai
 */

import { createServer } from 'node:http'

import { FreeModelError, KIND } from './types.js'
import { getJson, readErrorBody, httpError } from '../http.js'
import { str, num } from '../device-login.js'
import { readCredential, writeCredential, clearCredential, isExpired } from '../credential-store.js'

const WHAT = 'LobsterAI'
const API_BASE = 'https://lobsterai-server.youdao.com'
const CHAT_PATH = '/api/proxy/v1/chat/completions'
const MODELS_PATH = '/api/models/available'
const REFRESH_PATH = '/api/auth/refresh'
const USER_AGENT = 'LobsterAI/0.1.0'
const CLIENT_VERSION = '2026.9.4'
const CLIENT_CAPABILITIES = 'tools,reasoning'

function headers(token, accept = 'application/json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-LobsterAI-Client-Capabilities': CLIENT_CAPABILITIES,
    'X-LobsterAI-Client-Version': CLIENT_VERSION,
  }
}

/**
 * Run a loopback-callback sign-in.
 *
 * The flow is the standard authorization-code one, hosted locally: open the
 * browser at the authorization URL with `redirect_uri` pointing at this
 * process's listener, wait for the code, then exchange it. The listener binds
 * `127.0.0.1` on an ephemeral port and is torn down as soon as the code lands or
 * the deadline passes.
 *
 * @param {object} options
 * @param {(url: string) => void} options.onPrompt  receives the URL to open
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 */
export async function login({ onPrompt, signal, timeoutMs = 300000 } = {}) {
  const state = crypto.randomUUID()
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise((resolve) => server.close(() => resolve()))
    throw new FreeModelError(KIND.transport, `${WHAT} could not open a local callback port`)
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`

  const authorizationUrl = `${API_BASE}/api/auth/authorize?${new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    client: 'desktop',
  }).toString()}`

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new FreeModelError(KIND.timeout, `${WHAT} sign-in timed out; start it again`))
    }, timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      cleanup()
      reject(new FreeModelError(KIND.aborted, `${WHAT} sign-in was cancelled`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      server.close()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const returned = url.searchParams.get('code') ?? ''
      const returnedState = url.searchParams.get('state') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<meta charset="utf-8"><p>已收到授权，可以关闭此页面。</p>')
      if (returnedState !== state) {
        cleanup()
        reject(new FreeModelError(KIND.auth, `${WHAT} callback carried a mismatched state`))
        return
      }
      cleanup()
      if (returned === '') {
        reject(new FreeModelError(KIND.auth, `${WHAT} callback carried no authorization code`))
        return
      }
      resolve(returned)
    })
    onPrompt?.(authorizationUrl)
  })

  // Exchange the code. The response shape is the same envelope the other
  // endpoints use, so a non-zero `code` is a failure even on HTTP 200.
  const document = await getJson(
    `${API_BASE}/api/auth/token?${new URLSearchParams({ code, redirect_uri: redirectUri }).toString()}`,
    { headers: { 'User-Agent': USER_AGENT }, what: `${WHAT} token exchange` },
  )
  const data = document?.data ?? {}
  const accessToken = str(data.accessToken) || str(data.access_token)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} returned no access token`)
  const expiresAt = num(data.expiresAt) ?? num(data.expire_time) ?? 0
  const credential = {
    provider: 'lobsterai',
    uid: str(data.userId) || str(data.user_id) || `token:${accessToken.slice(-12)}`,
    accessToken,
    refreshToken: str(data.refreshToken) || str(data.refresh_token),
    expiresAt: typeof expiresAt === 'number' ? expiresAt : 0,
    nickname: 'LobsterAI',
    source: 'app',
    extras: {
      ...(str(data.uuid) === '' ? {} : { uuid: str(data.uuid) }),
      ...(str(data.firstKeyfrom) === '' ? {} : { first_keyfrom: str(data.firstKeyfrom) }),
      ...(str(data.latestKeyfrom) === '' ? {} : { latest_keyfrom: str(data.latestKeyfrom) }),
    },
  }
  writeCredential('lobsterai', credential)
  return credential
}

export function logout() {
  clearCredential('lobsterai')
}

export async function findCredential() {
  return readCredential('lobsterai')
}

async function usable(credential, signal) {
  if (!isExpired(credential)) return credential
  const refreshToken = str(credential.refreshToken)
  if (refreshToken === '') throw new FreeModelError(KIND.auth, `${WHAT} token expired; sign in again`)
  const document = await getJson(`${API_BASE}${REFRESH_PATH}`, {
    headers: headers(credential.accessToken),
    signal,
    what: `${WHAT} token refresh`,
  }).catch(() => undefined)
  const data = document?.data ?? {}
  const accessToken = str(data.accessToken) || str(data.access_token)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} refresh failed; sign in again`)
  const renewed = {
    ...credential,
    accessToken,
    refreshToken: str(data.refreshToken) || str(data.refresh_token) || refreshToken,
    ...(num(data.expiresAt) === undefined ? {} : { expiresAt: num(data.expiresAt) }),
  }
  writeCredential('lobsterai', renewed)
  return renewed
}

export async function listModels(credential, signal) {
  const active = await usable(credential, signal)
  const params = new URLSearchParams({ version: CLIENT_VERSION })
  for (const [key, value] of Object.entries({
    firstKeyfrom: active.extras?.first_keyfrom ?? '',
    latestKeyfrom: active.extras?.latest_keyfrom ?? '',
    uuid: active.extras?.uuid ?? '',
    userId: active.uid ?? '',
  })) {
    if (value !== '') params.set(key, value)
  }
  const document = await getJson(`${API_BASE}${MODELS_PATH}?${params.toString()}`, {
    headers: headers(active.accessToken),
    signal,
    what: `${WHAT} model listing`,
  })
  const entries = Array.isArray(document?.data) ? document.data : Array.isArray(document) ? document : []
  const models = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.id) || str(entry.model)
    if (id === '') continue
    models.push({
      id,
      name: str(entry.name) || id,
      contextWindow: num(entry.contextWindow) ?? num(entry.context_window) ?? 0,
      maxOutput: num(entry.maxOutput) ?? num(entry.max_tokens) ?? 0,
      supportsImage: entry.supportsImage === true || entry.supports_images === true,
      isFree: entry.isFree === true,
    })
  }
  if (models.length === 0) throw new FreeModelError(KIND.empty, `${WHAT} published no models`)
  return models
}

export async function chat(credential, request) {
  const active = await usable(credential, request.signal)
  let response
  try {
    response = await fetch(`${API_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: headers(active.accessToken, 'text/event-stream, application/json'),
      // `stream: false` is answered with a 500 on this upstream, so it is not
      // forwarded as a preference — it is set.
      body: JSON.stringify({ ...(request.body ?? {}), model: request.model, stream: true }),
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
  id: 'lobsterai',
  name: 'LobsterAI',
  capabilities: {
    listModels: true,
    chat: true,
    balance: false,
    checkin: true,
    refresh: true,
    balanceBlockedReason: 'the profile endpoint reports usage but no spendable quota this package can read',
  },
  findCredential,
  listModels,
  chat,
  login,
  logout,
}

export const providers = [provider]
