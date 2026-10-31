/**
 * The Qoder channels (domestic and international), as free-model providers.
 *
 * Qoder's protocol is already implemented and tested in `pi-connect-qoder`:
 * credential discovery (the 0.3.x `auth.v1.dat` layout plus the legacy
 * `state.vscdb`), the COSY wire encoding, the loop-request handling and the
 * catalog normalisation. None of that is repeated here — this module is the
 * thin seam that presents those two regions through the free-model contract.
 *
 * Reusing rather than re-porting is deliberate. A second copy of the COSY
 * signing would drift the first time either package changed, and a signature
 * regression is invisible until a real turn fails.
 *
 * @module pi-connect-free/providers/qoder
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FreeModelError, KIND } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
/** Sibling package root; both live under the pi-extensions tree. */
const QODER_ROOT = join(here, '..', '..', '..', 'pi-connect-qoder')

/** Loaded once, on first use, so this module has no top-level side effects. */
let qoderModules

async function loadQoder() {
  if (qoderModules !== undefined) return qoderModules
  const credentialsUrl = new URL(`file:///${join(QODER_ROOT, 'lib', 'credentials.js').replace(/\\/g, '/')}`)
  const upstreamUrl = new URL(`file:///${join(QODER_ROOT, 'lib', 'upstream.js').replace(/\\/g, '/')}`)
  const entryUrl = new URL(`file:///${join(QODER_ROOT, 'lib', 'catalog-entry.js').replace(/\\/g, '/')}`)
  try {
    const [credentials, upstream, entry] = await Promise.all([
      import(credentialsUrl.href),
      import(upstreamUrl.href),
      import(entryUrl.href),
    ])
    qoderModules = { credentials, upstream, entry }
    return qoderModules
  } catch (error) {
    throw new FreeModelError(
      KIND.unsupported,
      `the Qoder channels need the pi-connect-qoder package next to this one (${QODER_ROOT})`,
      { cause: error },
    )
  }
}

/** Region descriptor for one Qoder variant. */
const REGION_IDS = { 'qoder-cn': 'Qoder CN', qoder: 'Qoder' }

/**
 * Find this machine's sign-in for one Qoder region.
 *
 * Reads the same stores the vendor's own app writes — nothing is fabricated and
 * nothing is refreshed here. An expired token is reported as expired rather
 * than silently renewed, because renewal is `refresh()`'s job and the caller
 * decides whether to spend a round trip on it.
 *
 * @param {string} regionId
 * @returns {Promise<import('./types.js').ProviderCredential|undefined>}
 */
async function findCredential(regionId) {
  const { credentials } = await loadQoder()
  const region = credentials.REGIONS.find((candidate) => candidate.id === regionId)
  if (region === undefined) return undefined
  const appRoot = process.env.APPDATA ?? ''
  let credential
  try {
    credential = await credentials.loadCredential(region, appRoot)
  } catch {
    credential = undefined
  }
  if (credential === undefined) {
    try {
      credential = await credentials.loadEnvCredential(region)
    } catch {
      credential = undefined
    }
  }
  if (credential === undefined || typeof credential.token !== 'string' || credential.token === '') return undefined
  return {
    provider: regionId,
    uid: typeof credential.userID === 'string' && credential.userID !== '' ? credential.userID : regionId,
    accessToken: credential.token,
    refreshToken: typeof credential.refreshToken === 'string' ? credential.refreshToken : '',
    expiresAt: Number(credential.expiresAt) || 0,
    nickname: typeof credential.name === 'string' && credential.name !== '' ? credential.name : REGION_IDS[regionId],
    source: credential.source === 'env-pat' ? 'env' : 'app',
    extras: {
      ...(typeof credential.email === 'string' && credential.email !== '' ? { email: credential.email } : {}),
      ...(typeof credential.machineID === 'string' && credential.machineID !== '' ? { machineID: credential.machineID } : {}),
    },
  }
}

/**
 * List one region's catalog through the existing client.
 *
 * `normalizeEntry` is the same projection the Qoder package uses for its own
 * picker, so the free-model listing and that picker cannot disagree about what
 * a model's window or free status is.
 *
 * @param {string} regionId
 * @param {import('./types.js').ProviderCredential} credential
 * @param {AbortSignal} [signal]
 */
