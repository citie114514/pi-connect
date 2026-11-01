/**
 * pi-connect-free — Pi provider for free / already-signed-in model channels.
 *
 * ## What this package is
 *
 * Five channels, each reached through the credential you already have on this
 * machine (Qoder's desktop sign-in, TRAE's desktop/CLI sign-in) or through a
 * pool the upstream publishes for anonymous use (Kilo). Nothing here creates an
 * account, imports a key, or asks the user to paste a token.
 *
 * ## Why a loopback shim
 *
 * Pi's provider contract hands the agent a `baseUrl` and expects an
 * OpenAI-compatible endpoint behind it. These channels speak five different
 * private protocols, so each one is translated behind a single loopback server
 * that speaks OpenAI on the near side. That is the same shape the sibling
 * `pi-connect-qoder` / `pi-connect-trae` packages use, for the same reason:
 * the agent never sees a vendor protocol, and the credential never leaves this
 * process.
 *
 * The shim binds `127.0.0.1` on an ephemeral port with a per-process random
 * bearer token. It is a convenience inside this process, not a network service.
 *
 * ## What is deliberately not here
 *
 * See `src/registry.js` — channels whose free tier only answers clients that
 * imitate the vendor's own CLI, and channels whose sign-in automates a
 * human-verification challenge. Both defeat an access control the upstream is
 * actively making; neither is implemented.
 *
 * @module pi-connect-free
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { loadProviders, providerById, EXCLUDED_CHANNELS } from './src/registry.js'
import { FreeModelError, KIND } from './src/providers/types.js'

/** Prefix every registered provider id carries, so the picker groups them. */
const ID_PREFIX = 'free-'

/** Keep quiet unless asked: Pi's TUI owns the terminal. */
function createLogger() {
  if (process.env.PI_CONNECT_DEBUG !== '1') {
    return { info: () => {}, warn: () => {}, error: (m, d) => console.error(`[pi-connect-free] ${m}`, d ?? '') }
  }
  return {
    info: (m) => console.info(`[pi-connect-free] ${m}`),
    warn: (m, d) => console.warn(`[pi-connect-free] ${m}`, d ?? ''),
    error: (m, d) => console.error(`[pi-connect-free] ${m}`, d ?? ''),
  }
}

/** Where this package keeps its own state, next to the sibling packages. */
function ownDir() {
  return join(homedir(), '.pi', 'agent', 'cache', 'pi-connect-free')
}

/**
 * One cached roster per channel, so a new process lists models synchronously.
 *
 * Pi reads the model list before any network call is guaranteed to have
 * finished — `--list-models`, the startup picker, and `/scoped-models` all read
 * synchronously. Without a disk cache those reads only ever see whatever the
 * current process happened to discover, which is why a cold start shows an
 * empty picker.
 */
function cachePath(channelId) {
  return join(ownDir(), `catalog-${channelId}.json`)
}

function loadCachedCatalog(channelId) {
  const path = cachePath(channelId)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== 1) return undefined
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return undefined
    return parsed.models
  } catch {
    return undefined
  }
}

function saveCachedCatalog(channelId, models) {
  const path = cachePath(channelId)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(ownDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), models }, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    // Best effort: a failed write only costs a cold start.
    try {
      if (existsSync(tmp)) writeFileSync(tmp, '')
    } catch {}
  }
}

/**
 * The loopback server one channel is served through.
 *
 * Routes are the two Pi needs: `GET /v1/models` and `POST /v1/chat/completions`.
 * Everything else is 404, and a request without the bearer token is 401 before
 * any upstream work happens — an unauthenticated request must never be able to
 * spend the user's quota.
 */
class ChannelShim {
  /**
   * @param {import('./src/providers/types.js').Provider} channel
   * @param {{ logger: ReturnType<typeof createLogger>, refresh: (signal?: AbortSignal) => Promise<void> }} options
   */
  constructor(channel, { logger, refresh }) {
    this.channel = channel
    this.logger = logger
    this.refresh = refresh
    this.secret = randomBytes(32).toString('base64url')
    this.server = undefined
    this.ready = undefined
  }

