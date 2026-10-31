/**
 * Transport helpers shared by every channel.
 *
 * A channel's job is its protocol; everything that is the same regardless of
 * protocol lives here — timeouts that cannot be forgotten, error classification
 * that cannot drift between channels, and an SSE reader that copes with the two
 * shapes upstreams actually send.
 *
 * @module pi-connect-free/http
 */

import { FreeModelError, KIND, kindForStatus } from './providers/types.js'

/** Default ceiling for a listing call. */
export const LIST_TIMEOUT_MS = 15000

/** Default idle ceiling for a stream: every chunk resets it. */
export const STREAM_IDLE_TIMEOUT_MS = 300000

/**
 * Compose a caller's abort signal with a timeout.
 *
 * `AbortSignal.any` is available in every Node this package supports (22.19+),
 * but the *reason* still has to be distinguished after the fact: a caller who
 * hit Ctrl-C must not be reported as an upstream timeout. The wrapper keeps
 * that flag rather than guessing from the error name later.
 *
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, dispose: () => void }}
 */
export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

/**
 * Turn whatever `fetch` threw into a `FreeModelError`.
 *
 * The three cases that matter are "the caller cancelled" (not an error of the
 * upstream's making), "the clock ran out", and "the network refused" — the last
 * one keeps the cause because `ECONNREFUSED` and `ENOTFOUND` send the user to
 * completely different fixes (start the app / fix the proxy).
 *
 * @param {unknown} error
 * @param {{ signal?: AbortSignal, timedOut?: () => boolean, what: string }} context
 * @returns {FreeModelError}
 */
export function transportError(error, { signal, timedOut, what }) {
  if (timedOut?.() === true || error?.name === 'TimeoutError') {
    return new FreeModelError(KIND.timeout, `${what} timed out`, { cause: error })
  }
  if (signal?.aborted === true || error?.name === 'AbortError') {
    return new FreeModelError(KIND.aborted, `${what} was aborted`, { cause: error })
  }
  const cause = error?.cause ?? error
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : ''
  return new FreeModelError(KIND.transport, `${what} failed: ${cause?.message ?? cause}${code}`, { cause: error })
}

/**
 * Read a response body as text with a bound.
 *
 * Error bodies are small in every protocol this package speaks, so capping the
 * read keeps a misbehaving upstream from turning an error path into a memory
 * event.
 *
 * @param {Response} response
 * @param {number} [limit]
 */
export async function readErrorBody(response, limit = 4096) {
  try {
    const text = await response.text()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  } catch {
    return ''
  }
}

/**
 * Classify a non-2xx response.
 *
 * The upstream's own message is preserved whenever the body carries one, in the
 * shapes seen across these channels: OpenAI's `{error:{message}}`, a bare
 * `{message}`, or a plain string body. Losing that text is what makes a
 * channel's failures undiagnosable.
 *
 * @param {string} what
 * @param {Response} response
 * @param {string} [body]
 * @returns {FreeModelError}
 */
export function httpError(what, response, body = '') {
  const status = response.status
  let message = ''
  if (body !== '') {
    try {
      const parsed = JSON.parse(body)
      const fromJson =
        parsed?.error?.message ??
        parsed?.error?.msg ??
        parsed?.message ??
        parsed?.msg ??
        (typeof parsed?.error === 'string' ? parsed.error : undefined)
      if (typeof fromJson === 'string' && fromJson !== '') message = fromJson
    } catch {
      message = body
    }
  }
  const retryAfter = Number(response.headers.get('retry-after'))
  return new FreeModelError(
    kindForStatus(status),
    `${what} failed: HTTP ${status}${message === '' ? '' : ` — ${message.slice(0, 300)}`}`,
    {
      status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: Math.trunc(retryAfter * 1000) } : {}),
    },
  )
}

/**
 * Read an SSE body, yielding each `data:` payload.
 *
 * Two upstream behaviours make a naive `for await (line)` loop wrong:
 *
 * - A gateway under load may answer a stream request with one JSON document
 *   and an `application/json` content type. Deciding from the *body* rather
 *   than the header keeps that turn usable instead of failing it.
 * - Comment lines (`: keep-alive`) and blank lines are framing, not payload.
 *   `data: [DONE]` ends the stream and is not yielded.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} signal
 * @param {number} idleTimeoutMs
 * @yields {string} one payload per `data:` line
 */
