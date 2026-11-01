/**
 * The channel registry.
 *
 * Every channel is loaded lazily and independently: one channel's missing
 * dependency or broken credential file must not stop the others from being
 * offered. The registry therefore reports what loaded *and* what did not, so
 * the panel can say "Cline is unavailable because its package is missing"
 * instead of silently showing a shorter list.
 *
 * @module pi-connect-free/registry
 */

/**
 * @typedef {object} ChannelFailure
 * @property {string} id
 * @property {string} name
 * @property {string} reason
 */

/**
 * Channels whose protocol lives in this package.
 *
 * Each entry is a module that exports `providers` (an array). Channels that
 * reuse a sibling package's protocol are listed here too — the module itself is
 * still local, it just delegates the wire.
 *
 * Channels absent from this list are absent on purpose. The two classes this
 * package does not implement are documented in `providers/types.js`: channels
 * that only work by imitating another vendor's client, and channels whose
 * sign-in needs a browser driven through a human-verification challenge.
 */
const MODULES = [
  { id: 'kilo', name: 'Kilo Free Pool', path: './providers/kilo.js' },
  { id: 'cline', name: 'Cline', path: './providers/cline.js' },
  { id: 'codearts', name: 'CodeArts', path: './providers/codearts.js' },
  { id: 'lobsterai', name: 'LobsterAI', path: './providers/lobsterai.js' },
  { id: 'minimax', name: 'MiniMax Code', path: './providers/minimax.js' },
  { id: 'qoder', name: 'Qoder', path: './providers/qoder.js' },
  { id: 'raccoon', name: 'Raccoon Work', path: './providers/raccoon.js' },
  { id: 'trae', name: 'TRAE', path: './providers/trae.js' },
]

/**
 * Load every channel.
 *
 * @returns {Promise<{ providers: import('./providers/types.js').Provider[], failures: ChannelFailure[] }>}
 */
export async function loadProviders() {
  const providers = []
  const failures = []
  for (const entry of MODULES) {
    try {
      const module = await import(entry.path)
      const loaded = Array.isArray(module.providers) ? module.providers : []
      if (loaded.length === 0) throw new Error('the module exported no providers')
      providers.push(...loaded)
    } catch (error) {
      failures.push({
        id: entry.id,
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { providers, failures }
}

/**
 * Find one provider by id, or `undefined`.
 *
 * @param {import('./providers/types.js').Provider[]} providers
 * @param {string} id
 */
export function providerById(providers, id) {
  return providers.find((provider) => provider.id === id)
}

/**
 * The channels this package knows about but deliberately does not implement,
 * with the reason stated where a user can read it.
 *
 * Keeping this list explicit is what stops "why is channel X missing?" from
 * being answered with a guess later: the answer is here, and it is a policy
 * decision rather than an oversight.
 */
export const EXCLUDED_CHANNELS = Object.freeze([
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    reason:
      'its free tier only answers clients that imitate the vendor’s own CLI (forged User-Agent, a session id the server decodes back into a timestamp, and re-declared tools the request never sent). That defeats an access-control check the upstream is actively making, so this package does not implement it.',
  },
  {
    id: 'gemini',
    name: 'Gemini (Cloud Code Assist)',
    reason:
      'reaching it requires reproducing another vendor client byte for byte — five identity headers, no extra headers, and alphabetically ordered JSON so the request is indistinguishable from that client. Same class as OpenCode Zen: the upstream is deciding who is calling, and the answer would be a fiction.',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    reason:
      'its sign-in drives a browser through a human-verification challenge. This package does not automate challenge solving.',
  },
])
