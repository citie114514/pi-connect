/**
 * Smoke test for the ide-account-bridge plugin, run with the SDK's mock host
 * context so no Cyrene installation is needed.
 *
 * Checks the parts the review checklist names explicitly: `register` runs
 * without throwing, the registered tool/prompt counts match the README, tool
 * ids carry the plugin-id prefix, `unregister` is callable, and dispose leaves
 * nothing running.
 */
const { createMockPluginContext } = require('@playa0v0/cyrene-plugin-sdk/testing');
const path = require('node:path');

const plugin = require('C:/Users/citie/WorkBuddy AI/2026-09-29-23-24-28/cyrene/ide-account-bridge-src/dist/index.cjs');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

(async () => {
  const ctx = createMockPluginContext();
  const tools = [];
  const ipcs = [];
  const disposers = [];
  const logs = [];

  // Wrap the mock so every registration is observable.
  ctx.registerTool = (tool) => tools.push(tool);
  ctx.registerIpc = (channel, handler) => ipcs.push({ channel, handler });
  ctx.onDispose = (fn) => disposers.push(fn);
  ctx.log = (...args) => logs.push(args.join(' '));
  if (typeof ctx.storage?.rootDir !== 'function') {
    ctx.storage = { rootDir: () => path.join(process.env.TEMP || '/tmp', 'ide-account-bridge-test'), get: () => undefined, set: () => {} };
  }

  let registerError = null;
  try {
    await plugin.register(ctx);
  } catch (error) {
    registerError = error;
  }
  check('register(ctx) 不抛错', registerError === null, registerError?.message);
  check('注册了 3 个工具', tools.length === 3, `实际 ${tools.length}`);

  const ids = tools.map((t) => t.id);
  check('工具 id 均以插件 id 为前缀', ids.every((id) => id.startsWith('ide-account-bridge_')), ids.join(', '));

  const usage = tools.find((t) => t.id === 'ide-account-bridge_usage');
  const checkin = tools.find((t) => t.id === 'ide-account-bridge_checkin');
  check('usage 工具声明为只读（risk=network, effectKind=read）', usage?.risk === 'network' && usage?.effectKind === 'read');
  check('checkin 工具声明为改状态（effectKind=external_side_effect）', checkin?.effectKind === 'external_side_effect');
  check('checkin 工具要求 confirm 参数', Array.isArray(checkin?.inputSchema?.required) && checkin.inputSchema.required.includes('confirm'));
  check('每个工具都有 inputSchema 与 description', tools.every((t) => t.inputSchema?.type === 'object' && typeof t.description === 'string' && t.description.length > 0));

  check('注册了 4 条 IPC 通道', ipcs.length === 4, ipcs.map((i) => i.channel).join(', '));
  check('IPC 通道名合法（≤64 字符，字母数字._-）', ipcs.every((i) => i.channel.length <= 64 && /^[A-Za-z0-9._-]+$/.test(i.channel)));

  // checkin 不带 confirm 必须拒绝执行（防止被模型误调）
  let guardMessage = '';
  try {
    guardMessage = await checkin.execute({});
  } catch (error) {
    guardMessage = `抛错: ${error.message}`;
  }
  check('checkin 缺 confirm 时拒绝执行', guardMessage.includes('未执行') && guardMessage.includes('confirm'), guardMessage.slice(0, 60));

  // state 通道应能读到结构化的区域列表
  const stateHandler = ipcs.find((i) => i.channel === 'state')?.handler;
  let state = null;
  try {
    state = await stateHandler();
  } catch (error) {
    state = { error: error.message };
  }
  check('state 通道返回 regions 数组', Array.isArray(state?.regions), JSON.stringify(state).slice(0, 120));
  check('state 覆盖 4 个区域', state?.regions?.length === 4, state?.regions?.map((r) => r.regionId).join(', '));

  check('unregister() 可调用', typeof plugin.unregister === 'function');
  await plugin.unregister();

  // dispose 必须可重复调用且不抛错
  let disposeError = null;
  try {
    for (const fn of disposers) await fn();
    for (const fn of disposers) await fn();
  } catch (error) {
    disposeError = error;
  }
  check('dispose 可重复调用且不抛错', disposeError === null, disposeError?.message);

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  console.log('日志样例:', logs.slice(0, 3).join(' | ') || '(无)');
  process.exit(failures === 0 ? 0 : 1);
})();
