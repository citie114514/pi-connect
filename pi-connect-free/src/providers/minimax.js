/**
 * The MiniMax Code channel.
 *
 * ## What is different about this one
 *
 * Three things, and each is a trap for a port that assumes OpenAI:
 *
 * 1. **Sign-in is a device grant, not a local token file.** The desktop client
 *    keeps `~/.minimax/auth/prod/cn/mcode-public/auth.json`, but that file is
 *    absent until the client has signed in, and it is the client's to write.
 *    The upstream publishes a device-code flow for exactly this case, so this
 *    channel signs in through it and stores the result itself. Nothing is
 *    impersonated.
 * 2. **The inference endpoint speaks Anthropic Messages, not OpenAI.** Its SSE
 *    frames are `{"type":"content_block_delta",...}` with no `choices` field, so
 *    forwarding them to an OpenAI client produces an empty answer with no
 *    error. They are translated here, at the edge.
 * 3. **The account host and the API host are different** and are not
 *    interchangeable: device codes and token exchange live on
 *    `account.minimax.cn`, everything else on `agent.minimax.cn`.
 *
 * @module pi-connect-free/providers/minimax
 */

import { FreeModelError, KIND } from './types.js'
import { getJson, readErrorBody, httpError } from '../http.js'
import { runDeviceLogin, str, num } from '../device-login.js'
import { readCredential, writeCredential, clearCredential, isExpired } from '../credential-store.js'

const WHAT = 'MiniMax'
const API_HOST = 'https://agent.minimax.cn'
const ACCOUNT_HOST = 'https://account.minimax.cn'
const DEVICE_CODE_PATH = '/oauth2/device/code'
const TOKEN_PATH = '/oauth2/token'
const INFER_PATH = '/mavis/api/v1/llm/v1/messages'
const MODELS_PATH = '/mavis/api/v1/models'

/** Published OAuth constants (from the client's own `auth.json` / asar). */
const CLIENT_ID = 'mcode-public'
const AUDIENCE = 'agent-backend'
/** The token exchange refuses a grant whose scope lacks this. */
const SCOPE = 'agent.default'

const REGION = 'cn'
const BUILD_ENV = 'prod'

/** Sign in through the device grant, and store the result. */
export async function login({ onPrompt, onStatus, signal } = {}) {
  const grant = await runDeviceLogin({
    what: WHAT,
    deviceUrl: `${ACCOUNT_HOST}${DEVICE_CODE_PATH}`,
    tokenUrl: `${ACCOUNT_HOST}${TOKEN_PATH}`,
    clientId: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
    onPrompt,
    onStatus,
    signal,
  })
  const accessToken = str(grant.access_token)
  if (accessToken === '') throw new FreeModelError(KIND.auth, `${WHAT} returned no access token`)
  // The grant's token type is checked rather than assumed: a server that
  // answers something other than `Bearer` would otherwise produce a credential
  // that fails on every later request.
  if (str(grant.token_type).toLowerCase() !== 'bearer') {
    throw new FreeModelError(KIND.auth, `${WHAT} returned a non-Bearer token type`)
  }
  if (!str(grant.scope).includes(SCOPE)) {
    throw new FreeModelError(KIND.auth, `${WHAT} granted a token without the ${SCOPE} scope`)
  }
  const expiresInSec = num(grant.expires_in)
  if (expiresInSec === undefined) throw new FreeModelError(KIND.auth, `${WHAT} returned no token lifetime`)
  const accountId = str(grant.account_id) || str(grant.accountId)
  const credential = {
    provider: 'minimax',
    uid: accountId === '' ? `token:${accessToken.slice(-12)}` : accountId,
    accessToken,
    refreshToken: str(grant.refresh_token),
    expiresAt: Date.now() + expiresInSec * 1000,
    nickname: 'MiniMax Code',
    source: 'app',
    extras: { scope: str(grant.scope) },
  }
  writeCredential('minimax', credential)
  return credential
}

/** Forget this channel's stored sign-in. */
export function logout() {
  clearCredential('minimax')
}

/** The stored credential, if this machine has signed in. */
export async function findCredential() {
  const credential = readCredential('minimax')
  if (credential === undefined) return undefined
  return credential
}

/** Bearer headers for the business host. */
function businessHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  }
}

/**
 * List the roster.
 *
 * The endpoint requires `region` and `buildEnv` explicitly; without them it
 * answers with an empty list rather than an error, which would look like an
 * account with no models.
 */
export async function listModels(credential, signal) {
  if (isExpired(credential)) {
    throw new FreeModelError(KIND.auth, `${WHAT} token has expired; sign in again`)
  }
  const url = `${API_HOST}${MODELS_PATH}?region=${REGION}&buildEnv=${BUILD_ENV}`
  const document = await getJson(url, { headers: businessHeaders(credential.accessToken), signal, what: `${WHAT} model listing` })
  const entries = Array.isArray(document?.data) ? document.data : Array.isArray(document?.models) ? document.models : []
  const models = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.id) || str(entry.model)
    if (id === '') continue
    models.push({
      id,
      name: str(entry.name) || id,
      contextWindow: num(entry.context_window) ?? num(entry.contextWindow) ?? 0,
      maxOutput: num(entry.max_output_tokens) ?? num(entry.maxOutput) ?? 0,
      supportsImage: entry.vision === true || entry.supports_image === true,
      isFree: entry.is_free === true || entry.isFree === true,
    })
  }
  if (models.length === 0) throw new FreeModelError(KIND.empty, `${WHAT} published no models`)
  return models
}

