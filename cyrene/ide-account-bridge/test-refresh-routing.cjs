/**
 * 验证 PR #26 review 的三项修复：
 *
 * 1. `/healthz` 不触发目录刷新，只有 `/v1/models` 与 `/v1/chat/completions` 触发。
 * 2. Trae 的逐函数目录发现只要有一个函数失败，就整体视为失败（不落半份目录）。
 * 3. 面板「刷新状态」的强制刷新能跳过 30 分钟 TTL（Qoder 与 Trae 两侧）。
 *
 * 全部为单元级：注入 fetchImpl / stub 掉网络，不依赖已登录账号。
 */
const assert = require('node:assert')
const os = require('node:os')

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const CREDENTIAL = {
  accessToken: 'test-token',
  userId: 'test-user',
  userRegion: 'cn',
  edition: 'cn',
  host: 'https://api.trae.cn',
}

const directoryResponse = (...names) => ({
  ok: true,
  status: 200,
  json: async () => ({
    config_info_list: names.map((name) => ({ config_name: name, display_config: { display_name: name } })),
  }),
})

;(async () => {
  const {
    createTraeShim,
    TraeSoloUpstreamClient,
  } = await import('./src/trae/lib/trae-core.js')

  // -----------------------------------------------------------------
  console.log('\n[1] /healthz 不触发上游刷新，目录路由仍然触发')

  {
    let refreshes = 0
    const shim = createTraeShim({
      catalog: { current: () => [{ id: 'm1', name: 'm1' }] },
      client: { chatStream: async () => ({ ok: false, kind: 'server', message: 'test' }) },
      logger: { warn() {}, info() {}, error() {} },
      refreshCatalog: async () => {
        refreshes += 1
      },
      secret: 'test-secret',
      preferredPort: 0,
    })
    await shim.ready
    const base = shim.baseUrl()
    const auth = { Authorization: 'Bearer test-secret' }

    const health = await fetch(`${base}/healthz`, { headers: auth })
    check('健康探针返回 200', () => assert.strictEqual(health.status, 200))
    check('健康探针未触发刷新', () => assert.strictEqual(refreshes, 0, `实际 ${refreshes} 次`))

    const models = await fetch(`${base}/v1/models`, { headers: auth })
    check('/v1/models 返回 200', () => assert.strictEqual(models.status, 200))
    check('/v1/models 触发一次刷新', () => assert.strictEqual(refreshes, 1, `实际 ${refreshes} 次`))

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    check('chat 路由被处理（上游失败不影响刷新计数）', () => assert.strictEqual(chat.status, 502))
    check('/v1/chat/completions 触发一次刷新', () => assert.strictEqual(refreshes, 2, `实际 ${refreshes} 次`))

    const missing = await fetch(`${base}/v1/unknown`, { headers: auth })
    check('未知路由仍 404', () => assert.strictEqual(missing.status, 404))
    check('未知路由不触发刷新', () => assert.strictEqual(refreshes, 2, `实际 ${refreshes} 次`))

    await shim.close()
  }

  // -----------------------------------------------------------------
  console.log('\n[2] Trae 目录发现：单函数瞬时失败不应落半份目录')

  {
    const calls = []
    const client = new TraeSoloUpstreamClient({
      credential: async () => CREDENTIAL,
      identity: async () => ({}),
      log: () => {},
      fetchImpl: async (_url, init) => {
        const fn = JSON.parse(init.body).function
        calls.push(fn)
        if (fn === 'solo_work_remote') return directoryResponse('glm-5.3')
        return { ok: false, status: 503, json: async () => ({}) }
      },
    })

    let thrown
    try {
      await client.fetchModels()
    } catch (error) {
      thrown = error
    }
    check('两个函数都被请求', () => assert.strictEqual(calls.length, 2, `实际 ${calls.length} 次`))
    check('部分成功仍整体抛错', () => assert.ok(thrown, '未抛错，返回了不完整的并集'))
    check('错误信息包含失败函数', () => assert.match(String(thrown?.message), /incomplete|solo_work_lite/))
  }

  {
    const client = new TraeSoloUpstreamClient({
      credential: async () => CREDENTIAL,
      identity: async () => ({}),
      log: () => {},
      fetchImpl: async (_url, init) => {
        const fn = JSON.parse(init.body).function
        return directoryResponse(fn === 'solo_work_remote' ? 'glm-5.3' : 'kimi-k3')
      },
    })
    const models = await client.fetchModels()
    check('全部成功时正常返回并集', () =>
      assert.deepStrictEqual(models.map((m) => m.id).sort(), ['glm-5.3', 'kimi-k3']))
  }

  // -----------------------------------------------------------------
  console.log('\n[3] Trae 强制刷新绕过 TTL')

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    let discoveries = 0
    stack.ensureShim = async () => ({})
    stack.discoverModels = async () => {
      discoveries += 1
      return [{ id: 'm1', name: 'm1' }]
    }

    await stack.refreshCatalog()
    check('首次发现执行', () => assert.strictEqual(discoveries, 1))
    await stack.refreshCatalog()
    check('TTL 内不再发现', () => assert.strictEqual(discoveries, 1, `实际 ${discoveries} 次`))
    await stack.refreshCatalog({ force: true })
    check('force 跳过 TTL 重新发现', () => assert.strictEqual(discoveries, 2, `实际 ${discoveries} 次`))
  }

  // -----------------------------------------------------------------
  console.log('\n[4] Qoder 强制刷新绕过 TTL')

  {
    const { RegionRuntime, REGIONS } = await import('./src/qoder/runtime.js')
    const runtime = new RegionRuntime(REGIONS[0], { warn() {} }, os.tmpdir(), undefined, 0)
    let fetches = 0
    runtime.catalog = { fresh: () => true, replace() {} }
    runtime.fetchCatalog = async () => {
      fetches += 1
    }

    await runtime.refreshCatalog()
    check('TTL 内默认不拉取', () => assert.strictEqual(fetches, 0, `实际 ${fetches} 次`))
    await runtime.refreshCatalog(undefined, { force: true })
    check('force 跳过 TTL 拉取', () => assert.strictEqual(fetches, 1, `实际 ${fetches} 次`))
  }

  console.log(`\n${failures === 0 ? 'PASS  刷新路由与目录完整性符合预期' : `FAIL  ${failures} 项断言失败`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('测试出错:', error)
  process.exit(1)
})
