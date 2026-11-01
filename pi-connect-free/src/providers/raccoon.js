/**
 * The Raccoon Work (SenseTime) channel.
 *
 * ## What is different about this one
 *
 * 1. **Sign-in is a QR scan polled over plain HTTP.** The desktop client
 *    normally catches the callback through its own `office-raccoon://` scheme,
 *    but the poll endpoint accepts any client-chosen code and reports progress
 *    by status. That makes it usable here without a listener or a challenge.
 * 2. **A `success` answer with no token is not success.** The server can report
 *    the scan as complete a beat before the token is minted; treating that as
 *    finished produces an empty credential and a flow that hangs.
 * 3. **Every failure during polling is `pending`.** A dropped connection while
 *    the user is still scanning is not a refusal, and misreporting it would
 *    throw away a QR code they are in the middle of using.
 *
 * SMS sign-in is deliberately absent: it requires an Alibaba slider-captcha
 * token, which means solving a human-verification challenge.
 *
 * @module pi-connect-free/providers/raccoon
 */

import { createHash, randomBytes } from 'node:crypto'

import { FreeModelError, KIND } from './types.js'
import { getJson, postJson, readErrorBody, httpError } from '../http.js'
import { str, num } from '../device-login.js'
import { readCredential, writeCredential, clearCredential, isExpired } from '../credential-store.js'

const WHAT = 'Raccoon'
const API_BASE = 'https://xiaohuanxiong.com'
const AUTH_PREFIX = '/api/web/auth/v1'
const CHAT_PATH = '/api/web/llm/v2/chat/completions'
const CATALOG_PATH = '/api/web/llm/v2/model_catalog'
const BALANCE_PATH = '/api/web/points/v1/balance'
const REFRESH_PATH = `${AUTH_PREFIX}/refresh`
const QR_POLL_PATH = `${AUTH_PREFIX}/login_with_qrcode_code`

const QR_STATUS = Object.freeze({ pending: 'pending', logging: 'logging', canceled: 'canceled', success: 'success' })

function headers(token, accept = 'application/json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'X-Raccoon-Language': 'zh-CN',
  }
}

/** The URL a phone scans. The code is client-chosen; the server only records it. */
export function buildQrLoginUrl(code) {
  return `${API_BASE}/login/mp?${new URLSearchParams({ code, appname: '商汤小浣熊官网' }).toString()}`
}

/**
 * Poll one QR login attempt.
 *
 * @returns {Promise<{status: string, accessToken?: string, refreshToken?: string, expiredAt?: string}>}
 */
