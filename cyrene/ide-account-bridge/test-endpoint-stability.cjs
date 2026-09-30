/**
 * 验证端口与 token 的跨重启稳定性。
 *
 * 用户反馈：每次重启 Cyrene，四个区域的 Base URL 和 token 全变，模型档案要挨个改。
 * 本测试用同一个 storage 目录跑两次 register，断言第二次拿到的端点与第一次完全一致。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { createMockPluginContext } = require('@playa0v0/cyrene-plugin-sdk/testing')
const plugin = require('./dist/index.cjs')

const STORAGE = path.join(os.tmpdir(), 'iab-endpoint-stability')

function makeCtx() {
  const ctx = createMockPluginContext()
  const ipcs = []
  const disposers = []
  ctx.registerTool = () => {}
  ctx.registerIpc = (c, h) => ipcs.push({ channel: c, handler: h })
  ctx.onDispose = (f) => disposers.push(f)
  ctx.log = () => {}
  ctx.storage = { rootDir: () => STORAGE, get: () => undefined, set: () => {} }
  return { ctx, ipcs, disposers }
}

const endpointsOf = (state) =>
  state.regions.filter((r) => r.ready).map((r) => ({ id: r.regionId, url: r.baseUrl, token: r.token }))

;(async () => {
  fs.rmSync(STORAGE, { recursive: true, force: true })

  // ---- 第一次启动 ----
  const first = makeCtx()
  await plugin.register(first.ctx)
  const firstState = await first.ipcs.find((i) => i.channel === 'state').handler()
  const firstEndpoints = endpointsOf(firstState)
  await plugin.unregister()
  for (const f of first.disposers) await f()
  console.log(`第一次启动：${firstEndpoints.length} 个区域就绪`)
  for (const e of firstEndpoints) console.log(`  ${e.id.padEnd(10)} ${e.url}  token=${e.token.slice(0, 10)}…`)

  const storePath = path.join(STORAGE, 'endpoints.json')
  const saved = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : null
  console.log(`\nendpoints.json 落盘: ${saved !== null}`)
  if (saved) console.log(`  记录的 region: ${Object.keys(saved.entries).join(', ')}`)

  // ---- 第二次启动（模拟重启）----
  const second = makeCtx()
  await plugin.register(second.ctx)
  const secondState = await second.ipcs.find((i) => i.channel === 'state').handler()
  const secondEndpoints = endpointsOf(secondState)
  await plugin.unregister()
  for (const f of second.disposers) await f()
  console.log(`\n第二次启动：${secondEndpoints.length} 个区域就绪`)
  for (const e of secondEndpoints) console.log(`  ${e.id.padEnd(10)} ${e.url}  token=${e.token.slice(0, 10)}…`)

  // ---- 对比 ----
  let failures = 0
  console.log('\n=== 对比 ===')
  for (const a of firstEndpoints) {
    const b = secondEndpoints.find((x) => x.id === a.id)
    if (b === undefined) {
      console.log(`FAIL  ${a.id} 第二次未就绪`)
      failures += 1
      continue
    }
    const urlSame = a.url === b.url
    const tokenSame = a.token === b.token
    if (!urlSame) failures += 1
    if (!tokenSame) failures += 1
    console.log(`${urlSame && tokenSame ? 'PASS' : 'FAIL'}  ${a.id.padEnd(10)} URL ${urlSame ? '一致' : `变了 ${a.url} -> ${b.url}`} | token ${tokenSame ? '一致' : '变了'}`)
  }

  console.log(`\n${failures === 0 ? '全部通过：重启后端点和 token 保持稳定' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('测试出错:', e)
  process.exit(1)
})