  start() {
    if (this.server !== undefined) return this.ready
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.warn(`${this.channel.id}: shim request failed`, error)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(error), type: 'internal' } }))
        } else if (!res.writableEnded) {
          res.end()
        }
      })
    })
    // Pi's extension contract forbids holding the process open: a session-less
    // invocation (`pi --list-models`) must be able to exit.
    server.unref()
    this.server = server
    this.ready = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return this.ready
  }

  baseUrl() {
    const address = this.server?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error(`${this.channel.id} shim is not listening`)
    }
    return `http://127.0.0.1:${address.port}`
  }

  /** Constant-time bearer comparison; a length leak is still a leak. */
  authorized(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const actual = Buffer.from(match[1])
    const expected = Buffer.from(this.secret)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async handle(req, res) {
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'missing or invalid bearer', type: 'unauthorized' } }))
      return
    }
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'GET' && url === '/v1/models') {
      const credential = await this.channel.findCredential()
      if (credential === undefined) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `${this.channel.name} is not signed in on this machine`, type: 'not_signed_in' } }))
        return
      }
      const models = this.cachedModels()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: this.channel.id })),
      }))
      return
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      await this.chat(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no such route: ${req.method} ${url}`, type: 'not_found' } }))
  }

  cachedModels() {
    return this.catalog ?? []
  }

  async chat(req, res) {
    let credential
    try {
      credential = await this.channel.findCredential()
    } catch (error) {
      this.writeFailure(res, KIND.auth, error instanceof Error ? error.message : String(error))
      return
    }
    if (credential === undefined) {
      this.writeFailure(res, KIND.auth, `${this.channel.name} is not signed in on this machine`)
      return
    }
    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'))
    } catch (error) {
      this.writeFailure(res, KIND.client, `body is not JSON: ${String(error)}`)
      return
    }
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    try {
      const upstream = await this.channel.chat(credential, {
        model: typeof body.model === 'string' ? body.model : '',
        body,
        signal: controller.signal,
      })
      // A directory refresh is only ever started here, after the turn has been
      // accepted: it must never delay the answer the user is waiting for.
      void this.refresh().catch(() => {})
      await pipeUpstream(upstream, res, body.stream !== false)
    } catch (error) {
      if (error instanceof FreeModelError) {
        this.writeFailure(res, error.kind, error.message, error.status)
        return
      }
      this.writeFailure(res, KIND.server, error instanceof Error ? error.message : String(error))
    }
  }

  writeFailure(res, kind, message, status) {
    if (res.headersSent) {
      // The stream already started, so the failure travels in-band as a `data:`
      // frame: emitting [DONE] without an error would show a half answer as a
      // complete one.
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: kind, code: kind } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
      return
    }
    const code = status ?? (kind === KIND.auth ? 401 : kind === KIND.rate ? 429 : kind === KIND.client ? 400 : 502)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message, type: kind, code: kind } }))
  }

  async close() {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    this.ready = undefined
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

/** Read a request body with a bound, so a large prompt cannot exhaust memory. */
function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new FreeModelError(KIND.client, 'request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Forward an upstream response to the waiting client, preserving its framing. */
async function pipeUpstream(upstream, res, streaming) {
  const contentType = upstream.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for await (const chunk of upstream.body) {
      res.write(chunk)
    }
    res.end()
    return
  }
  // A channel that answered one JSON document: hand it back as-is when the
  // caller did not ask for a stream, otherwise wrap it in a single SSE frame so
  // the client's SSE parser still sees the shape it expects.
  const text = await upstream.text()
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(`data: ${text}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(text)
}

/**
 * Build the Pi provider descriptor for one channel.
 *
 * @param {import('./src/providers/types.js').Provider} channel
 * @param {ChannelShim} shim
 */
function createPiProvider(channel, shim) {
  const providerId = `${ID_PREFIX}${channel.id}`
  const displayName = channel.name
  return {
    id: providerId,
    name: displayName,
    baseUrl: undefined,
    auth: {
      apiKey: {
        name: `${displayName} loopback shim token`,
        async check() {
          // Never start a socket for a channel with no sign-in: a session-less
          // `pi --list-models` must not open listeners for channels the user
          // does not have.
          try {
            const credential = await channel.findCredential()
            return credential === undefined ? undefined : { type: 'api_key', source: displayName }
          } catch {
            return undefined
          }
        },
        async resolve() {
          const credential = await channel.findCredential().catch(() => undefined)
          if (credential === undefined) return undefined
          await shim.start()
          return { auth: { apiKey: shim.secret, baseUrl: `${shim.baseUrl()}/v1` }, source: displayName }
        },
      },
    },
    getModels: () => shim.cachedModels().map((model) => ({
      id: model.id,
      name: model.name,
      api: 'openai-completions',
      provider: providerId,
      baseUrl: shim.baseUrlForModels(),
      input: model.supportsImage ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(model.reasoning === true ? { reasoning: true } : {}),
      ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    })),
    refreshModels: async (context) => {
      if (context.stored?.models?.length) {
        await context.publish({
          persist: { models: context.stored.models, checkedAt: context.stored.checkedAt },
          update: () => {},
        })
      }
      if (!context.allowNetwork || context.signal.aborted) return
      await shim.refresh(context.signal).catch(() => {})
      if (context.signal.aborted) return
      await context.publish({
        persist: { models: shim.cachedModels().map((model) => ({
          id: model.id,
          name: model.name,
          api: 'openai-completions',
          provider: providerId,
          baseUrl: shim.baseUrlForModels(),
          input: model.supportsImage ? ['text', 'image'] : ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...(model.reasoning === true ? { reasoning: true } : {}),
          ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
        })), checkedAt: Date.now() },
        update: () => {},
      })
    },
  }
}

