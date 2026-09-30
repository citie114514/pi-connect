/**
 * IDE 账号桥接 — Cyrene plugin entry.
 *
 * Brings the accounts already signed in on this machine's Qoder and Trae
 * desktop apps into Cyrene, with no OAuth flow and no API key to paste. Each
 * region runs a loopback HTTP server that speaks the OpenAI wire protocol and
 * translates to that region's own upstream protocol on the way out, so Cyrene
 * reaches it as an ordinary "OpenAI 兼容" model profile.
 *
 * The protocol layers under `./qoder/lib` and `./trae/lib` are reused verbatim
 * from the DeepSeek Harness plugins (`@eghrhegpe/dsh-connect-qoder`,
 * `dsh-connect-trae`) through their Pi ports; only the host-facing shell is new
 * here. See THIRD_PARTY_NOTICES.md for attribution.
 *
 * ## What the host sees
 *
 * - Four loopback endpoints, one per signed-in region: `qoder-cn`, `qoder`,
 *   `trae`, `trae-global`. The panel shows each one's base URL and bearer
 *   token; the user pastes them into a Cyrene model profile.
 * - Three tools. `usage` is read-only. `checkin` changes account state on the
 *   upstream side and therefore demands an explicit `confirm` argument.
 * - One private IPC surface for the panel.
 *
 * ## Credential handling
 *
 * The Qoder and Trae desktop apps' own sign-in state is read through
 * OSCrypt/DPAPI (Windows) — no OAuth is started and no application file is
 * written. The real upstream credential never leaves this process: Cyrene only
 * ever receives the shim's per-process random bearer token, which is worthless
 * outside the loopback socket.
 *
 * @module ide-account-bridge
 */
import { join } from 'node:path'
import { createEndpointStore } from './endpoints.js'
import { createQoderRuntimes } from './qoder/runtime.js'
import { createTraeStacks } from './trae/runtime.js'
import { qoderUsage, qoderCheckin } from './qoder/ops.js'
import { traeUsage, traeCheckin } from './trae/ops.js'
import { isCredentialUsable } from './qoder/lib/credentials.js'

/** Must match manifest.json's `id`; tools are prefixed with it. */
const PLUGIN_ID = 'ide-account-bridge'

/** Private IPC channels; the host namespaces them as `plugin:<id>:<channel>`. */
const IPC = {
  STATE: 'state',
  REFRESH: 'refresh',
  USAGE: 'usage',
  CHECKIN: 'checkin',
}

/**
 * Deadline for the activation warm-up (credential read + catalog fetch + shim).
 *
 * `ctx.signal` is not a deadline on its own — a plugin that is never disabled
 * never aborts it — so it is combined with a timeout instead of passed alone.
 */
const WARM_TIMEOUT_MS = 30000

/** Panel window geometry. */
const WINDOW_WIDTH = 780
const WINDOW_HEIGHT = 640

/** Region labels for the two providers that have no ops module of their own. */
const REGION_LABEL = {
  'qoder-cn': 'Qoder CN（国内版）',
  qoder: 'Qoder（国际版）',
  cn: 'Trae CN（国内版）',
  ai: 'Trae Global（国际版）',
}

/**
 * Adapt the host logger to the shape the ported protocol layers expect.
 *
 * `ctx.log` takes varargs and never throws; the layers call `warn(message,
 * detail)` and treat logging as best-effort, so a thin adapter is enough.
 */
function makeLogger(ctx) {
  const prefix = `[${PLUGIN_ID}]`
  return {
    info: (message) => ctx.log(`${prefix} ${message}`),
    warn: (message, detail) => ctx.log(`${prefix} WARN ${message}`, detail ?? ''),
    error: (message, detail) => ctx.log(`${prefix} ERROR ${message}`, detail ?? ''),
  }
}

/**
 * Everything one region can tell the panel.
 *
 * `ready` is false for a region with no usable sign-in: the shim is never
 * started for it, so the panel shows it as "未登录" instead of handing the user
 * a base URL that would answer 401 forever.
 */
