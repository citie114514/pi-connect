/**
 * 验证「请求时自动刷新模型目录」（对齐 Pi 的 auth.apiKey.resolve 行为）。
 *
 * 手法：mock Date.now 让 CatalogStore 认为目录已过期（TTL 30 分钟），然后发一次
 * 请求，检查磁盘上的 fetchedAt 是否被推进 —— 被推进说明刷新真的发生了。
 *
 * 同时验证 TTL 内的请求不会触发刷新（那会拖慢每一次调用）。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { createMockPluginContext } = require('@playa0v0/cyrene-plugin-sdk/testing')
const plugin = require('./dist/index.cjs')

const STORAGE = path.join(os.tmpdir(), 'iab-autorefresh-test')
const realNow = Date.now

const readQoderCatalogAt = () => {
  const dir = path.join(STORAGE, 'qoder')
  if (!fs.existsSync(dir)) return 0
  const hit = fs.readdirSync(dir).filter((f) => f.startsWith('.qoder-catalog.') && f.endsWith('.json'))
  if (hit.length === 0) return 0
  // 取最近写入的那个区域缓存
  const newest = hit
    .map((f) => ({ f, at: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).fetchedAt ?? 0 }))
    .sort((a, b) => b.at - a.at)[0]
  return newest.at
}

;(async () => {
  fs.rmSync(STORAGE, { recursive: true, force: true })

  const ctx = createMockPluginContext()
  const ipcs = []
  const disposers = []
  ctx.registerTool = () => {}
  ctx.registerIpc = (c, h) => ipcs.push({ channel: c, handler: h })
  ctx.onDispose = (f) => disposers.push(f)
  ctx.log = () => {}
  ctx.storage = { rootDir: () => STORAGE, get: () => undefined, set: () => {} }

  await plugin.register(ctx)
  const stateHandler = ipcs.find((i) => i.channel === 'state').handler
  const state = await stateHandler()
  const region = state.regions.find((r) => r.regionId === 'qoder-cn' && r.ready)
  if (!region) {
    console.log('qoder-cn 未登录，跳过')
    for (const f of disposers) await f()
    process.exit(0)
  }

  const at0 = readQoderCatalogAt()
  console.log(`区域就绪：${region.label}（${region.models.length} 个模型）`)
  console.log(`初始 catalog fetchedAt: ${at0}`)

  const listModels = () =>
    fetch(`${region.baseUrl}/models`, { headers: { Authorization: `Bearer ${region.token}` } })

  // ---- 用例 1：TTL 内的请求不应触发刷新 ----
  const before = readQoderCatalogAt()
  await listModels()
  const afterInWindow = readQoderCatalogAt()
  const noRefreshInWindow = afterInWindow === before
  console.log(`\nTTL 内请求：fetchedAt ${noRefreshInWindow ? '未变（正确，未做无用请求）' : `被推进 ${before} -> ${afterInWindow}`}`)

  // ---- 用例 2：TTL 过期的请求应触发刷新 ----
  Date.now = () => realNow() + 31 * 60 * 1000
  let refreshedAt = afterInWindow
  let refreshError
  try {
    const res = await listModels()
    console.log(`过期请求：HTTP ${res.status}`)
    refreshedAt = readQoderCatalogAt()
  } catch (error) {
    refreshError = error
  }
  Date.now = realNow

  const refreshed = refreshedAt > afterInWindow
  console.log(`过期请求后：fetchedAt ${afterInWindow} -> ${refreshedAt}（${refreshed ? '已推进，刷新发生' : '未推进'}）`)
  if (refreshError) console.log(`请求出错: ${refreshError.message}`)

  // 目录应仍然可用
  const stateAfter = await stateHandler()
  const regionAfter = stateAfter.regions.find((r) => r.regionId === 'qoder-cn')
  console.log(`刷新后模型仍在: ${regionAfter.models.length} 个`)

  const pass = noRefreshInWindow && refreshed && regionAfter.models.length > 0
  console.log(`\n${pass ? 'PASS  目录自动刷新符合预期' : 'FAIL  目录刷新行为不符合预期'}`)

  await plugin.unregister()
  for (const f of disposers) await f()
  process.exit(pass ? 0 : 1)
})().catch((e) => {
  Date.now = realNow
  console.error('测试出错:', e)
  process.exit(1)
})
