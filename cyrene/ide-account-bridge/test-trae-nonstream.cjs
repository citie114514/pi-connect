/**
 * 端到端验证 Trae shim 的非流式支持。
 *
 * 背景：客户端报 `Unexpected token 'd', "data: {"id"...` —— 非流式请求收到了 SSE。
 * 本测试起真实 shim，分别发 stream:false 与 stream:true，检查响应形态。
 */
const os = require('node:os')
const path = require('node:path')
const { createMockPluginContext } = require('@playa0v0/cyrene-plugin-sdk/testing')
const plugin = require('./dist/index.cjs')

;(async () => {
  const ctx = createMockPluginContext()
  const ipcs = []
  const disposers = []
  ctx.registerTool = () => {}
  ctx.registerIpc = (c, h) => ipcs.push({ channel: c, handler: h })
  ctx.onDispose = (f) => disposers.push(f)
  ctx.log = () => {}
  ctx.storage = {
    rootDir: () => path.join(os.tmpdir(), 'iab-nonstream-test'),
    get: () => undefined,
    set: () => {},
  }

  await plugin.register(ctx)
  const state = await ipcs.find((i) => i.channel === 'state').handler()
  const region = state.regions.find((r) => r.regionId === 'cn')
  if (!region?.ready) {
    console.log('Trae CN 未登录，跳过端到端测试')
    for (const f of disposers) await f()
    process.exit(0)
  }
  const model = region.models[0]?.id
  console.log(`区域 ${region.label} | 模型 ${model}`)
  console.log(`Base URL ${region.baseUrl}\n`)

  const call = async (stream) => {
    const res = await fetch(`${region.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${region.token}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        stream,
        max_tokens: 32,
      }),
    })
    const contentType = res.headers.get('content-type') ?? ''
    const text = await res.text()
    return { status: res.status, contentType, text }
  }

  console.log('--- stream: false ---')
  const nonStream = await call(false)
  console.log(`HTTP ${nonStream.status} | Content-Type: ${nonStream.contentType}`)
  console.log(`响应前 200 字: ${nonStream.text.slice(0, 200)}`)
  let parsed = null
  try {
    parsed = JSON.parse(nonStream.text)
    console.log('JSON.parse: 成功')
    console.log(`  object: ${parsed.object}`)
    console.log(`  content: ${JSON.stringify(parsed.choices?.[0]?.message?.content?.slice(0, 40))}`)
    console.log(`  finish_reason: ${parsed.choices?.[0]?.finish_reason}`)
    console.log(`  usage: ${parsed.usage ? JSON.stringify(parsed.usage) : '(未上报)'}`)
  } catch (error) {
    console.log(`JSON.parse: 失败 -> ${error.message}`)
  }

  console.log('\n--- stream: true ---')
  const stream = await call(true)
  console.log(`HTTP ${stream.status} | Content-Type: ${stream.contentType}`)
  console.log(`响应前 120 字: ${JSON.stringify(stream.text.slice(0, 120))}`)
  console.log(`是 SSE 格式: ${stream.text.startsWith('data: ')}`)

  const pass = parsed !== null && stream.text.startsWith('data: ')
  console.log(`\n${pass ? 'PASS  非流式返回 JSON、流式返回 SSE' : 'FAIL  响应形态不符合预期'}`)

  for (const f of disposers) await f()
  process.exit(pass ? 0 : 1)
})().catch((error) => {
  console.error('测试出错:', error)
  process.exit(1)
})
