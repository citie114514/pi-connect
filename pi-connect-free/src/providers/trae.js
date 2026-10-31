/**
 * The TRAE channels (domestic and international), as free-model providers.
 *
 * Like the Qoder adapter next to this one, the protocol is not re-implemented:
 * `pi-connect-trae/lib/trae-core.js` already owns credential discovery, the
 * SOLO wire format, the directory merge and the SSE decode. This module is the
 * seam that presents those regions through the free-model contract.
 *
 * The SOLO directory is split across modes: a model is only callable through
 * the function that lists it, and one function failing must not take the other
 * function's models with it. `fetchModelsDetailed` reports that split, and the
 * listing below keeps the models it did get.
 *
 * @module pi-connect-free/providers/trae
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FreeModelError, KIND } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const TRAE_ROOT = join(here, '..', '..', '..', 'pi-connect-trae')

const REGION_IDS = { cn: 'TRAE CN', ai: 'TRAE Global' }

let traeCore

async function loadTrae() {
  if (traeCore !== undefined) return traeCore
  const url = new URL(`file:///${join(TRAE_ROOT, 'lib', 'trae-core.js').replace(/\\/g, '/')}`)
  try {
    traeCore = await import(url.href)
    return traeCore
  } catch (error) {
    throw new FreeModelError(
      KIND.unsupported,
      `the TRAE channels need the pi-connect-trae package next to this one (${TRAE_ROOT})`,
      { cause: error },
    )
  }
}

/**
 * One credential store per region, reused across calls.
 *
 * The store keeps the refreshed token in a plugin-owned file, so building a new
 * one per call would discard that and refresh on every turn.
 */
const stores = new Map()

async function storeFor(region) {
  const existing = stores.get(region)
  if (existing !== undefined) return existing
  const core = await loadTrae()
  const store = new core.TraeCredentialStore({
    region,
    edition: 'auto',
    refresh: async (credential) => core.refreshTraeCredential(credential),
  })
  stores.set(region, store)
  return store
}

/**
 * Find this machine's TRAE sign-in for one region.
 *
 * Uses `current()` rather than `resolve()` on purpose: `resolve()` may start a
 * token refresh, and the refresh path asks for a device identity, which asks
 * the store for a credential again — a re-entrant call that waits on the very
 * refresh it would have to finish. `current()` is a plain local read, so an
 * expired token is reported as expired and the caller decides what to do.
 *
 * @param {string} region
 * @returns {Promise<import('./types.js').ProviderCredential|undefined>}
 */
async function findCredential(region) {
  const store = await storeFor(region)
  let credential
  try {
    credential = await store.current()
  } catch {
    return undefined
  }
  if (credential === undefined) return undefined
  if (typeof credential.accessToken !== 'string' || credential.accessToken === '') return undefined
  return {
    provider: `trae-${region}`,
    uid: typeof credential.userId === 'string' && credential.userId !== '' ? credential.userId : region,
    accessToken: credential.accessToken,
    refreshToken: typeof credential.refreshToken === 'string' ? credential.refreshToken : '',
    expiresAt: Number(credential.expiresAtMs) || 0,
    nickname: REGION_IDS[region] ?? region,
    source: credential.source === 'cli' ? 'cli' : 'app',
    extras: {
      ...(typeof credential.edition === 'string' ? { edition: credential.edition } : {}),
      ...(typeof credential.accountName === 'string' && credential.accountName !== '' ? { accountName: credential.accountName } : {}),
    },
  }
}

/** Build the upstream clients a region needs, from the same credential store. */
async function clientsFor(region) {
  const core = await loadTrae()
  const store = await storeFor(region)
  const identity = async () => {
    const credential = await store.current()
    const candidates = store.candidates()
    try {
      return await core.resolveTraeIdentity(
        credential === undefined ? [] : candidates.filter((c) => c.edition === credential.edition),
        region === 'ai' ? 'solo-sg' : 'cn',
      )
    } catch {
      return undefined
    }
  }
  return {
    core,
    store,
    identity,
    solo: new core.TraeSoloUpstreamClient({
      credential: () => store.resolve(),
      identity,
      log: () => {},
    }),
    remote: new core.TraeSoloRemoteCatalogClient({ credential: () => store.resolve() }),
  }
}

/**
 * List one region's directory.
 *
 * Both sources are merged the same way the TRAE package does: the remote
 * directory is the skeleton and the SOLO roster supplies the callable
 * `config_name` per model. A partial SOLO answer still lists callable models,
 * so it is kept rather than discarded.
 *
 * @param {string} region
 * @param {import('./types.js').ProviderCredential} credential
 * @param {AbortSignal} [signal]
 */
