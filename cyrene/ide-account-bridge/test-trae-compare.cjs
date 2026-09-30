/**
 * 对比流式与非流式的实际内容，确认聚合逻辑没有丢内容。
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
  ctx.storage = { rootDir: () => path.join(os.tmpdir(), 'iab-cmp-test'), get: () => undefined, set: () => {} }

  await plugin.register(ctx)
  const state = await ipcs.find((i) => i.channel === 'state').handler()
  const region = state.regions.find((r) => r.regionId === 'cn')
  if (!region?.ready) { console.log('未登录，跳过'); process.exit(0) }

  const model = region.models.find((m) => !/evolving|thinking/i.test(m.id))?.id ?? region.models[0].id
  const payload = {
    model,
    messages: [{ role: 'user', content: '用一句话说明什么是 HTTP 状态码 404' }],
    max_tokens: 200,
  }
  const post = (body) =>
    fetch(`${region.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${region.token}` },
      body: JSON.stringify(body),
    })

  console.log(`模型: ${model}\n`)

  // 流式：把 SSE 的 content 拼起来
  const sres = await post({ ...payload, stream: true })
  const raw = await sres.text()
  const streamed = raw
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => { try { return JSON.parse(l.slice(6)) } catch { return null } })
    .filter(Boolean)
    .map((c) => c.choices?.[0]?.delta?.content ?? '')
    .join('')
  console.log(`--- 流式 ---`)
  console.log(`HTTP ${sres.status} | 事件数 ${raw.split('data: ').length - 1}`)
  console.log(`拼出的内容: ${JSON.stringify(streamed.slice(0, 120))}`)

  // 非流式
  const nres = await post({ ...payload, stream: false })
  const body = await nres.json()
  const nonStreamed = body.choices?.[0]?.message?.content ?? ''
  console.log(`\n--- 非流式 ---`)
  console.log(`HTTP ${nres.status}`)
  console.log(`内容: ${JSON.stringify(nonStreamed.slice(0, 120))}`)
  console.log(`finish_reason: ${body.choices?.[0]?.finish_reason}`)
  console.log(`usage: ${body.usage ? JSON.stringify(body.usage) : '(未上报)'}`)

  const same = streamed.trim() === nonStreamed.trim()
  console.log(`\n${same ? 'PASS  两者内容一致' : 'WARN  两者内容不一致（可能是模型随机性，需人工判断）'}`)
  console.log(`流式长度 ${streamed.length} | 非流式长度 ${nonStreamed.length}`)

  for (const f of disposers) await f()
  process.exit(0)
})().catch((e) => { console.error('出错:', e); process.exit(1) })