// ── Pi entry point ───────────────────────────────────────────────────────────

/** @param {object} pi the Pi extension host */
export default async function activate(pi) {
  const logger = createLogger()

  let providers = []
  let failures = []
  try {
    const loaded = await loadProviders()
    providers = loaded.providers
    failures = loaded.failures
  } catch (error) {
    logger.error('channel registry failed to load; no free-model providers will be registered', error)
    return
  }
  for (const failure of failures) {
    logger.warn(`channel ${failure.id} is unavailable: ${failure.reason}`)
  }
  if (providers.length === 0) {
    logger.error('no free-model channel could be loaded')
    return
  }
  registerAuth(providers)

  const shims = new Map()
  for (const channel of providers) {
    let catalog = loadCachedCatalog(channel.id) ?? []
    const shim = new ChannelShim(channel, {
      logger,
      refresh: async (signal) => {
        const credential = await channel.findCredential().catch(() => undefined)
        if (credential === undefined) return
        const listed = await channel.listModels(credential, signal)
        shim.catalog = listed
        saveCachedCatalog(channel.id, listed)
      },
    })
    shim.catalog = catalog
    shim.baseUrlForModels = () => {
      try {
        return `${shim.baseUrl()}/v1`
      } catch {
        return 'http://127.0.0.1:0/v1'
      }
    }
    shims.set(channel.id, shim)
    pi.registerProvider(createPiProvider(channel, shim))
    logger.info(`registered ${ID_PREFIX}${channel.id} with ${catalog.length} cached models`)
  }

  // Warm on a real session only: a session-less invocation must not open
  // sockets, and a channel with no sign-in must stay completely inert.
  pi.on?.('session_start', async () => {
    await Promise.all(
      providers.map(async (channel) => {
        const shim = shims.get(channel.id)
        try {
          const credential = await channel.findCredential()
          if (credential === undefined) return
          await shim.start()
          await shim.refresh()
        } catch (error) {
          logger.warn(`${channel.id}: warm-up failed`, error)
        }
      }),
    )
    void failures
  })

  pi.on?.('session_shutdown', async () => {
    await Promise.all([...shims.values()].map((shim) => shim.close()))
  })
}

/**
 * The sign-in functions this package exposes, keyed by channel id.
 *
 * A channel that ships its own `login()` is reachable through this map; a
 * channel whose credential comes from another app (Qoder, TRAE) has none and is
 * absent, rather than offered as a button that could only fail.
 *
 * @type {Map<string, (options: {onPrompt?: (arg: any) => void, signal?: AbortSignal}) => Promise<object>>}
 */
export const LOGIN = new Map()

/** Forget one channel's stored sign-in, if it owns one. */
export async function logout(channelId) {
  const signIn = LOGOUT.get(channelId)
  if (signIn === undefined) return false
  await signIn()
  return true
}

/** @type {Map<string, () => void>} */
const LOGOUT = new Map()

/**
 * Register the sign-in/logout entry points for every channel that has them.
 *
 * Called from `activate`, so the maps are populated exactly once per process and
 * only with channels that actually loaded.
 *
 * @param {import('./src/providers/types.js').Provider[]} providers
 */
export function registerAuth(providers) {
  for (const channel of providers) {
    if (typeof channel.login === 'function') LOGIN.set(channel.id, channel.login)
    if (typeof channel.logout === 'function') LOGOUT.set(channel.id, channel.logout)
  }
}

export { EXCLUDED_CHANNELS }