async function listModels(regionId, credential, signal) {
  const { credentials, upstream, entry } = await loadQoder()
  const region = credentials.REGIONS.find((candidate) => candidate.id === regionId)
  if (region === undefined) throw new FreeModelError(KIND.unsupported, `unknown Qoder region: ${regionId}`)
  const raw = await upstream.fetchModels(region, credential, signal)
  const models = raw.map(entry.normalizeEntry).map((row) => ({
    id: row.id,
    name: row.name === '' ? row.id : row.name,
    // `defaultContextWindow` is what the catalog advertises; `maxInputTokens`
    // is the per-request floor. Reporting the floor as the window would make
    // every model look smaller than it is.
    contextWindow: Number(row.defaultContextWindow) || Number(row.maxInputTokens) || 0,
    maxOutput: 0,
    supportsImage: row.isVL === true,
    isFree: row.isFree === true,
    ...(row.priceFactor > 0 ? { priceFactor: row.priceFactor } : {}),
    ...(row.isReasoning === true && row.effortLevels.length > 0
      ? { reasoning: true, reasoningEfforts: row.effortLevels }
      : row.isReasoning === true
        ? { reasoning: true }
        : {}),
  }))
  if (models.length === 0) throw new FreeModelError(KIND.empty, `${REGION_IDS[regionId]} published no models`)
  return models
}

/**
 * Send one turn through the existing chat generator.
 *
 * `streamChat` yields OpenAI-shaped chunks as an async generator, so this
 * adapter folds them back into a `Response` whose body the caller streams —
 * the shape every other channel here reports, without a second converter whose
 * framing could drift from the first.
 *
 * @param {string} regionId
 * @param {import('./types.js').ProviderCredential} credential
 * @param {import('./types.js').ChatRequest} request
 */
async function chat(regionId, credential, request) {
  const { credentials, upstream } = await loadQoder()
  const region = credentials.REGIONS.find((candidate) => candidate.id === regionId)
  if (region === undefined) throw new FreeModelError(KIND.unsupported, `unknown Qoder region: ${regionId}`)
  const body = request.body ?? {}
  // `streamChat` takes the structured request the Qoder package's own shim
  // builds, not a raw OpenAI body: it sends the user-facing id directly (the
  // model id *is* the upstream name for this lane) and it decides
  // `enable_thinking` from that flag rather than from a bare reasoning value.
  const askedEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  const enableThinking = askedEffort !== undefined
    ? askedEffort !== 'off' && askedEffort !== 'none'
    : body.thinking === undefined
      ? false
      : body.thinking !== false && body.thinking !== 'off'
  const parsed = {
    model: request.model,
    messages: body.messages ?? [],
    tools: body.tools,
    maxTokens: Number.isSafeInteger(body.max_tokens) ? body.max_tokens : undefined,
    enableThinking,
    alwaysThinking: false,
    reasoningEffort: enableThinking ? askedEffort : undefined,
    sessionId: typeof body.user === 'string' ? body.user : undefined,
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of upstream.streamChat(region, credential, parsed, request.signal)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (error) {
        const kind = error?.kind ?? KIND.server
        const message = error?.message ?? String(error)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: { message, type: kind, code: kind } })}\n\n`),
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/**
 * Build the provider object for one region.
 *
 * @param {string} regionId
 * @returns {import('./types.js').Provider}
 */
export function createQoderProvider(regionId) {
  const name = REGION_IDS[regionId] ?? regionId
  return {
    id: regionId,
    name,
    capabilities: {
      listModels: true,
      chat: true,
      balance: true,
      checkin: true,
      refresh: false,
      refreshBlockedReason: 'Qoder rotates tokens itself when the app is used; re-signing in is the only renewal this package performs',
    },
    findCredential: () => findCredential(regionId),
    listModels: (credential, signal) => listModels(regionId, credential, signal),
    chat: (credential, request) => chat(regionId, credential, request),
  }
}

export const providers = Object.keys(REGION_IDS).map(createQoderProvider)