function qoderRegionState(runtime) {
  const regionId = runtime.region.id
  return {
    group: 'qoder',
    regionId,
    label: REGION_LABEL[regionId] ?? regionId,
    ready: runtime.shim !== undefined,
    baseUrl: runtime.baseUrlOrPlaceholder(),
    token: runtime.shim?.token?.() ?? null,
    models: runtime.catalog.current().map((entry) => ({ id: entry.id, name: entry.name })),
  }
}

function traeRegionState(stack) {
  const regionId = stack.region
  return {
    group: 'trae',
    regionId,
    label: REGION_LABEL[regionId] ?? regionId,
    ready: stack.shim !== undefined,
    baseUrl: stack.baseUrlOrPlaceholder(),
    token: stack.shim?.token?.() ?? null,
    models: stack.catalog.current().map((entry) => ({ id: entry.id, name: entry.name })),
  }
}

/** The panel window, created lazily and reused while it lives. */
function createWindowManager(logger) {
  let win = null
  const close = () => {
    const target = win
    win = null
    if (!target) return
    try {
      if (!target.isDestroyed()) target.close()
    } catch (error) {
      logger.warn('关闭面板窗口失败', error instanceof Error ? error.message : String(error))
    }
  }
  const open = async (ctx) => {
    if (ctx.signal.aborted) return
    ctx.signal.addEventListener('abort', close, { once: true })
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore()
        win.focus()
      } catch (error) {
        logger.warn('聚焦面板窗口失败', error instanceof Error ? error.message : String(error))
      }
      return
    }
    win = null
    try {
      // `electron` is supplied by the host at runtime and is deliberately
      // required lazily: the entry must load cleanly in a bare directory that
      // has no Electron, which is how the self-containment check runs.
      const electron = require('electron')
      const created = new electron.BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: 620,
        minHeight: 480,
        title: 'IDE 账号桥接',
        autoHideMenuBar: true,
        backgroundColor: '#f4f6fb',
        // The panel is a trusted static page shipped inside the plugin and
        // talks to the plugin through ipcRenderer directly.
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      })
      created.webContents.on('will-navigate', (event) => event.preventDefault())
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.on('closed', () => {
        if (win === created) win = null
      })
      win = created
      await created.loadFile(join(__dirname, 'panel', 'index.html'))
      if (ctx.signal.aborted) close()
    } catch (error) {
      logger.warn('打开面板窗口失败', error instanceof Error ? error.message : String(error))
      close()
    }
  }
  return { open, close }
}

/**
 * State the host needs across `register()` / `open()` / `unregister()`.
 *
 * `open()` is invoked by the host directly, with no arguments, so the context
 * captured during registration is kept here. Cleared on dispose.
 */
let activeCtx = null
let winManagerRef = null