export async function pollQrLogin(code, signal) {
  let document
  try {
    const response = await fetch(`${API_BASE}${QR_POLL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrcode_code: code }),
      signal,
    })
    document = await response.json()
  } catch {
    // A dropped poll is not evidence that the user refused.
    return { status: QR_STATUS.pending }
  }
  const envelope = document ?? {}
  if (envelope.code !== 0 || typeof envelope.data !== 'object' || envelope.data === null) {
    return { status: QR_STATUS.pending }
  }
  const data = envelope.data
  const status = str(data.status)
  if (status === QR_STATUS.canceled) return { status: QR_STATUS.canceled }
  if (status === QR_STATUS.logging) return { status: QR_STATUS.logging, ...(str(data.expired_at) === '' ? {} : { expiredAt: str(data.expired_at) }) }
  if (status === QR_STATUS.success) {
    const accessToken = str(data.access_token)
    // A success without a token is the server catching up with itself; the next
    // poll answers with the token.
    if (accessToken === '') return { status: QR_STATUS.pending }
    return { status: QR_STATUS.success, accessToken, refreshToken: str(data.refresh_token) }
  }
  return { status: QR_STATUS.pending }
}

/**
 * Run a QR sign-in to completion.
 *
 * `onPrompt` receives the URL to render as a QR code (or open directly, if the
 * caller prefers). Polling is 2 s, which is the cadence the desktop client uses.
 *
 * @param {object} options
 * @param {(url: string, code: string) => void} options.onPrompt
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 */
export async function login({ onPrompt, signal, timeoutMs = 180000 } = {}) {
  const code = randomBytes(16).toString('hex')
  const url = buildQrLoginUrl(code)
  onPrompt?.(url, code)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new FreeModelError(KIND.aborted, `${WHAT} sign-in was cancelled`)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      timer.unref?.()
    })
    const result = await pollQrLogin(code, signal)
    if (result.status === QR_STATUS.canceled) {
      throw new FreeModelError(KIND.auth, `${WHAT} sign-in was cancelled on the phone`)
    }
    if (result.status === QR_STATUS.success) {
      const credential = {
        provider: 'raccoon',
        // The scan flow returns no account id, so one is derived from the token
        // payload — stable for the account, unlike the signature segment.
        uid: deriveUid(result.accessToken),
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? '',
        expiresAt: 0,
        nickname: 'Raccoon',
        source: 'app',
      }
      writeCredential('raccoon', credential)
      return credential
    }
  }
  throw new FreeModelError(KIND.timeout, `${WHAT} sign-in timed out; start it again`)
}

function deriveUid(accessToken) {
  // The signature segment changes on every renewal, so the payload is the
  // stable part. This is a storage key, not a security boundary.
  const parts = accessToken.split('.')
  const material = parts.length >= 2 ? parts[1] : accessToken
  return `raccoon-${createHash('md5').update(material).digest('hex').slice(0, 16)}`
}

export function logout() {
  clearCredential('raccoon')
}

export async function findCredential() {
  return readCredential('raccoon')
}

async function usable(credential, signal) {
  if (!isExpired(credential)) return credential
  const refreshToken = str(credential.refreshToken)
  if (refreshToken === '') throw new FreeModelError(KIND.auth, `${WHAT} token expired; sign in again`)
  const document = await postJson(`${API_BASE}${REFRESH_PATH}`, {
    body: { refresh_token: refreshToken },
    signal,
    what: `${WHAT} token refresh`,
  })
  const data = document?.data ?? {}
  const accessToken = str(data.access_token)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} refresh failed; sign in again`)
  const renewed = {
    ...credential,
    accessToken,
    refreshToken: str(data.refresh_token) || refreshToken,
  }
  writeCredential('raccoon', renewed)
  return renewed
}

export async function listModels(credential, signal) {
  const active = await usable(credential, signal)
  const document = await getJson(`${API_BASE}${CATALOG_PATH}`, {
    headers: headers(active.accessToken),
    signal,
    what: `${WHAT} model catalog`,
  })
  const entries = Array.isArray(document?.data) ? document.data : Array.isArray(document) ? document : []
  const models = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.model_id) || str(entry.id)
    if (id === '') continue
    const effective = num(entry.multiplier) ?? num(entry.price_factor) ?? 1
    const base = num(entry.base_multiplier) ?? num(entry.original_multiplier) ?? effective
    const name = str(entry.description) || id
    models.push({
      id,
      // The multiplier rides in the name: the model menu renders only `name`,
      // and a 1× model still has to show that it costs 1× rather than look
      // like a model whose price could not be read.
      name: effective === 0 ? `${name} · 免费` : base > effective ? `${name} · x${base}→x${effective}` : `${name} · x${effective}`,
      contextWindow: num(entry.context_window) ?? 0,
      maxOutput: num(entry.max_output) ?? 0,
      supportsImage: entry.supports_image === true,
      isFree: effective === 0,
      priceFactor: effective,
    })
  }
  if (models.length === 0) throw new FreeModelError(KIND.empty, `${WHAT} published no models`)
  return models
}

export async function balance(credential, signal) {
  const active = await usable(credential, signal)
  const document = await getJson(`${API_BASE}${BALANCE_PATH}`, {
    headers: headers(active.accessToken),
    signal,
    what: `${WHAT} balance`,
  })
  const data = document?.data ?? {}
  return { total: num(data.total) ?? num(data.points) ?? 0, expiring: 0, earliestExpiry: 0, packages: [] }
}

export async function chat(credential, request) {
  const active = await usable(credential, request.signal)
  let response
  try {
    response = await fetch(`${API_BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: headers(active.accessToken, 'text/event-stream'),
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
  id: 'raccoon',
  name: 'Raccoon Work',
  capabilities: {
    listModels: true,
    chat: true,
    balance: true,
    checkin: false,
    refresh: true,
    // The daily 300 points are granted server-side with no endpoint to call, so
    // a check-in button would fail on every press.
    checkinBlockedReason: 'the daily allowance is granted server-side with no endpoint to call',
  },
  findCredential,
  listModels,
  chat,
  balance,
  login,
  logout,
}

export const providers = [provider]
