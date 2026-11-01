/**
 * OAuth 2.0 Device Grant + PKCE, shared by every channel that signs in this way.
 *
 * ## Why a device-code flow
 *
 * The channels here are desktop/CLI products. Their own sign-in opens a browser
 * and hands the result back to a loopback listener the product owns. This
 * package has no listener of its own to hand back to, and it must not pretend
 * to be the product. The device grant is the flow the *upstream* publishes for
 * exactly this situation: ask for a code, show the user a URL and a short code,
 * poll until they approve. Nothing is impersonated and no challenge is solved.
 *
 * ## The three details that make it work
 *
 * 1. **`code_verifier` must be persisted with the device code.** PKCE binds the
 *    two: the token exchange compares the verifier's S256 against the challenge
 *    sent at request time. Losing it between the two calls makes the exchange
 *    fail with a message that says nothing about PKCE.
 * 2. **"Still waiting" arrives in two shapes.** Some servers answer
 *    `200 {status:"pending"}`; others answer non-200 with
 *    `error:"authorization_pending"`. Treating a status code as the signal
 *    reports a failure the instant the user has not clicked yet.
 * 3. **`slow_down` accumulates.** The server asks for a longer interval, and
 *    the new interval must be carried across polls rather than reset each time.
 *
 * @module pi-connect-free/src/device-login
 */

import { randomBytes, createHash } from 'node:crypto'

import { FreeModelError, KIND } from './providers/types.js'

/** RFC 7636: a 43–128 character URL-safe verifier. 32 bytes → 43 base64url chars. */
export function createPkce() {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** base64url without padding — the form PKCE and JWT segments use. */
export function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Ask for a device code.
 *
 * @param {object} options
 * @param {string} options.what         channel name, for error text
 * @param {string} options.deviceUrl    the device-authorization endpoint
 * @param {string} options.clientId
 * @param {string} [options.scope]
 * @param {string} [options.audience]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{deviceCode: string, codeVerifier: string, userCode: string, verificationUri: string, verificationUriComplete: string, expiresInSec: number, intervalSec: number}>}
 */
export async function requestDeviceCode(options) {
  const { what, deviceUrl, clientId, scope, audience, signal, fetchImpl = fetch } = options
  const pkce = createPkce()
  const body = new URLSearchParams({
    client_id: clientId,
    ...(scope === undefined ? {} : { scope }),
    ...(audience === undefined ? {} : { audience }),
    code_challenge: pkce.challenge,
    // The literal `S256`. A server that receives anything else compares the
    // challenge as plaintext and the exchange can never succeed.
    code_challenge_method: 'S256',
  })
  let response
  try {
    response = await fetchImpl(deviceUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    })
  } catch (error) {
    throw new FreeModelError(KIND.transport, `${what} device-code request failed: ${error?.message ?? error}`, { cause: error })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new FreeModelError(
      KIND.auth,
      `${what} device-code request was refused (HTTP ${response.status})${text === '' ? '' : ` — ${text.slice(0, 200)}`}`,
      { status: response.status },
    )
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new FreeModelError(KIND.server, `${what} device-code response is not JSON`)
  }
  const deviceCode = str(payload.device_code)
  const userCode = str(payload.user_code)
  const verificationUri = str(payload.verification_uri) || str(payload.verification_url)
  const expiresInSec = num(payload.expires_in)
  if (deviceCode === '' || userCode === '' || verificationUri === '' || expiresInSec === undefined) {
    throw new FreeModelError(
      KIND.server,
      `${what} device-code response is missing device_code / user_code / verification_uri / expires_in`,
    )
  }
  return {
    deviceCode,
    codeVerifier: pkce.verifier,
    userCode,
    verificationUri,
    verificationUriComplete: str(payload.verification_uri_complete) || verificationUri,
    expiresInSec,
    // Seconds, per the spec. The default only applies when the server omits it.
    intervalSec: num(payload.interval) ?? 5,
  }
}

