/**
 * 验证审核意见 #1 的核心修复：`register` 不再等待预热。
 *
 * 手法：把全局 fetch 换成永不 resolve 的 promise，模拟「网关黑洞」——
 * 请求发出去但永远不回。修复前 register 会一直挂在这里（宿主是全局串行队列，
 * 表现是整个插件管理界面点不动）；修复后 register 必须立刻返回。
 */
const os = require('node:os')
const path = require('node:path')
const { createMockPluginContext } = require('@playa0v0/cyrene-plugin-sdk/testing')
const t0 = Date.now()
const plugin = require('./dist/index.cjs')
const requireMs = Date.now() - t0

const originalFetch = globalThis.fetch
globalThis.fetch = () => new Promise(() => {})

;(async () => {
  const ctx = createMockPluginContext()
  ctx.registerTool = () => {}
  ctx.registerIpc = () => {}
  ctx.onDispose = () => {}
  ctx.log = (...a) => console.log("  " + a.join(" "))
  ctx.storage = {
    rootDir: () => path.join(os.tmpdir(), 'iab-nonblocking-test'),
    get: () => undefined,
    set: () => {},
  }

  const started = Date.now()
  await plugin.register(ctx)
  const elapsed = Date.now() - started

  console.log(`模块 require 耗时：${requireMs} ms`)
  console.log(`上游永久挂起时，register 返回耗时：${elapsed} ms`)
  const pass = elapsed < 2000
  console.log(pass ? 'PASS  未被预热阻塞' : 'FAIL  仍被预热阻塞（宿主队列会被卡住）')

  globalThis.fetch = originalFetch
  process.exit(pass ? 0 : 1)
})().catch((error) => {
  console.error('测试自身出错:', error)
  process.exit(1)
})