async function listModels(region, credential, signal) {
  const { core, solo, remote } = await clientsFor(region)
  const [remoteResult, soloResult] = await Promise.all([
    remote.fetchModels(signal).then((models) => ({ models }), () => ({ models: [] })),
    (typeof solo.fetchModelsDetailed === 'function'
      ? solo.fetchModelsDetailed(signal).then((result) => ({ models: result.models }), () => ({ models: [] }))
      : solo.fetchModels(signal).then((models) => ({ models }), () => ({ models: [] }))),
  ])
  let merged = core.mergeTraeModelSources(remoteResult.models, soloResult.models)
  if (merged.length === 0 && soloResult.models.length > 0) {
    // The remote skeleton is gone but the roster is not: those entries are
    // exactly the models the bridge can call, so serve them without the
    // skeleton's display extras rather than reporting an empty region.
    merged = soloResult.models.map((model) => ({ ...model, input: ['text'] }))
  }
  if (merged.length === 0) {
    const detail = credential.expiresAt !== 0 && credential.expiresAt < Date.now()
      ? ' (the stored token has expired; open TRAE and sign in again)'
      : ''
    throw new FreeModelError(KIND.auth, `${REGION_IDS[region]} published no models${detail}`)
  }
  return merged.map((model) => ({
    id: model.id,
    name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
    contextWindow: Number(model.maxContextWindow) || Number(model.contextWindow) || 0,
    maxOutput: 0,
    supportsImage: Array.isArray(model.input) ? model.input.includes('image') : false,
    isFree: true,
    ...(model.reasoning !== undefined
      ? {
          reasoning: true,
          ...(Array.isArray(model.reasoning?.supported) ? { reasoningEfforts: model.reasoning.supported } : {}),
        }
      : {}),
  }))
}

/**
 * Stream one turn.
 *
 * TRAE speaks its own SOLO event stream; `TraeDelegatingUpstreamClient` is the
 * bridge that turns it into OpenAI chunks, and the TRAE package's shim already
 * proves that path end to end. This reuses the bridge directly instead of
 * standing up a loopback socket per turn.
 *
 * @param {string} region
 * @param {import('./types.js').ProviderCredential} credential
 * @param {import('./types.js').ChatRequest} request
 */
async function chat(region, credential, request) {
  const { core, solo, identity, store } = await clientsFor(region)
  const catalog = new core.TraeCatalog(region)
  const wire = { byId: new Map(), byName: new Map(), callableKeys: new Set(), resolved: false }
  try {
    const listed = await listModels(region, credential, request.signal)
    catalog.set(
      listed.map((model) => ({
        id: model.id,
        name: model.name,
        input: model.supportsImage ? ['text', 'image'] : ['text'],
        ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      })),
    )
    // The wire map is what turns a display id into the callable `config_name`;
    // without it the request would be forwarded under the display id and the
    // upstream answers `4001 param is invalid`.
    const detailed = typeof solo.fetchModelsDetailed === 'function' ? await solo.fetchModelsDetailed(request.signal) : { models: await solo.fetchModels(request.signal) }
    for (const model of detailed.models) {
      const target = {
        configName: typeof model.id === 'string' && model.id !== '' ? model.id : model.name,
        ...(typeof model.function === 'string' ? { function: model.function } : {}),
      }
      wire.byId.set(model.id, target)
      wire.byName.set(String(model.name ?? '').trim().toLowerCase(), target)
    }
    wire.resolved = wire.byId.size > 0
  } catch {
    // A directory failure must not prevent the turn: the caller already named a
    // model, and the bridge falls back to that name when the map is empty.
  }
  void identity
  void store
  const bridge = new core.TraeSoloBridge(solo, catalog, (displayId) =>
    wire.byId.get(displayId) ?? wire.byName.get(String(displayId ?? '').trim().toLowerCase()),
  )
  const delegating = new core.TraeDelegatingUpstreamClient(bridge)
  const body = JSON.stringify({ ...(request.body ?? {}), model: request.model, stream: request.body?.stream !== false })
  const result = await delegating.chatStream(body, request.signal)
  if (!result.ok) {
    throw new FreeModelError(result.kind ?? KIND.server, result.message ?? `${REGION_IDS[region]} rejected the request`)
  }
  return result.response
}

/**
 * Build the provider object for one region.
 *
 * @param {string} region
 * @returns {import('./types.js').Provider}
 */
export function createTraeProvider(region) {
  const id = `trae-${region}`
  return {
    id,
    name: REGION_IDS[region] ?? id,
    capabilities: {
      listModels: true,
      chat: true,
      balance: true,
      checkin: true,
      refresh: true,
    },
    findCredential: () => findCredential(region),
    listModels: (credential, signal) => listModels(region, credential, signal),
    chat: (credential, request) => chat(region, credential, request),
  }
}

export const providers = Object.keys(REGION_IDS).map(createTraeProvider)