/** The plugin object the host loads. */
const plugin = {
  async register(ctx) {
    const logger = makeLogger(ctx)
    const cacheRoot = ctx.storage.rootDir()
    let qoderRuntimes = []
    let traeStacks = []
    let winManager = null

    // Ports and bearer tokens are persisted so a model profile keeps working
    // across restarts. The Pi port mints both per process, which is fine for a
    // session-scoped host but not for Cyrene, where the endpoint is copied into
    // a durable model profile.
    const endpoints = createEndpointStore({ path: join(cacheRoot, 'endpoints.json'), logger })

    try {
      qoderRuntimes = await createQoderRuntimes({ cacheRoot: join(cacheRoot, 'qoder'), logger, endpoints })
    } catch (error) {
      logger.error('Qoder 运行时初始化失败', error instanceof Error ? error.message : String(error))
    }
    try {
      traeStacks = await createTraeStacks({ cacheRoot: join(cacheRoot, 'trae'), logger, endpoints })
    } catch (error) {
      logger.error('Trae 运行时初始化失败', error instanceof Error ? error.message : String(error))
    }

    /** A deadline that also honours plugin shutdown. */
    const deadline = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(WARM_TIMEOUT_MS)])

    /**
     * Start the shims of every region that actually has a sign-in, and pull the
     * Qoder catalogs. Regions without a sign-in stay completely inert.
     *
     * Two deliberate choices:
     *
     * - **Eager, not deferred.** The Pi port waits for the first model request
     *   because its extension contract forbids opening sockets during
     *   activation. Cyrene has no such rule, and deferring would leave the panel
     *   with nothing to show until the user had already configured a model
     *   profile — a chicken-and-egg they cannot break.
     * - **Never awaited by `register`.** The host runs activation inside one
     *   global serial queue, so anything slow here stalls the entire plugin
     *   manager — install, enable, disable and open all queue behind it. A
     *   gateway that black-holes the request used to hang activation outright.
     *   The work still starts immediately; `state` awaits it so the panel opens
     *   with data, and `refresh` re-runs it on demand.
     *
     * Every network call below carries the deadline: `fetchModels` also has its
     * own 30s default, so a caller that forgets a signal still cannot pin the
     * queue.
     */
    let warmPromise = Promise.resolve()
    const startWarm = () => {
      warmPromise = (async () => {
        for (const runtime of qoderRuntimes) {
          try {
            const credential = await runtime.resolveCredential()
            if (!isCredentialUsable(credential)) continue
            // The catalog is what the panel reads model IDs from, and on a fresh
            // install the on-disk cache under the plugin's own storage is empty.
            // The Pi port never had to do this explicitly: it refreshed from
            // `auth.apiKey.resolve` on the first model request. Cyrene has no
            // such hook, so without this the region would come up with a live
            // endpoint and zero models to pick from.
            await runtime.refreshCatalog(deadline())
            await runtime.ensureShim()
          } catch (error) {
            logger.warn(`qoder ${runtime.region.id}: 预热失败`, error instanceof Error ? error.message : String(error))
          }
        }
        for (const stack of traeStacks) {
          try {
            const credential = await stack.store.resolve().catch(() => undefined)
            if (credential === undefined) continue
            await stack.ensureReady()
          } catch (error) {
            logger.warn(`trae ${stack.region}: 预热失败`, error instanceof Error ? error.message : String(error))
          }
        }
      })()
      return warmPromise
    }
    // Deliberately not awaited: see the note above.
    startWarm()

    const readState = () => ({
      pluginId: PLUGIN_ID,
      regions: [...qoderRuntimes.map(qoderRegionState), ...traeStacks.map(traeRegionState)],
    })

    /**
     * Run one check-in round, sharing a single in-flight promise.
     *
     * The panel button disables itself while working, but the tool surface and
     * the IPC channel call the same function — two of them arriving together (a
     * model calling the tool while the user clicks the button) would send two
     * claim requests upstream. The upstream is idempotent per Beijing day, so
     * the damage is limited, but limited damage is not a reason to allow a
     * duplicate state-changing call.
     */
    let checkinInFlight = null
    const runCheckin = () => {
      if (checkinInFlight !== null) return checkinInFlight
      checkinInFlight = (async () => ({
        qoder: await qoderCheckin(qoderRuntimes, deadline()),
        trae: await traeCheckin(traeStacks),
      }))().finally(() => {
        checkinInFlight = null
      })
      return checkinInFlight
    }

    ctx.registerIpc(IPC.STATE, async () => {
      // The panel is the only consumer that must not race the warm-up.
      await warmPromise
      return readState()
    })
    ctx.registerIpc(IPC.REFRESH, async () => {
      // `startWarm` already re-reads the Qoder catalogs and re-checks every
      // region's shim, so there is nothing extra to do here.
      await startWarm()
      return readState()
    })
    ctx.registerIpc(IPC.USAGE, async () => ({
      qoder: await qoderUsage(qoderRuntimes, ctx.signal),
      trae: await traeUsage(traeStacks),
    }))
    ctx.registerIpc(IPC.CHECKIN, () => runCheckin())

    ctx.registerTool({
      id: `${PLUGIN_ID}_usage`,
      name: '查询 IDE 账号额度',
      description:
        '读取本机已登录的 Qoder 与 Trae 账号的额度、促销活动与今日签到状态。只读操作，不会改动任何账号状态。读取 Qoder 凭据时会启动子进程（系统 DPAPI 解密、以及 Qoder 安装目录下的 runtime-info.exe），并访问对应厂商的接口。',
      category: 'provider',
      // `shell`, not `network`: reading a Qoder credential spawns PowerShell for
      // the DPAPI unwrap and the vendor's own runtime-info.exe, so the approval
      // prompt must describe a subprocess rather than a plain request. `risk` is
      // a single value, so the network access is stated in the description.
      risk: 'shell',
      effectKind: 'read',
      verificationPolicy: 'none',
      enabled: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const [qoder, trae] = [await qoderUsage(qoderRuntimes, undefined), await traeUsage(traeStacks)]
        const render = (rows) =>
          rows.map((row) => `${row.label}${row.ok ? `（${row.account ?? ''}）` : ''}：\n  ${(row.lines.length > 0 ? row.lines : [row.status ?? '无数据']).join('\n  ')}`).join('\n\n')
        return `Qoder:\n\n${render(qoder)}\n\nTrae:\n\n${render(trae)}`
      },
    })

    ctx.registerTool({
      id: `${PLUGIN_ID}_models`,
      name: '列出 IDE 账号可用模型',
      description:
        '列出各区域通过本插件暴露的模型 ID。这些 ID 用于在 Cyrene 的模型档案里填写，配合面板给出的 Base URL 与 token 使用。',
      category: 'provider',
      risk: 'safe',
      effectKind: 'read',
      verificationPolicy: 'none',
      enabled: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const state = readState()
        return state.regions
          .map((region) => {
            if (!region.ready) return `${region.label}：未登录`
            const ids = region.models.map((m) => m.id).join(', ')
            return `${region.label}：${region.models.length} 个模型\n  Base URL ${region.baseUrl}\n  ${ids}`
          })
          .join('\n\n')
      },
    })

    ctx.registerTool({
      id: `${PLUGIN_ID}_checkin`,
      name: '领取 IDE 账号每日签到额度',
      description:
        '向本机已登录的 Qoder / Trae 账号领取今日签到额度。这是本插件唯一会改动账号状态的操作，会先读取状态，已领取过的不会重复请求。必须显式传入 confirm=true 才会执行。读取 Qoder 凭据时会启动子进程（系统 DPAPI 解密、以及 Qoder 安装目录下的 runtime-info.exe），并访问对应厂商的接口。',
      category: 'provider',
      // Changes state on the upstream account, and reaches it through the same
      // subprocess-spawning credential path as `_usage`, so it is declared
      // `shell` rather than `network`. See the note on `_usage`.
      risk: 'shell',
      effectKind: 'external_side_effect',
      verificationPolicy: 'none',
      enabled: true,
      inputSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: '必须为 true 才真正执行领取；缺省或 false 时只回报将要执行的动作。',
          },
        },
        required: ['confirm'],
      },
      async execute(args) {
        if (args.confirm !== true) {
          return '未执行：领取签到会改动账号状态，需要 confirm=true 明确确认。'
        }
        const result = await runCheckin()
        return [...result.qoder, ...result.trae].map((row) => `${row.label}：${row.message}`).join('\n')
      },
    })

    winManager = createWindowManager(logger)
    // `open()` is called by the host outside `register()`, so the context and
    // the window manager have to outlive this call.
    activeCtx = ctx
    winManagerRef = winManager
    ctx.onDispose(async () => {
      activeCtx = null
      winManagerRef = null
      winManager?.close()
      winManager = null
      for (const runtime of qoderRuntimes) {
        try {
          await runtime.close()
        } catch (error) {
          logger.warn(`qoder ${runtime.region.id}: 关闭 shim 失败`, error instanceof Error ? error.message : String(error))
        }
      }
      for (const stack of traeStacks) {
        try {
          await stack.close()
        } catch (error) {
          logger.warn(`trae ${stack.region}: 关闭 shim 失败`, error instanceof Error ? error.message : String(error))
        }
      }
      qoderRuntimes = []
      traeStacks = []
    })

    // Reported after the warm-up, not before: `startWarm` is deliberately not
    // awaited above, so logging here would always claim "no signed-in account".
    // Reuses the promise already in flight rather than starting a second one.
    warmPromise.then(() => {
      const ready = readState().regions.filter((r) => r.ready).map((r) => r.regionId)
      logger.info(`已启用：${ready.join(', ') || '本机没有已登录的 Qoder / Trae 账号'}`)
    })
  },

  async unregister() {
    // Per-instance state lives inside `register`; `onDispose` owns teardown.
  },

  async open() {
    if (activeCtx === null || winManagerRef === null) return
    await winManagerRef.open(activeCtx)
  },
}

export default plugin
