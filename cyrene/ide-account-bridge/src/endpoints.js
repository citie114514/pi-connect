/**
 * 持久化各区域的回环端点（端口 + bearer token）。
 *
 * 为什么需要它：shim 原本用 `listen(0)` 拿系统随机端口、每次启动 `randomBytes(32)`
 * 生成新 token。这对 Pi 那种「会话内一次性」的宿主是合适的，但 Cyrene 的模型档案是
 * **持久配置** —— 每重启一次就要回面板重新复制 Base URL 和 token，改四个档案。
 *
 * 所以这里把两者存进插件自己的存储目录：端口优先复用（被占用才换），token 生成一次
 * 后固定。代价是 token 会明文落盘；该目录本就已经存放 Trae 的明文凭据副本，且服务
 * 只监听 127.0.0.1，因此不增加新的暴露面。
 *
 * @module ide-account-bridge/endpoints
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** On-disk format this reader accepts; other versions are discarded. */
const FORMAT_VERSION = 1

/**
 * Ports are handed out from this range. Above 1024 so no elevation is needed,
 * and inside the IANA dynamic range so a collision with a well-known service is
 * unlikely; a busy port simply falls back to a random one.
 */
const PORT_RANGE_START = 43110
const PORT_RANGE_SIZE = 40

export function createEndpointStore({ path, logger } = {}) {
  /** @type {Record<string, { port?: number, token?: string }>} */
  let entries = {}

  /** Ports already handed to a region in this process, so two groups don't collide. */
  const claimedInProcess = new Set()

  const load = () => {
    const tmp = `${path}.tmp`
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Inert; the next save overwrites it.
    }
    if (!existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed?.version !== FORMAT_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) return
      entries = parsed.entries
    } catch (error) {
      // A corrupt file must not take the plugin down: regenerating endpoints
      // costs the user one re-copy, which is the behaviour before this module
      // existed anyway.
      logger?.warn?.('ide-account-bridge: 端点缓存无法解析，将重新生成', error instanceof Error ? error.message : String(error))
    }
  }

  const save = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      // `0o600` because the file holds bearer tokens. POSIX honours it; Windows
      // ignores the mode and inherits the storage directory's ACL — the same
      // caveat the README documents for the Trae credential copy.
      writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, entries }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, path)
    } catch (error) {
      logger?.warn?.('ide-account-bridge: 端点缓存写入失败（端口与 token 将无法跨重启保持）', error instanceof Error ? error.message : String(error))
    }
  }

  load()

  const recordFor = (regionId) => {
    const existing = entries[regionId]
    return existing !== undefined && typeof existing === 'object' && existing !== null ? existing : {}
  }

  return {
    /**
     * The bearer token for a region, minted once and then reused.
     *
     * @param regionId - the region id (`qoder-cn`, `qoder`, `cn`, `ai`).
     * @returns a stable token.
     */
    tokenFor(regionId) {
      const record = recordFor(regionId)
      if (typeof record.token === 'string' && record.token.length > 0) return record.token
      const token = randomBytes(32).toString('base64url')
      entries[regionId] = { ...record, token }
      save()
      return token
    },

    /**
     * A port to try first, so a stable port is reused across restarts.
     *
     * Deterministic per region rather than stored, so a region that has never
     * started still gets a sensible first guess; the caller records whatever it
     * actually binds. `recordPort` is what makes it stick.
     *
     * Ports handed out earlier in this process are skipped: the two groups
     * (Qoder, Trae) number their regions from zero independently, so without
     * this the second group's first region would collide with the first group's
     * and fall back to a random port on a fresh install.
     *
     * @param regionId - the region id.
     * @param index - the region's position within its own group.
     * @returns a port number to attempt.
     */
    preferredPortFor(regionId, index = 0) {
      const record = recordFor(regionId)
      if (typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 1024 && record.port <= 65535) {
        claimedInProcess.add(record.port)
        return record.port
      }
      for (let step = 0; step < PORT_RANGE_SIZE; step += 1) {
        const candidate = PORT_RANGE_START + ((index + step) % PORT_RANGE_SIZE)
        if (!claimedInProcess.has(candidate)) {
          claimedInProcess.add(candidate)
          return candidate
        }
      }
      // The whole range is spoken for; let the OS pick and record what it gives.
      return 0
    },

    /**
     * Remember the port that actually bound, so the next start reuses it.
     *
     * @param regionId - the region id.
     * @param port - the bound port.
     */
    recordPort(regionId, port) {
      const record = recordFor(regionId)
      if (record.port === port) return
      entries[regionId] = { ...record, port }
      save()
    },

    /** Everything currently known, for diagnostics. */
    snapshot() {
      return JSON.parse(JSON.stringify(entries))
    },
  }
}