/**
 * Translate an OpenAI chat body into the Anthropic Messages shape.
 *
 * Exported because the translation is the part that silently breaks: a body
 * that looks right but carries `role:'system'` inside `messages`, or omits
 * `max_tokens` (which Anthropic requires), is rejected with a 400 that does not
 * say which of the two was wrong.
 *
 * @param {Record<string, unknown>} body
 * @param {string} model
 */
export function toAnthropicPayload(body, model) {
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const systemParts = []
  const dialogue = []
  for (const raw of rawMessages) {
    if (typeof raw !== 'object' || raw === null) continue
    const role = str(raw.role)
    if (role === 'system') {
      const text = typeof raw.content === 'string'
        ? raw.content
        : Array.isArray(raw.content)
          ? raw.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).filter((t) => t !== '').join('\n')
          : ''
      if (text.trim() !== '') systemParts.push(text)
      continue
    }
    dialogue.push(raw)
  }
  const payload = {
    model,
    stream: true,
    messages: dialogue.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message.content === 'string' ? message.content : message.content,
    })),
  }
  // Anthropic requires `system` at the top level, not as a message.
  if (systemParts.length > 0) payload.system = systemParts.join('\n\n')
  // `max_tokens` is mandatory on this endpoint; without it the request is
  // rejected outright rather than defaulted.
  const requested = num(body.max_tokens) ?? num(body.max_completion_tokens)
  if (requested !== undefined) payload.max_tokens = requested
  const temperature = num(body.temperature)
  if (temperature !== undefined) payload.temperature = temperature
  if (Array.isArray(body.stop) && body.stop.length > 0) {
    payload.stop_sequences = body.stop.filter((item) => typeof item === 'string')
  }
  return payload
}

/**
 * Send one turn and translate its stream.
 *
 * The upstream answers Anthropic SSE. Those frames are rewritten into OpenAI
 * chat-completion chunks here; passing them through unchanged would give the
 * client an answer with no `choices`, which reads as an empty reply and throws
 * no error at all.
 */
export async function chat(credential, request) {
  if (isExpired(credential)) {
    throw new FreeModelError(KIND.auth, `${WHAT} token has expired; sign in again`)
  }
  const payload = toAnthropicPayload(request.body ?? {}, request.model)
  let response
  try {
    response = await fetch(`${API_HOST}${INFER_PATH}`, {
      method: 'POST',
      headers: { ...businessHeaders(credential.accessToken), accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: request.signal,
    })
  } catch (error) {
    if (request.signal?.aborted === true || error?.name === 'AbortError') {
      throw new FreeModelError(KIND.aborted, `${WHAT} request was aborted`, { cause: error })
    }
    throw new FreeModelError(KIND.transport, `${WHAT} request failed: ${error?.message ?? error}`, { cause: error })
  }
  if (!response.ok) throw httpError(`${WHAT} request`, response, await readErrorBody(response))
  if (response.body === null) throw new FreeModelError(KIND.empty, `${WHAT} answered 200 with no body`)
  return new Response(anthropicToOpenAiSse(response.body, request.model), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/**
 * Rewrite an Anthropic Messages SSE stream into OpenAI chat-completion chunks.
 *
 * The mapping is small but exact: `content_block_delta`/`text_delta` is the
 * answer, `thinking_delta` is reasoning, `message_stop` is the end, and an
 * `error` event is a failure that must not be reported as a finished turn.
 *
 * @param {ReadableStream<Uint8Array>} upstream
 * @param {string} model
 */
export function anthropicToOpenAiSse(upstream, model) {
  const encoder = new TextEncoder()
  const id = `chatcmpl-${Date.now().toString(36)}`
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        controller.enqueue(encoder.encode(frame({ role: 'assistant', content: '' })))
        while (true) {
          const read = await reader.read()
          if (read.done) break
          buffer += decoder.decode(read.value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue
              const raw = line.slice(5).trim()
              if (raw === '' || raw === '[DONE]') continue
              let event
              try {
                event = JSON.parse(raw)
              } catch {
                continue
              }
              if (event.type === 'content_block_delta') {
                const delta = event.delta ?? {}
                if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
                  controller.enqueue(encoder.encode(frame({ content: delta.text })))
                } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
                  controller.enqueue(encoder.encode(frame({ reasoning_content: delta.thinking })))
                }
              } else if (event.type === 'message_delta') {
                const reason = event.delta?.stop_reason
                if (typeof reason === 'string' && reason !== '') {
                  controller.enqueue(encoder.encode(frame({}, reason === 'max_tokens' ? 'length' : 'stop')))
                }
              } else if (event.type === 'error') {
                // An error event must surface as an error frame; ending the
                // stream here would show a truncated answer as a complete one.
                const message = event.error?.message ?? 'upstream error'
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'server', code: 'server' } })}\n\n`))
              }
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'server', code: 'server' } })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        await reader.cancel().catch(() => {})
        controller.close()
      }
    },
  })
}

/** @type {import('./types.js').Provider} */
export const provider = {
  id: 'minimax',
  name: 'MiniMax Code',
  capabilities: {
    listModels: true,
    chat: true,
    balance: false,
    checkin: true,
    refresh: false,
    balanceBlockedReason: 'the quota endpoint answers with a business code inside a 200, and this package has no verified reading of it yet',
    refreshBlockedReason: 'the device grant issues no refresh token; sign in again when the token expires',
  },
  findCredential,
  listModels,
  chat,
  login,
  logout,
}

export const providers = [provider]
