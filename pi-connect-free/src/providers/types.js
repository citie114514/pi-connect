/**
 * The provider contract for pi-connect-free.
 *
 * ## Why this layer exists
 *
 * Every channel in this package is a different private protocol with a
 * different way of finding its credential. Putting those branches behind one
 * interface keeps the Pi entry point from turning into a switch statement, and
 * — more importantly — makes "what this channel can and cannot do" a declared
 * fact rather than something the user discovers by watching a request fail.
 *
 * ## Scope this package holds itself to
 *
 * A channel qualifies only when its credential comes from **a sign-in the user
 * already performed on this machine** (a desktop app's token file, a CLI's
 * dotfile) or is **published for anonymous use by the upstream itself**. Two
 * classes are deliberately absent:
 *
 * - Channels that authenticate by imitating another vendor's client — forging
 *   the User-Agent, minting a session id the server decodes back into a
 *   timestamp, or re-declaring tools the caller never sent. Those defeat an
 *   access-control decision the upstream is actively making, they break every
 *   time that decision is retuned, and they are not this package's business.
 * - Channels whose sign-in requires driving a browser through a human-verification
 *   challenge. Same reason, plus it silently turns a model plugin into an
 *   automation harness.
 *
 * `capabilities` exists so that the absence of a feature is *legible*: a channel
 * that cannot sign in says why, instead of failing at request time.
 *
 * @module pi-connect-free/providers/types
 */

/**
 * One channel's credential, normalised.
 *
 * `extras` is a bounded escape hatch for fields a single channel needs that the
 * common shape has no slot for (a machine id, a device fingerprint the upstream
 * persists). Anything the main flow depends on belongs in a typed field instead
 * — `extras` loses type checking.
 *
 * @typedef {object} ProviderCredential
 * @property {string} provider  channel id, matching `Provider.id`
 * @property {string} uid       stable per-account id, used as the storage key
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiresAt  epoch ms; `0` means "unknown / does not expire"
 * @property {string} [nickname]
 * @property {Record<string, string>} [extras]
 * @property {'app'|'cli'|'env'|'anonymous'} [source] where the credential came from
 */

/**
 * What one channel can actually do.
 *
 * Every flag must be honest. Claiming a capability the channel lacks makes the
 * user believe something works until it fails; denying one it has hides
 * something that does. The `*BlockedReason` strings are what the panel shows,
 * so they have to say **what to do**, not merely "unsupported".
 *
 * @typedef {object} ProviderCapabilities
 * @property {boolean} listModels
 * @property {boolean} chat
 * @property {boolean} balance
 * @property {boolean} checkin
 * @property {boolean} refresh      can an expired token be renewed in place?
 * @property {string} [listModelsBlockedReason]
 * @property {string} [chatBlockedReason]
 * @property {string} [balanceBlockedReason]
 * @property {string} [checkinBlockedReason]
 * @property {string} [refreshBlockedReason]
 */

/**
 * One model as this package reports it, independent of any channel's shape.
 *
 * `contextWindow` and `maxOutput` are `0` when the channel did not publish
 * them. That is deliberately not a guess: a made-up window silently truncates
 * conversations, while a zero is visibly "unknown".
 *
 * @typedef {object} ProviderModel
 * @property {string} id
 * @property {string} name
 * @property {number} contextWindow
 * @property {number} maxOutput
 * @property {boolean} supportsImage
 * @property {boolean} isFree
 * @property {number} [priceFactor]
 * @property {boolean} [reasoning]         accepts a reasoning-effort control
 * @property {string[]} [reasoningEfforts] the values that control accepts
 */

/**
 * A chat turn, already normalised to the OpenAI shape by the caller.
 *
 * @typedef {object} ChatRequest
 * @property {string} model   the model id **without** any `channel/` prefix
 * @property {Record<string, unknown>} body  OpenAI-shaped request body
 * @property {AbortSignal} signal
 */

/**
 * A normalised failure.
 *
 * `kind` is what the caller branches on; `message` is what a human reads. The
 * message must never contain the credential — a channel is free to include the
 * upstream's own error text, which is usually the only useful part.
 *
 * @typedef {object} ProviderError
 * @property {'auth'|'quota'|'rate'|'client'|'server'|'transport'|'timeout'|'empty'|'aborted'|'unsupported'} kind
 * @property {string} message
 * @property {number} [status]      upstream HTTP status, when there was one
 * @property {number} [retryAfterMs]
 * @property {Error} [cause]
 */

/** Failure kinds, so callers do not compare against bare strings. */
export const KIND = Object.freeze({
  auth: 'auth',
  quota: 'quota',
  rate: 'rate',
  client: 'client',
  server: 'server',
  transport: 'transport',
  timeout: 'timeout',
  empty: 'empty',
  aborted: 'aborted',
  unsupported: 'unsupported',
})

/**
 * The error every channel throws. Plain `Error` with fields, so `instanceof`
 * survives the bundling and re-throwing that happens across modules.
 */
export class FreeModelError extends Error {
  /**
   * @param {string} kind one of {@link KIND}
   * @param {string} message human-readable; must not contain credentials
   * @param {{ status?: number, retryAfterMs?: number, cause?: Error }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message)
    this.name = 'FreeModelError'
    this.kind = kind
    if (detail.status !== undefined) this.status = detail.status
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs
    if (detail.cause !== undefined) this.cause = detail.cause
  }
}

/**
 * Map an HTTP status onto a failure kind.
 *
 * Kept as one function so every channel classifies the same way; a 429 that
 * one channel reports as `server` and another as `rate` makes the caller's
 * retry logic quietly inconsistent.
 *
 * @param {number} status
 * @returns {string} one of {@link KIND}
 */
export function kindForStatus(status) {
  if (status === 401 || status === 403) return KIND.auth
  if (status === 402) return KIND.quota
  if (status === 429) return KIND.rate
  if (status === 408 || status === 504) return KIND.timeout
  if (status >= 500) return KIND.server
  if (status >= 400) return KIND.client
  return KIND.server
}

/**
 * A channel.
 *
 * Implementations own their protocol and their error text, and nothing else:
 * account pooling, cooldown and retry belong to the caller. Every method either
 * answers or throws `FreeModelError` — returning an empty list or a stub body
 * to signal failure is the one behaviour that reliably costs an afternoon of
 * debugging later.
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name
 * @property {ProviderCapabilities} capabilities
 * @property {() => Promise<ProviderCredential|undefined>} findCredential
 *   locate this machine's sign-in for the channel; `undefined` means "not signed in"
 * @property {(credential: ProviderCredential, signal?: AbortSignal) => Promise<ProviderModel[]>} listModels
 * @property {(credential: ProviderCredential, request: ChatRequest) => Promise<Response>} chat
 *   the upstream response, unparsed; the caller converts it to OpenAI frames
 * @property {(credential: ProviderCredential, signal?: AbortSignal) => Promise<object>} [balance]
 * @property {(credential: ProviderCredential, signal?: AbortSignal) => Promise<object>} [checkin]
 * @property {(credential: ProviderCredential, signal?: AbortSignal) => Promise<ProviderCredential>} [refresh]
 */
