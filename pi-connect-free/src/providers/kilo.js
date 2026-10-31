/**
 * The Kilo channel: a public free pool that needs no credential at all.
 *
 * This is the simplest lane in the package and the only one whose upstream
 * published it for anonymous use — `GET /models` returns a roster with an
 * `isFree` flag per entry, and `POST /chat/completions` answers the free slice
 * without a key, a login, or any client identification. That absence of
 * identification is exactly why it is here: nothing about these requests has to
 * pretend to be something it is not.
 *
 * The trade is stated on the gateway's own model cards and belongs in front of
 * the user rather than buried in a doc: **prompts sent to the free pool may be
 * logged by the upstream provider and used to improve its services.** This lane
 * is for throwaway work, not for secrets.
 *
 * @module pi-connect-free/providers/kilo
 */

import { FreeModelError, KIND } from './types.js'
import { getJson, httpError, postJson, readErrorBody } from '../http.js'

/** Overridable so tests and probes can aim at a dead port instead of real quota. */
export const KILO_BASE = (process.env.PI_CONNECT_FREE_KILO_BASE ?? 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '')

const WHAT = 'Kilo'

/** The lane is keyless; the credential only carries its own shape. */
const ANONYMOUS = Object.freeze({
  provider: 'kilo',
  uid: 'anonymous',
  accessToken: '',
  expiresAt: 0,
  nickname: 'Kilo free pool',
  source: 'anonymous',
})

/**
 * Read the roster and keep only the free slice.
 *
 * Everything else on this gateway is a paid id that would answer 401 here, so
 * listing it would put models in the picker that this lane cannot serve.
 *
 * @param {object} credential
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('./types.js').ProviderModel[]>}
 */
export async function listModels(credential = ANONYMOUS, signal) {
  const document = await getJson(`${KILO_BASE}/models`, {
    headers: { accept: 'application/json', 'user-agent': 'pi-connect-free' },
    signal,
    what: `${WHAT} model listing`,
  })
  const entries = Array.isArray(document?.data) ? document.data : Array.isArray(document) ? document : []
  const models = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id === '') continue
    // Absent `isFree` means "the gateway did not say"; only an explicit false
    // is a paid id. Treating absence as paid would hide the whole pool if the
    // gateway ever renames the field.
    if (entry.isFree === false) continue
    const context = Number(entry.context_length ?? entry.contextLength ?? entry.context_window ?? 0)
    const maxOutput = Number(entry.max_completion_tokens ?? entry.maxOutputTokens ?? 0)
    models.push({
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      contextWindow: Number.isFinite(context) && context > 0 ? context : 0,
      maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 0,
      supportsImage: entry.modality === 'multimodal' || entry.supports_vision === true || entry.supportsImage === true,
      isFree: entry.isFree !== false,
    })
  }
  if (models.length === 0) {
    // An empty roster is a real answer on this lane (the pool can be empty for
    // an egress), but it must not be reported as a successful list of nothing.
    throw new FreeModelError(KIND.empty, `${WHAT} published no free models`)
  }
  return models
}

/**
 * POST one turn and hand back the upstream stream untouched.
 *
 * The caller converts SSE to OpenAI frames; this layer only ensures the request
 * is well-formed and that a refusal arrives as a classified error rather than a
 * stream that ends before producing anything.
 *
 * @param {object} credential
 * @param {import('./types.js').ChatRequest} request
 */
export async function chat(credential = ANONYMOUS, request) {
  const { model, body, signal } = request
  const payload = { ...body, model, stream: body?.stream !== false }
  const response = await postJsonStreamed(`${KILO_BASE}/chat/completions`, payload, signal)
  return response
}

/** A POST that returns the live `Response` instead of a parsed document. */
async function postJsonStreamed(url, payload, signal) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'pi-connect-free',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') {
      throw new FreeModelError(KIND.aborted, `${WHAT} request was aborted`, { cause: error })
    }
    const cause = error?.cause ?? error
    const code = typeof cause?.code === 'string' ? ` (${cause.code})` : ''
    throw new FreeModelError(KIND.transport, `${WHAT} request failed: ${cause?.message ?? cause}${code}`, { cause: error })
  }
  if (!response.ok) {
    const body = await readErrorBody(response)
    const failure = httpError(`${WHAT} request`, response, body)
    // A paid id requested on this lane is the caller asking for something this
    // channel does not serve — a request defect, not a broken credential store.
    if (/PAID_MODEL_AUTH_REQUIRED/i.test(body)) {
      return Promise.reject(
        new FreeModelError(
          KIND.client,
          'this model is not on the free pool: it needs a Kilo account, so this channel cannot serve it',
          { status: response.status },
        ),
      )
    }
    throw failure
  }
  if (response.body === null) throw new FreeModelError(KIND.empty, `${WHAT} returned no body`)
  return response
}

/** @type {import('./types.js').Provider} */
export const provider = {
  id: 'kilo',
  name: 'Kilo Free Pool',
  capabilities: {
    listModels: true,
    chat: true,
    balance: false,
    checkin: false,
    refresh: false,
    balanceBlockedReason: 'the free pool publishes no quota endpoint',
    checkinBlockedReason: 'the free pool has no daily check-in',
    refreshBlockedReason: 'the lane is keyless, so there is nothing to renew',
  },
  findCredential: async () => ANONYMOUS,
  listModels,
  chat,
}

/** The registry's uniform shape: one module, an array of channels. */
export const providers = [provider]
