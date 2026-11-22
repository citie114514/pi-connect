/**
 * pi-connect-free 的回归测试。
 *
 * 全部离线：上游用注入的 fetchImpl / 受控 Response 代替，不消耗任何真实额度。
 * 覆盖三件最容易悄悄坏掉的事 —— 鉴权围栏、失败分类、以及「拿不到目录时
 * 不能返回空列表冒充成功」。
 *
 * 用法：node test-free.cjs
 */
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

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

const sse = (frames) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

;(async () => {
  const { FreeModelError, KIND, kindForStatus } = await import('./src/providers/types.js')
  const { readSse, httpError } = await import('./src/http.js')

  console.log('\n[1] 状态码到失败类别的映射')
  {
    check('401/403 -> auth', () => {
      assert.strictEqual(kindForStatus(401), KIND.auth)
      assert.strictEqual(kindForStatus(403), KIND.auth)
    })
    check('402 -> quota', () => assert.strictEqual(kindForStatus(402), KIND.quota))
    check('429 -> rate', () => assert.strictEqual(kindForStatus(429), KIND.rate))
    check('5xx -> server', () => assert.strictEqual(kindForStatus(503), KIND.server))
    check('4xx -> client', () => assert.strictEqual(kindForStatus(400), KIND.client))
  }

  console.log('\n[2] 上游错误原文必须保留')
  {
    const response = new Response('', { status: 400 })
    const openai = httpError('test', response, JSON.stringify({ error: { message: 'bad model' } }))
    check('OpenAI 形状的 error.message 被带出', () => assert.match(openai.message, /bad model/))
    check('状态码被记录', () => assert.strictEqual(openai.status, 400))
    check('分类为 client', () => assert.strictEqual(openai.kind, KIND.client))

    const bare = httpError('test', new Response('', { status: 500 }), JSON.stringify({ message: 'boom' }))
    check('裸 message 字段也被带出', () => assert.match(bare.message, /boom/))

    const plain = httpError('test', new Response('', { status: 502 }), 'gateway torn down')
    check('非 JSON 正文原样保留', () => assert.match(plain.message, /gateway torn down/))
  }

  console.log('\n[3] SSE 解析：多行、注释、[DONE]、尾部无空行')
  {
    const collected = []
    for await (const payload of readSse(sse([{ a: 1 }, { b: 2 }]).body, undefined, 5000)) collected.push(payload)
    check('两个 data 帧都被产出', () => assert.strictEqual(collected.length, 2))
    check('[DONE] 不被当成 payload', () => assert.ok(!collected.some((p) => p.includes('[DONE]'))))
  }

  {
    // 注释行（`:` 开头）是保活帧，不是数据。
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': KILO PROCESSING\n\n'))
        controller.enqueue(encoder.encode('data: {"ok":true}\n\n'))
        controller.close()
      },
    })
    const collected = []
    for await (const payload of readSse(body, undefined, 5000)) collected.push(payload)
    check('注释帧被跳过，只留数据帧', () => {
      assert.strictEqual(collected.length, 1)
      assert.strictEqual(JSON.parse(collected[0]).ok, true)
    })
  }

  {
    // 尾部帧后面没有空行：SSE 规范允许，读端必须补。
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"tail":1}'))
        controller.close()
      },
    })
    const collected = []
    for await (const payload of readSse(body, undefined, 5000)) collected.push(payload)
    check('尾部无空行的帧不丢', () => {
      assert.strictEqual(collected.length, 1)
      assert.strictEqual(JSON.parse(collected[0]).tail, 1)
    })
  }

  console.log('\n[4] 流空闲超时')
  {
    // 一个永不产出数据的流：读端必须在 idle 上限后抛 timeout，而不是挂死。
    const body = new ReadableStream({ start() {} })
    // `readSse` unrefs its idle timer on purpose — in a real process other
    // handles keep the loop alive. This test has no such handle, so without a
    // keepalive Node would exit on an empty loop instead of running the test.
    const keepalive = setInterval(() => {}, 1000)
    let caught
    const started = Date.now()
    try {
      for await (const _ of readSse(body, undefined, 120)) { /* nothing */ }
    } catch (error) {
      caught = error
    } finally {
      clearInterval(keepalive)
    }
    check('空闲流以 timeout 结束', () => {
      assert.ok(caught instanceof FreeModelError, '没有抛错')
      assert.strictEqual(caught.kind, KIND.timeout)
    })
    check('在空闲上限附近结束', () => assert.ok(Date.now() - started < 3000))
  }

  console.log('\n[5] 渠道注册表')
  {
    const { loadProviders, EXCLUDED_CHANNELS } = await import('./src/registry.js')
    const { providers, failures } = await loadProviders()
    check('Kilo 渠道已加载', () => assert.ok(providers.some((p) => p.id === 'kilo')))
    check('Qoder 两个区域已加载', () => {
      assert.ok(providers.some((p) => p.id === 'qoder-cn'))
      assert.ok(providers.some((p) => p.id === 'qoder'))
    })
    check('TRAE 两个区域已加载', () => {
      assert.ok(providers.some((p) => p.id === 'trae-cn'))
      assert.ok(providers.some((p) => p.id === 'trae-ai'))
    })
    check('依赖缺失的渠道有可读原因，而不是静默消失', () =>
      assert.ok(failures.length === 0 || failures.every((f) => typeof f.reason === 'string' && f.reason !== '')))
    check('被排除的渠道写明了原因', () => {
      assert.strictEqual(EXCLUDED_CHANNELS.length, 2)
      for (const channel of EXCLUDED_CHANNELS) {
        assert.ok(typeof channel.reason === 'string' && channel.reason.length > 40, `${channel.id} 缺少原因`)
      }
    })
    check('每个渠道都声明了五项能力', () => {
      for (const provider of providers) {
        for (const key of ['listModels', 'chat', 'balance', 'checkin', 'refresh']) {
          assert.strictEqual(typeof provider.capabilities[key], 'boolean', `${provider.id}.${key}`)
        }
      }
    })
    check('能力为 false 时必须能解释', () => {
      for (const provider of providers) {
        for (const [key, reasonKey] of [
          ['listModels', 'listModelsBlockedReason'],
          ['chat', 'chatBlockedReason'],
          ['balance', 'balanceBlockedReason'],
          ['checkin', 'checkinBlockedReason'],
          ['refresh', 'refreshBlockedReason'],
        ]) {
          if (provider.capabilities[key] === false) {
            assert.ok(
              typeof provider.capabilities[reasonKey] === 'string' && provider.capabilities[reasonKey] !== '',
              `${provider.id} 缺少 ${reasonKey}`,
            )
          }
        }
      }
    })
  }

  console.log('\n[6] Kilo 渠道：免费切片与空目录')
  {
    const kilo = await import('./src/providers/kilo.js')
    const provider = kilo.providers[0]

    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'free-a', isFree: true, context_length: 128000 },
            { id: 'paid-b', isFree: false },
            { id: 'unmarked-c', context_length: 32000 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    try {
      const models = await provider.listModels()
      check('付费模型被过滤掉', () => assert.ok(!models.some((m) => m.id === 'paid-b')))
      check('未标注 isFree 的保留（不臆断为付费）', () => assert.ok(models.some((m) => m.id === 'unmarked-c')))
      check('上下文窗口被解析', () => assert.strictEqual(models.find((m) => m.id === 'free-a').contextWindow, 128000))
    } finally {
      globalThis.fetch = original
    }

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      let caught
      try {
        await provider.listModels()
      } catch (error) {
        caught = error
      }
      check('空目录抛错，而不是返回空列表冒充成功', () => {
        assert.ok(caught instanceof FreeModelError, '没有抛错')
        assert.strictEqual(caught.kind, KIND.empty)
      })
    } finally {
      globalThis.fetch = original
    }
  }

  console.log('\n[7] 回环网关的鉴权围栏')
  {
    // 直接读入口源码，确认鉴权判定在路由分发之前 —— 这是无法用纯单元测试
    // 断言的结构性质，但可以用顺序检查固定下来。
    const source = readFileSync(join(__dirname, 'index.js'), 'utf8')
    const authIndex = source.indexOf('if (!this.authorized(req))')
    const routeIndex = source.indexOf("if (req.method === 'GET' && url === '/v1/models')")
    check('鉴权检查排在模型路由之前', () => assert.ok(authIndex > 0 && authIndex < routeIndex))
    check('bearer 用定长比较', () => assert.match(source, /timingSafeEqual/))
    check('shim 只绑回环地址', () => assert.match(source, /listen\(0, '127\.0\.0\.1'/))
  }

  console.log(`\n${failures === 0 ? 'PASS  pi-connect-free 全部通过' : `FAIL  ${failures} 项断言失败`}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('测试自身出错：', error)
  process.exit(1)
})