export async function* readSse(body, signal, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let timer

  /**
   * A promise that only ever rejects, once the stream is past its deadline or
   * the caller cancelled.
   *
   * The listener is installed before any read starts, so a deadline that fires
   * while `reader.read()` is outstanding still wins the race. Binding it inside
   * the race (as an earlier version did) missed exactly that case — which is
   * the whole point of an idle timeout, since an idle stream is one whose read
   * never resolves.
   */
  let expire
  const expired = new Promise((_, reject) => {
    expire = reject
  })
  // Keep the rejection handled for every code path that does not await it.
  expired.catch(() => {})

  const fail = () =>
    signal?.aborted === true
      ? new FreeModelError(KIND.aborted, 'stream was aborted')
      : new FreeModelError(KIND.timeout, 'stream went idle')

  const onCallerAbort = () => expire(fail())
  signal?.addEventListener('abort', onCallerAbort, { once: true })

  const resetIdle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => expire(fail()), idleTimeoutMs)
    timer.unref?.()
  }
  resetIdle()

  try {
    while (true) {
      const read = await Promise.race([reader.read(), expired])
      if (read.done) break
      resetIdle()
      buffer += decoder.decode(read.value, { stream: true })
      // Frames are separated by a blank line; a payload may itself span several
      // `data:` lines (multi-line data), which the SSE spec concatenates.
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data === '') continue
        if (data === '[DONE]') return
        yield data
      }
    }
    // A stream that ends without a trailing blank line still owes its last frame.
    const tail = buffer
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (tail !== '' && tail !== '[DONE]') yield tail
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
    await reader.cancel().catch(() => {})
  }
}

/**
 * POST a JSON body and hand back the parsed document.
 *
 * @param {string} url
 * @param {{ body: unknown, headers?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number, what: string, fetchImpl?: typeof fetch }} options
 */
export async function postJson(url, options) {
  const { body, headers = {}, signal, timeoutMs = LIST_TIMEOUT_MS, what, fetchImpl = fetch } = options
  const bound = withTimeout(signal, timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: bound.signal,
      })
    } catch (error) {
      throw transportError(error, { signal, timedOut: bound.timedOut, what })
    }
    if (!response.ok) throw httpError(what, response, await readErrorBody(response))
    try {
      return await response.json()
    } catch (error) {
      throw new FreeModelError(KIND.server, `${what} returned a body that is not JSON`, { cause: error, status: response.status })
    }
  } finally {
    bound.dispose()
  }
}

/**
 * GET a JSON document.
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number, what: string, fetchImpl?: typeof fetch }} options
 */
export async function getJson(url, options) {
  const { headers = {}, signal, timeoutMs = LIST_TIMEOUT_MS, what, fetchImpl = fetch } = options
  const bound = withTimeout(signal, timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(url, { headers, redirect: 'error', signal: bound.signal })
    } catch (error) {
      throw transportError(error, { signal, timedOut: bound.timedOut, what })
    }
    if (!response.ok) throw httpError(what, response, await readErrorBody(response))
    try {
      return await response.json()
    } catch (error) {
      throw new FreeModelError(KIND.server, `${what} returned a body that is not JSON`, { cause: error, status: response.status })
    }
  } finally {
    bound.dispose()
  }
}

/**
 * Re-shape an upstream SSE stream into the OpenAI chat-completion frames Pi
 * expects, passing each frame through as it arrives.
 *
 * Translating rather than buffering is the whole point: a turn that streams
 * upstream must stream to the user, or the first token arrives only after the
 * last one. `map` returns the OpenAI `data:` payload(s) for one upstream
 * payload — an empty array drops the frame.
 *
 * @param {Response} upstream
 * @param {(payload: string) => unknown[] | string[] | undefined} map
 * @param {{ signal?: AbortSignal, idleTimeoutMs?: number }} [options]
 * @returns {Response}
 */
export function sseToOpenAi(upstream, map, { signal, idleTimeoutMs } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const payload of readSse(upstream.body, signal, idleTimeoutMs)) {
          let frames
          try {
            frames = map(payload)
          } catch {
            // One unparseable frame must not end a turn that is otherwise fine.
            continue
          }
          if (frames === undefined) continue
          for (const frame of Array.isArray(frames) ? frames : [frames]) {
            const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
            controller.enqueue(encoder.encode(`data: ${text}\n\n`))
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (error) {
        // Never finish a broken stream with [DONE]: that tells the client the
        // answer completed, so a half-written reply is shown as a whole one.
        const message = error instanceof FreeModelError ? error.message : String(error)
        const kind = error instanceof FreeModelError ? error.kind : KIND.server
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: { message, type: kind, code: kind } })}\n\n`),
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}