/**
 * Poll once for the result of a device authorization.
 *
 * Returns `pending` for both "still waiting" shapes and for a transport
 * failure: a dropped connection is not evidence that the user refused, and
 * reporting it as a terminal failure would abort a sign-in that is still in
 * progress. `intervalSec` in the result is the interval to use next — the
 * caller writes it back, because `slow_down` asks for a cumulative increase.
 *
 * @param {object} options
 * @param {string} options.what
 * @param {string} options.tokenUrl
 * @param {string} options.clientId
 * @param {{deviceCode: string, codeVerifier: string, intervalSec: number}} options.auth
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{kind:'pending', intervalSec:number} | {kind:'success', grant:object} | {kind:'failed', message:string}>}
 */
export async function pollDeviceToken(options) {
  const { what, tokenUrl, clientId, auth, signal, fetchImpl = fetch } = options
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: auth.deviceCode,
    client_id: clientId,
    // Without the verifier the server cannot match the challenge it was sent.
    code_verifier: auth.codeVerifier,
  })
  let response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    })
  } catch {
    return { kind: 'pending', intervalSec: auth.intervalSec }
  }
  let payload = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  const status = str(payload.status)
  const error = str(payload.error)

  if (response.ok && status === 'pending') return { kind: 'pending', intervalSec: auth.intervalSec }
  if (response.ok && status === 'slow_down') return { kind: 'pending', intervalSec: auth.intervalSec + 5 }
  if (response.ok && (status === 'denied' || status === 'access_denied')) {
    return { kind: 'failed', message: 'authorization was denied; start the sign-in again' }
  }
  if (response.ok && (status === 'expired' || status === 'expired_token')) {
    return { kind: 'failed', message: 'the device code expired; start the sign-in again' }
  }
  if (error === 'authorization_pending') return { kind: 'pending', intervalSec: auth.intervalSec }
  if (error === 'slow_down') return { kind: 'pending', intervalSec: auth.intervalSec + 5 }
  if (error === 'access_denied') return { kind: 'failed', message: 'authorization was denied; start the sign-in again' }
  if (error === 'expired_token') return { kind: 'failed', message: 'the device code expired; start the sign-in again' }

  if (response.ok && str(payload.access_token) !== '') return { kind: 'success', grant: payload }

  return {
    kind: 'failed',
    message: `${what} authorization failed: ${error !== '' ? error : `HTTP ${response.status}`}`,
  }
}

/**
 * Run a device-code sign-in to completion.
 *
 * `onPrompt` is called once with the URL and short code, so the caller decides
 * how to show them (a panel, a toast, a printed line). Progress is reported
 * through `onStatus` if given. The whole flow honours `signal`.
 *
 * @param {object} options
 * @param {string} options.what
 * @param {string} options.deviceUrl
 * @param {string} options.tokenUrl
 * @param {string} options.clientId
 * @param {string} [options.scope]
 * @param {string} [options.audience]
 * @param {(prompt: {userCode: string, verificationUri: string, verificationUriComplete: string, expiresInSec: number}) => void} options.onPrompt
 * @param {(status: string) => void} [options.onStatus]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object>} the token grant, raw
 */
export async function runDeviceLogin(options) {
  const { onPrompt, onStatus, signal, fetchImpl = fetch } = options
  const auth = await requestDeviceCode(options)
  onPrompt({
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    expiresInSec: auth.expiresInSec,
  })
  const deadline = Date.now() + auth.expiresInSec * 1000
  let intervalSec = auth.intervalSec
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new FreeModelError(KIND.aborted, `${options.what} sign-in was cancelled`)
    await sleep(intervalSec * 1000, signal)
    const outcome = await pollDeviceToken({ ...options, auth: { ...auth, intervalSec }, fetchImpl })
    if (outcome.kind === 'success') return outcome.grant
    if (outcome.kind === 'failed') throw new FreeModelError(KIND.auth, outcome.message)
    intervalSec = outcome.intervalSec
    onStatus?.('waiting for authorization')
  }
  throw new FreeModelError(KIND.timeout, `${options.what} sign-in timed out; start it again`)
}

/** Sleep that wakes early on abort. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new FreeModelError(KIND.aborted, 'cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new FreeModelError(KIND.aborted, 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Non-empty string, or `''`. */
export function str(value) {
  return typeof value === 'string' && value !== '' ? value : ''
}

/** Finite positive number, or `undefined`. */
export function num(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}
