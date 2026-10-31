/**
 * 验证目录刷新行为：
 *
 * 1. `/healthz` 不触发目录刷新，只有 `/v1/models` 与 `/v1/chat/completions` 触发。
 * 2. 已有可用目录时，请求不被挂起的刷新阻塞（后台刷新）。
 * 3. Trae 的逐函数目录发现只要有一个函数失败，就整体视为失败（不落半份目录）。
 * 4. 面板「刷新状态」的强制刷新能跳过 30 分钟 TTL（Qoder 与 Trae 两侧）。
 * 5. 失败退避：刷新失败后 60 秒内不重试（force 除外）。
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

const okOutcome = (models, wire = new Map()) => ({ models, wire, complete: true, failures: [] })
const failedOutcome = (reason) => ({ models: [], wire: new Map(), complete: false, failures: [String(reason)] })

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
    createQoderShim,
    TraeSoloUpstreamClient,
  } = await import('./src/trae/lib/trae-core.js')
  const qoderShim = await import('./src/qoder/lib/shim.js')

  // -----------------------------------------------------------------
  console.log('\n[0] 已有目录时聊天/模型列表不被挂起的刷新阻塞')

  const blockingCases = [
    {
      name: 'Qoder',
      make: async () => {
        let release
        const gate = new Promise((r) => { release = r })
        let entered = 0
        const shim = qoderShim.createQoderShim({
          region: { id: 'qoder-cn', displayName: 'Qoder CN' },
          resolveCredential: async () => ({ userID: 'u1' }),
          resolveModels: () => [{ id: 'm1', key: 'k1' }],
          resolveUpstreamKey: (id) => (id === 'm1' ? 'k1' : undefined),
          resolveAlwaysThinking: () => false,
          resolveEnabledIds: () => [],
          invalidateCredential: () => {},
          logger: { warn() {}, info() {}, error() {} },
          refreshCatalog: async () => {
            entered += 1
            await gate
          },
          secret: 'test-secret',
          preferredPort: 0,
          // 上游调用不会被走到：请求应在刷新阻塞处就已放行
          runChat: async function* () { yield { type: 'text', text: 'ok' } },
        })
        await shim.ready
        return { shim, release, entered: () => entered }
      },
      // Qoder 的刷新只在目录路由上触发；/v1/models 会阻塞，因为没有
      // 「haveModels」以外的本地判据？——有：resolveModels() 非空即放行。
      routes: [
        { path: '/v1/models', method: 'GET', expect: 200 },
      ],
    },
    {
      name: 'Trae',
      make: async () => {
        let release
        const gate = new Promise((r) => { release = r })
        let entered = 0
        const shim = createTraeShim({
          catalog: { current: () => [{ id: 'm1', name: 'm1' }] },
          client: { chatStream: async () => ({ ok: true, response: null }) },
          logger: { warn() {}, info() {}, error() {} },
          wire: { resolved: true },
          refreshCatalog: async () => {
            entered += 1
            await gate
          },
          secret: 'test-secret',
          preferredPort: 0,
        })
        await shim.ready
        return { shim, release, entered: () => entered }
      },
      routes: [
        { path: '/v1/models', method: 'GET', expect: 200 },
      ],
    },
  ]

  for (const { name, make, routes } of blockingCases) {
    const { shim, release, entered } = await make()
    const auth = { Authorization: 'Bearer test-secret' }
    for (const route of routes) {
      const started = Date.now()
      const res = await fetch(`${shim.baseUrl()}${route.path}`, {
        method: route.method,
        headers: { ...auth, ...(route.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(route.method === 'POST' ? { body: JSON.stringify({ model: 'm1', messages: [] }) } : {}),
      })
      void res.body?.cancel?.()
      const elapsed = Date.now() - started
      check(`${name} ${route.path} 未被挂起的刷新阻塞`, () =>
        assert.ok(elapsed < 2000, `耗时 ${elapsed} ms，被阻塞了`))
      check(`${name} 刷新确实被触发过`, () => assert.ok(entered() >= 1))
    }
    release()
    await shim.close()
  }

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
  console.log('\n[2] Trae 目录发现：单函数失败仍返回可用的部分目录')

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

    const result = await client.fetchModelsDetailed()
    check('两个函数都被请求', () => assert.strictEqual(calls.length, 2, `实际 ${calls.length} 次`))
    check('部分成功仍返回可用模型', () => assert.deepStrictEqual(result.models.map((m) => m.id), ['glm-5.3']))
    check('失败函数被上报', () => assert.match(result.failures.join(';'), /solo_work_lite|503/))

    const plain = await client.fetchModels()
    check('fetchModels 仍返回纯数组', () => assert.ok(Array.isArray(plain)))
    check('fetchModels 与 detailed 一致', () => assert.deepStrictEqual(plain.map((m) => m.id), ['glm-5.3']))
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
      return okOutcome([{ id: 'm1', name: 'm1' }])
    }

    await stack.refreshCatalog()
    check('首次发现执行', () => assert.strictEqual(discoveries, 1))
    await stack.refreshCatalog()
    check('TTL 内不再发现', () => assert.strictEqual(discoveries, 1, `实际 ${discoveries} 次`))
    await stack.refreshCatalog({ force: true })
    check('force 跳过 TTL 重新发现', () => assert.strictEqual(discoveries, 2, `实际 ${discoveries} 次`))
  }

  // -----------------------------------------------------------------
  console.log('\n[3b] 失败退避：失败后 60 秒内不重试，force 除外')

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    let attempts = 0
    stack.ensureShim = async () => ({})
    stack.discoverModels = async () => {
      attempts += 1
      return failedOutcome('upstream down')
    }
    // 冷启动：目录为空，发现失败
    await stack.refreshCatalog()
    check('首次发现尝试', () => assert.strictEqual(attempts, 1))
    await stack.refreshCatalog()
    check('退避期内不重试', () => assert.strictEqual(attempts, 1, `实际 ${attempts} 次`))
    await stack.refreshCatalog({ force: true })
    check('force 跳过退避', () => assert.strictEqual(attempts, 2, `实际 ${attempts} 次`))
  }

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    let attempts = 0
    stack.ensureShim = async () => ({})
    stack.discoverModels = async () => {
      attempts += 1
      if (attempts === 1) return failedOutcome('upstream down')
      return okOutcome([{ id: 'm1', name: 'm1' }])
    }
    const realNow = Date.now
    await stack.refreshCatalog()
    check('Trae 首次尝试失败', () => assert.strictEqual(attempts, 1))
    // 模拟退避期过去
    Date.now = () => realNow() + 61 * 1000
    await stack.refreshCatalog()
    check('Trae 退避期过后重试成功', () => assert.strictEqual(attempts, 2))
    check('Trae modelsReady 为 true', () => assert.strictEqual(stack.modelsReady, true))
    check('Trae 失败时间戳已清除', () => assert.strictEqual(stack.modelsFailedAt, 0))
    Date.now = realNow
    await stack.refreshCatalog()
    check('Trae 成功后回到 TTL 判定', () => assert.strictEqual(attempts, 2, `实际 ${attempts} 次`))
  }

  {
    const { RegionRuntime, REGIONS } = await import('./src/qoder/runtime.js')
    const runtime = new RegionRuntime(REGIONS[0], { warn() {} }, os.tmpdir(), undefined, 0)
    let fetches = 0
    runtime.catalog = { fresh: () => false, replace() {} }
    runtime.fetchCatalog = async () => {
      fetches += 1
      // stub 整个 fetchCatalog 绕开了它内部的 catch，这里复现
      // 「失败 → 记录 catalogFailedAt」的真实行为
      try {
        if (fetches === 1) throw new Error('gateway down')
      } catch (error) {
        runtime.catalogFailedAt = Date.now()
        throw error
      }
      runtime.catalogFailedAt = 0
    }
    const realNow = Date.now
    await runtime.refreshCatalog().catch(() => {})
    check('Qoder 首次拉取尝试', () => assert.strictEqual(fetches, 1))
    await runtime.refreshCatalog().catch(() => {})
    check('Qoder 退避期内不重试', () => assert.strictEqual(fetches, 1, `实际 ${fetches} 次`))
    await runtime.refreshCatalog(undefined, { force: true }).catch(() => {})
    check('Qoder force 跳过退避', () => assert.strictEqual(fetches, 2, `实际 ${fetches} 次`))
    // 模拟退避期过去后重试成功
    Date.now = () => realNow() + 61 * 1000
    await runtime.refreshCatalog()
    check('Qoder 退避期过后重试', () => assert.strictEqual(fetches, 3, `实际 ${fetches} 次`))
    check('Qoder 成功清除退避', () => assert.strictEqual(runtime.catalogFailedAt, 0))
    Date.now = realNow
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

  // -----------------------------------------------------------------
  console.log('\n[5] Trae：目录过期 + 上游持续失败时，wire 保留且请求不阻塞')

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    let upstreamCalls = 0
    stack.ensureShim = async () => ({})
    stack.discoverModels = async () => okOutcome(
      [{ id: 'model-a', name: 'Model-A' }],
      new Map([['model-a', { configName: 'model-a', function: 'solo_work_remote' }]]),
    )
    await stack.refreshCatalog()
    check('wire 已就绪', () => assert.strictEqual(stack.wire.resolved, true))
    check('wire 有一条映射', () => assert.strictEqual(stack.wire.byId.size, 1))

    stack.discoverModels = async () => {
      upstreamCalls += 1
      return failedOutcome('solo_work_remote: HTTP 500')
    }
    const realNow = Date.now
    stack.modelsDiscoveredAt = realNow() - 31 * 60 * 1000
    await stack.refreshCatalog()
    check('失败后 wire 映射未被清空', () => assert.strictEqual(stack.wire.byId.size, 1, `实际 ${stack.wire.byId.size}`))
    check('失败后 wire.resolved 仍为 true', () => assert.strictEqual(stack.wire.resolved, true))
    check('失败后 catalog 仍可服务', () => assert.ok(stack.catalog.current().length > 0))
    check('失败已记录（退避生效）', () => assert.notStrictEqual(stack.modelsFailedAt, 0))
    check('modelsReady 保持 true', () => assert.strictEqual(stack.modelsReady, true))

    const before = upstreamCalls
    for (let i = 0; i < 4; i += 1) await stack.refreshCatalog()
    check('退避期内连续 4 次请求不再打上游', () => assert.strictEqual(upstreamCalls, before, `实际多打 ${upstreamCalls - before} 次`))
  }

  // -----------------------------------------------------------------
  console.log('\n[6] Trae：部分成功不推进 TTL，下次请求会重试补齐')

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    let calls = 0
    stack.ensureShim = async () => ({})
    stack.discoverModels = async () => {
      calls += 1
      if (calls === 1) {
        return {
          models: [{ id: 'model-a', name: 'Model-A' }],
          wire: new Map([['model-a', { configName: 'model-a' }]]),
          complete: false,
          failures: ['solo_work_lite: HTTP 500'],
        }
      }
      return okOutcome(
        [{ id: 'model-a', name: 'Model-A' }, { id: 'glm-5.3', name: 'GLM-5.3' }],
        new Map([['model-a', { configName: 'model-a' }], ['glm-5.3', { configName: 'glm-5.3' }]]),
      )
    }
    await stack.refreshCatalog()
    check('部分目录已可用', () => assert.strictEqual(stack.catalog.current().length, 1))
    check('部分成功未标记就绪', () => assert.strictEqual(stack.modelsReady, false))
    check('部分成功记录了失败时间', () => assert.notStrictEqual(stack.modelsFailedAt, 0))

    const realNow = Date.now
    Date.now = () => realNow() + 61 * 1000
    await stack.refreshCatalog()
    check('重试补齐了缺失模型', () => assert.strictEqual(stack.catalog.current().length, 2))
    check('补齐后 modelsReady 为 true', () => assert.strictEqual(stack.modelsReady, true))
    check('补齐后清除失败时间', () => assert.strictEqual(stack.modelsFailedAt, 0))
    Date.now = realNow
  }

  // -----------------------------------------------------------------
  console.log('\n[7] Qoder：上游成功但目录为空时也要退避（P3）')

  {
    const { RegionRuntime, REGIONS } = await import('./src/qoder/runtime.js')
    const runtime = new RegionRuntime(REGIONS[0], { warn() {} }, os.tmpdir(), undefined, 0)
    let fetches = 0
    runtime.catalog = { fresh: () => false, replace() { throw new Error('空目录不应写入') } }
    runtime.credentials = { invalidate() {} }
    runtime.resolveCredential = async () => ({ userID: 'u' })
    runtime.fetchCatalog = async () => {
      fetches += 1
      runtime.catalogFailedAt = Date.now()
    }
    await runtime.refreshCatalog()
    check('首次拉取尝试', () => assert.strictEqual(fetches, 1))
    await runtime.refreshCatalog()
    check('空目录退避期内不重试', () => assert.strictEqual(fetches, 1, `实际 ${fetches} 次`))
    await runtime.refreshCatalog(undefined, { force: true })
    check('force 跳过空目录退避', () => assert.strictEqual(fetches, 2, `实际 ${fetches} 次`))
  }


  // -----------------------------------------------------------------
  console.log('\n[8] wire 映射：显示名与 id 不同的模型也要能按名解析')

  {
    const { RegionStack } = await import('./src/trae/runtime.js')
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    stack.ensureShim = async () => ({})
    // 模拟真实目录：id 是 wire id，显示名完全不同
    const models = [
      { id: 'glm-5.3', name: 'GLM 5.3 Turbo' },
      { id: 'kimi-k3', name: 'Kimi K3' },
    ]
    const wire = new Map([
      ['glm-5.3', { configName: 'glm_5_3_solo', function: 'solo_work_remote' }],
      ['kimi-k3', { configName: 'kimi_k3_solo', function: 'solo_work_lite' }],
    ])
    stack.applyDirectory(models, wire)

    check('byId 按 id 可解析', () => {
      const hit = stack.wireResolver('glm-5.3')
      assert.ok(hit, 'byId 未命中')
      assert.strictEqual(hit.configName, 'glm_5_3_solo')
    })
    check('byName 按显示名可解析（大小写不敏感）', () => {
      const hit = stack.wireResolver('GLM 5.3 Turbo') ?? stack.wire.byName.get('glm 5.3 turbo')
      assert.ok(hit, '显示名未命中')
      assert.strictEqual(hit.configName, 'glm_5_3_solo')
    })
    check('byName 与 byId 条数一致', () => {
      assert.strictEqual(stack.wire.byName.size, models.length, `实际 ${stack.wire.byName.size}`)
    })
    check('callableKeys 同时含 id 与显示名', () => {
      assert.ok(stack.wire.callableKeys.has('glm-5.3'))
      assert.ok(stack.wire.callableKeys.has('glm 5.3 turbo'))
    })
  }

  console.log(`\n${failures === 0 ? 'PASS  刷新路由与目录完整性符合预期' : `FAIL  ${failures} 项断言失败`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('测试出错:', error)
  process.exit(1)
})
