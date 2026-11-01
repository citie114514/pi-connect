/**
 * Pi slash commands for the channels that sign in themselves.
 *
 * ## Why these are commands and not automatic
 *
 * A sign-in needs a human: someone has to open a URL, type a short code, scan a
 * QR, or approve a browser prompt. Nothing about that can happen silently, so
 * the entry point has to be something the user types. Each command prints the
 * one thing the user must do next, then waits.
 *
 * ## The three prompt shapes
 *
 * - **Device code** (Cline, MiniMax): a URL plus a short code to type into it.
 * - **Browser callback** (LobsterAI, CodeArts): a URL; the local listener
 *   catches the redirect, so the user only approves.
 * - **QR scan** (Raccoon): a URL to render or open; the phone does the rest.
 *
 * The channel decides which one it needs and calls `onPrompt` with that shape.
 * This module does not need to know: it prints whatever it is handed.
 *
 * @module pi-connect-free/commands
 */

/**
 * Render one prompt argument as text a terminal can show.
 *
 * A QR is rendered as its URL rather than as a picture: a terminal QR is
 * unreadable at most font sizes, and the URL opens the same page in a browser
 * that the phone would have scanned.
 *
 * @param {unknown} prompt
 */
export function describePrompt(prompt) {
  if (typeof prompt === 'string') return prompt
  if (typeof prompt !== 'object' || prompt === null) return String(prompt)
  const record = prompt
  if (typeof record.userCode === 'string') {
    // Device grant: the complete URI already carries the code, so showing both
    // means the user can either click or type.
    const url = typeof record.verificationUriComplete === 'string'
      ? record.verificationUriComplete
      : record.verificationUri
    return `打开 ${url}\n然后输入短码：${record.userCode}`
  }
  return JSON.stringify(record)
}

/**
 * Register the sign-in commands.
 *
 * @param {object} pi the Pi extension API
 * @param {Map<string, Function>} login  channel id → login({onPrompt, signal})
 * @param {Map<string, Function>} logout channel id → logout()
 * @param {(channelId: string) => string} labelFor display name for a channel id
 */
export function registerFreeCommands(pi, login, logout, labelFor) {
  const ids = [...login.keys()]

  pi.registerCommand?.('free-login', {
    description: `登录免费模型渠道（可用：${ids.join(' / ')}）`,
    handler: async (args, ctx) => {
      const requested = String(args ?? '').trim().split(/\s+/).filter((part) => part !== '')
      if (requested.length === 0) {
        const lines = ids.map((id) => `  ${id} — ${labelFor(id)}`)
        ctx.ui.notify(
          `用法：/free-login <渠道>\n\n可登录的渠道：\n${lines.join('\n')}\n\n例：/free-login minimax`,
          'info',
        )
        return
      }
      const channelId = requested[0]
      const signIn = login.get(channelId)
      if (signIn === undefined) {
        ctx.ui.notify(`没有名为 ${channelId} 的登录渠道。可用：${ids.join(', ')}`, 'warning')
        return
      }
      const controller = new AbortController()
      try {
        ctx.ui.notify(`${labelFor(channelId)}: 正在发起登录…`, 'info')
        const credential = await signIn({
          signal: controller.signal,
          onPrompt: (prompt) => {
            ctx.ui.notify(`${labelFor(channelId)} 登录\n\n${describePrompt(prompt)}`, 'info')
          },
          onStatus: (status) => {
            // Only the transitions that matter are shown; a poll loop that
            // printed every tick would bury the prompt above it.
            if (status === 'waiting for authorization') return
            ctx.ui.notify(`${labelFor(channelId)}: ${status}`, 'info')
          },
        })
        const who = typeof credential?.nickname === 'string' && credential.nickname !== ''
          ? credential.nickname
          : channelId
        ctx.ui.notify(`${labelFor(channelId)}: 登录成功（${who}）`, 'info')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`${labelFor(channelId)}: 登录失败 — ${message}`, 'warning')
      }
    },
  })

  pi.registerCommand?.('free-logout', {
    description: '退出免费模型渠道的登录',
    handler: async (args, ctx) => {
      const channelId = String(args ?? '').trim()
      if (channelId === '') {
        ctx.ui.notify(`用法：/free-logout <渠道>\n\n可退出：${[...logout.keys()].join(', ') || '(无)'}`, 'info')
        return
      }
      const signOut = logout.get(channelId)
      if (signOut === undefined) {
        ctx.ui.notify(`没有名为 ${channelId} 的可退出渠道`, 'warning')
        return
      }
      try {
        await signOut()
        ctx.ui.notify(`${labelFor(channelId)}: 已退出登录`, 'info')
      } catch (error) {
        ctx.ui.notify(`${labelFor(channelId)}: 退出失败 — ${error instanceof Error ? error.message : String(error)}`, 'warning')
      }
    },
  })

  pi.registerCommand?.('free-status', {
    description: '查看各免费模型渠道的登录与模型数量',
    handler: async (_args, ctx) => {
      const ids = [...new Set([...login.keys(), ...logout.keys()])]
      if (ids.length === 0) {
        ctx.ui.notify('本包没有需要登录的渠道', 'info')
        return
      }
      const lines = ids.map((id) => `  ${id} — ${labelFor(id)}`)
      ctx.ui.notify(
        `需要登录的渠道：\n${lines.join('\n')}\n\n用 /free-login <渠道> 登录`,
        'info',
      )
    },
  })
}
