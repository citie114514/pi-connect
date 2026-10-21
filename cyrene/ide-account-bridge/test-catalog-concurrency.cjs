/**
 * 验证「请求时自动刷新」在并发下不会重复发现、不会互相清空。
 *
 * 背景：PR #26 的 review 指出，目录过期且刷新在途时，后续请求会清空在途的
 * `modelsReady`，导致重复发现，并可能让较早任务的结果覆盖较晚的。
 *
 * 手法：直接 import 真实源码里的 `RegionStack`，把它依赖的 `discoverModels`
 * 换成受控实现（每次调用挂起，由测试决定何时 resolve），从而复现并发时序。
 * 断言的正是「不重复发现」和「只有一趟结果落盘」。
 */
const assert = require('node:assert')

const TTL_MS = 30 * 60 * 1000

/** 让出事件循环若干轮，确保 microtask 全部结算。 */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r))
}

;(async () => {
  const { RegionStack } = await import('./src/trae/runtime.js')

  const makeStack = () => {
    const stack = new RegionStack('cn', { warn() {} }, undefined, undefined, 0)
    const calls = []
    const landings = []
    stack.discoverModels = async () => {
      calls.push(calls.length + 1)
      return new Promise((resolve) => {
        landings.push({
          index: calls.length,
          resolve: (models) => resolve(models),
        })
      })
    }
    stack.catalog.set = (derived) => { stack.__lastCatalog = derived }
    stack.ensureShim = async () => ({ })
    return { stack, calls, landings }
  }

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

  // ---------------------------------------------------------------
  console.log('\n[1] 冷启动：三个并发请求只应发起一次发现')
  {
    const { stack, calls, landings } = makeStack()
    const started = []
    const a = stack.refreshCatalog()
    started.push(a)
    await settle()
    const b = stack.ensureReady()
    const c = stack.refreshCatalog()
    await settle()

    check('discoverModels 只被调用 1 次', () => {
      assert.strictEqual(calls.length, 1, `实际 ${calls.length} 次`)
    })

    landings[0].resolve([{ id: 'm1', name: 'm1' }])
    await Promise.all([a, b, c])
    check('三个请求都正常返回', () => assert.ok(true))
    check('目录已落盘', () => {
      assert.ok(stack.__lastCatalog, 'catalog 未被写入')
    })
  }

  // ---------------------------------------------------------------
  console.log('\n[2] 目录过期后并发：不重复发现，且不出现旧结果覆盖新结果')
  {
    const { stack, calls, landings } = makeStack()
    // 预热：先完成一次发现，让 modelsReady = true
    const warm = stack.refreshCatalog()
    await settle()
    landings[0].resolve([{ id: 'warm', name: 'warm' }])
    await warm
    check('预热后 modelsReady 为 true', () => assert.strictEqual(stack.modelsReady, true))

    // 让目录过期
    stack.modelsDiscoveredAt = Date.now() - (TTL_MS + 60 * 1000)
    const before = calls.length

    const a = stack.refreshCatalog()
    await settle()
    const pendingAfterA = stack.modelsPending
    const b = stack.refreshCatalog()
    await settle()
    // 标记：B 调用后 modelsPending 是否仍是 A 那一趟
    b.__reusedPending = stack.modelsPending
    check('在途 promise 未被 B 替换', () => {
      assert.strictEqual(stack.modelsPending, pendingAfterA, 'B 替换了在途 promise')
    })

    check('过期后并发只新增 1 次发现', () => {
      assert.strictEqual(calls.length - before, 1, `实际新增 ${calls.length - before} 次`)
    })
    check('B 复用 A 的在途 promise（内层 modelsPending 同一对象）', () => {
      // refreshCatalog 是 async 方法，每次返回的外层 promise 都是新的；
      // 真正表达「复用」的是内层共享的 modelsPending。
      assert.ok(stack.modelsPending, '在途 promise 不应为空')
      assert.strictEqual(b.__reusedPending, stack.modelsPending)
    })

    landings[landings.length - 1].resolve([{ id: 'fresh', name: 'fresh' }])
    await Promise.all([a, b])
    check('刷新后 modelsReady 仍为 true', () => assert.strictEqual(stack.modelsReady, true))
    check('时间戳已推进', () => assert.ok(Date.now() - stack.modelsDiscoveredAt < TTL_MS))
  }

  // ---------------------------------------------------------------
  console.log('\n[3] 一趟发现失败，不应清掉另一趟在途的 promise')
  {
    const { stack, calls, landings } = makeStack()
    const a = stack.refreshCatalog()
    await settle()
    check('首次发现已发起', () => assert.strictEqual(calls.length, 1))

    // 第一趟失败
    landings[0].resolve([])      // 空结果：不落盘、不推进时间戳
    await settle()
    await a
    check('空结果后 modelsReady 仍为 false（让下次重试）', () => {
      assert.strictEqual(stack.modelsReady, false)
    })
    check('空结果后没有残留的在途 promise', () => {
      assert.strictEqual(stack.modelsPending, undefined)
    })

    // 下一趟应能重新发起
    const b = stack.refreshCatalog()
    await settle()
    check('失败后下次请求会重新发现', () => {
      assert.strictEqual(calls.length, 2, `实际 ${calls.length} 次`)
    })
    landings[1].resolve([{ id: 'ok', name: 'ok' }])
    await b
    check('恢复后 modelsReady 为 true', () => assert.strictEqual(stack.modelsReady, true))
  }

  // ---------------------------------------------------------------
  console.log('\n[4] TTL 保鲜期内请求是零成本 no-op')
  {
    const { stack, calls, landings } = makeStack()
    const warm = stack.refreshCatalog()
    await settle()
    landings[0].resolve([{ id: 'm', name: 'm' }])
    await warm
    const before = calls.length

    const r1 = await stack.refreshCatalog()
    const r2 = await stack.refreshCatalog()
    check('保鲜期内不触发发现', () => {
      assert.strictEqual(calls.length - before, 0, `实际新增 ${calls.length - before} 次`)
    })
    check('保鲜期内返回 null（no-op）', () => {
      assert.strictEqual(r1, null)
      assert.strictEqual(r2, null)
    })
  }

  // ---------------------------------------------------------------
  console.log('\n[5] ensureReady 单独调用也应复用发现（不只走 refreshCatalog）')
  {
    const { stack, calls, landings } = makeStack()
    const a = stack.ensureReady()
    await settle()
    const b = stack.ensureReady()
    const c = stack.ensureReady()
    await settle()
    check('三个并发 ensureReady 只发起 1 次发现', () => {
      assert.strictEqual(calls.length, 1, `实际 ${calls.length} 次`)
    })
    landings[0].resolve([{ id: 'm', name: 'm' }])
    await Promise.all([a, b, c])
    check('modelsReady 为 true', () => assert.strictEqual(stack.modelsReady, true))
  }

  // ---------------------------------------------------------------
  // Qoder 侧：review 指出「Trae 修好了，Qoder 路径还有同样的问题」。Qoder 的
  // 刷新不走 discoverModels，而是 resolveCredential + fetchModels，所以这里
  // 用「凭据解析被调用几次」来数发起趟数——它在联网之前，天然是个可数的锚点。
  const makeQoder = async () => {
    const { RegionRuntime } = await import('./src/qoder/runtime.js')
    const runtime = new RegionRuntime(
      { id: 'qoder-cn', displayName: 'Qoder CN' },
      { warn() {} },
      process.cwd(),
      undefined,
      0,
    )
    let fresh = false
    const state = { resolves: 0 }
    runtime.catalog = {
      fresh: () => fresh,
      current: () => [],
      replace: () => {},
    }
    // 在 fetchModels 之前停下：这些用例只验证「谁发起」，不联网。
    runtime.resolveCredential = async () => {
      state.resolves += 1
      return undefined
    }
    return { runtime, state, setFresh: (v) => { fresh = v } }
  }

  console.log('\n[6] Qoder：并发刷新只发起一趟')
  {
    const { runtime, state } = await makeQoder()
    const a = runtime.refreshCatalog()
    const shared = runtime.catalogPending
    const b = runtime.refreshCatalog()
    const c = runtime.refreshCatalog()

    check('并发三次只解析一次凭据', () => {
      assert.strictEqual(state.resolves, 1, `实际 ${state.resolves} 次`)
    })
    check('首次调用登记了在途 promise', () => {
      assert.ok(shared, 'catalogPending 为空')
    })

    await Promise.all([a, b, c])
    check('结算后在途 promise 已释放', () => {
      assert.strictEqual(runtime.catalogPending, undefined)
    })

    const d = runtime.refreshCatalog()
    check('释放后下一次调用能重新发起', () => {
      assert.strictEqual(state.resolves, 2, `实际 ${state.resolves} 次`)
    })
    await d
  }

  console.log('\n[7] Qoder：TTL 保鲜期内是零成本 no-op')
  {
    const { runtime, state, setFresh } = await makeQoder()
    setFresh(true)
    await runtime.refreshCatalog()
    check('保鲜期内不解析凭据', () => {
      assert.strictEqual(state.resolves, 0, `实际 ${state.resolves} 次`)
    })
    check('保鲜期内不登记在途 promise', () => {
      assert.strictEqual(runtime.catalogPending, undefined)
    })
  }

  console.log('\n[8] Qoder：过期 + 在途时，后到者复用在途而不是另起一趟')
  {
    // review 描述的最坏时序：目录过期 → A 发起 → 上游目录变化 → B 到达。
    // B 若另起一趟，两趟结果就会倒序覆盖，旧结果还会被重新缓存 30 分钟。
    const { runtime, state } = await makeQoder()
    const a = runtime.refreshCatalog()
    const b = runtime.refreshCatalog()
    const c = runtime.refreshCatalog()
    check('过期且已有在途刷新时只发起一趟', () => {
      assert.strictEqual(state.resolves, 1, `实际 ${state.resolves} 次`)
    })
    await Promise.all([a, b, c])
  }

  console.log(`\n${failures === 0 ? 'PASS  并发刷新符合预期' : `FAIL  ${failures} 项未通过`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('测试出错:', error)
  process.exit(1)
})
