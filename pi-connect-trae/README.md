# Pi Connect Trae

把本机已登录的 **Trae**（国内版 / 国际版）模型接入 Pi coding agent，国内版与国际版双供应商并行，
并提供额度查看与每日签到命令。

本包是 DeepSeek Harness 插件 `dsh-connect-trae` 的 Pi 移植版：凭据存储与刷新、设备身份、
回环 shim、SOLO 上游协议、远程模型目录与 SSE 桥全部复用原插件（`lib/trae-core.js` 由
`build-core.mjs` 从 DSH bundle 手术提取），只把 DSH 的 adapter/卡片/web 路由换成 Pi 的
`registerProvider` 原生供应商接口与斜杠命令。

## 供应商

| provider | 说明 |
| --- | --- |
| `trae` | 国内版（CN 网关） |
| `trae-global` | 国际版（trae.ai 网关） |

只注册本机**实际已登录**的区域；未登录的区域安静跳过，不会在模型列表里留下死路由。

## 工作原理

```
Pi 模型运行时（openai-completions API）
  -> 回环 shim（127.0.0.1 随机端口 + 进程内随机 secret）
  -> Trae SOLO 协议（llm_utils_chat / get_detail_param）
  -> CN https://trae-api-cn.mchost.guru / 国际 https://coresg-normal.trae.ai
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/trae-usage` | 查看各区域额度（CN 为 Work 积分，国际为订阅状态）与今日签到状态 |
| `/trae-checkin` | 领取今日签到奖励（仅国内版；唯一会改动账号状态的操作，会先确认） |

签到守卫与原插件一致：**先读状态**，账号今日已领或本设备今日已签到就不发起领取请求。

## 安装

方式一 —— 直接放进 Pi 的扩展目录（推荐，自动发现）：

```powershell
Copy-Item <本包目录> $env:USERPROFILE\.pi\agent\extensions\pi-connect-trae -Recurse
```

方式二 —— 用 npm 源安装：

```powershell
pi install npm:@citie114514/pi-connect-trae
```

> 两种方式**不要同时使用**，否则供应商会注册两次。

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `TRAE_AUTH_FILE` | 覆盖 `storage.json` 路径（可选） |

插件自有刷新后的凭据副本存放在 `~/.pi/agent/cache/dsh-connect-trae/`（原 DSH 版放在 DSH home）。

## 使用

```powershell
pi --list-models                                     # 查看 trae 的模型
pi --provider trae --model DeepSeek-V4-Flash-Official --print "你好"
```

## 与 DSH 版的差异

- **模型目录有 30 分钟 TTL。** 请求路径（`auth.apiKey.resolve`）在目录过期后才重新发现；
  Pi 的显式模型刷新（`refreshModels`）传 `force`，跳过 TTL 立即刷新。此前成功发现一次后
  `modelsReady` 永不复位，进程存活期间不会再看上游的新增/下线。
- **目录并发刷新单飞。** 多个请求或「请求 + 显式刷新」同时到达时共用同一趟发现，
  既不会重复拉取，也不会让晚返回的旧结果覆盖新目录。
- **部分发现视为失败。** Trae 的目录分散在多个 function 下，任一 function 失败时整体抛错，
  保留上一份完整目录并在下次请求重试；不再把缺模型的并集落盘并缓存 30 分钟。
- **模型目录会落盘缓存**（`~/.pi/agent/cache/dsh-connect-trae/catalog-<region>.json`）。
  `TraeCatalog` 本身只在内存里、且以 4 条静态 fallback 起步，而实时目录是异步发现的 ——
  任何在发现落地之前读模型清单的路径（新进程、`pi --list-models`、`/scoped-models`、
  启动时的模型选择器）都只能看到那 4 条。表现就是「模型加载不全」（`qwen3.8-max` 这类
  模型不在列表里）和「scoped-models 重启后丢失」（保存的 id 拿 fallback 名单去匹配，
  自然匹配不上）。现在每次发现成功都写盘，新进程首次读取是同步命中，和 Qoder 版一致。
- **默认不往控制台写东西。** Pi 的 TUI 独占终端，激活期一句 `console.info` 就会打在输入行上
  并把它弄乱。进度信息默认静默，需要时设 `PI_CONNECT_DEBUG=1`；用户真正需要看到的失败走
  `ctx.ui.notify`（TUI 里是提示条，不是裸 stderr）。
- 移除了 DSH 的设置卡片与私有 web 路由；用量/签到改为上面的斜杠命令。
- **默认广告最大上下文窗口。** DSH 的卡片里有按模型选择 dev / Max 窗口的上下文预算，Pi
  没有对应 UI，于是每行都停在目录的 dev 窗口（200K / 256K）。此处在 Trae 公布 Max 时
  （实时目录的 `context_window_tokens.max` → `maxContextWindow`）广告该模型自己的 Max，
  没公布 Max 的模型（如 `kimi-k2.6`、`Doubao-Seed-2.1-Turbo`）仍保持 dev，不编造数值。
  CN 静态 fallback 同步补上了已公布的 Max。
- 未包含 Trae 的 Raw Chat 回退通道（协议核心仍在 `lib/trae-core.js`，需要时可再接线）。
- **思考档位如实广告**（三处修正）：
  1. **不提供「关闭」是故意的**：Trae 的 SOLO 请求体只有 `reasoning_effort` 一个思考字段，没有
     「关掉思考」的表达，所以推理模型一律 `off: null`（不可选），与上游 DSH 插件一致 ——
     而不是允选后静默回落成默认档位。
  2. **档位词表补全**：Trae 自己的 `reasoning_effort_options` 允许
     `minimal / low / medium / high / xhigh`，但旧的反向映射把不认识的档位一律写成 `high`
     —— 上游给了 `medium` 也会被当成 high 显示、发成 high。现在 `EFFORT_MAP` 与
     `TRAE_REASONING_WIRE` 是两张显式表（`light → low`、`extra_high → xhigh` 仍保留）。
  3. **CN 静态 fallback 补上已公布的窗口与档位**（它在实时目录拉不到时就是模型清单）：
     DeepSeek-V4-Flash/Pro-Official 为 low/high/xhigh，glm-5.2 为 high/xhigh，
     kimi-k2.6 上游未公布故保持无档位。此前 4 个 fallback 模型只有 dev 窗口、
     且因为不带 `reasoningEfforts` 被当成非推理模型（`--list-models` 的 thinking 列显示 `no`）。
- 模型描述符广告 `maxTokens`：Pi 的 `--list-models` 不做 undefined 保护，而该字段只约束
  思考预算（请求上限走 `options.maxTokens`），因此不会截断回复。

## 构建

`lib/trae-core.js` 是生成物，从 DSH bundle 重新生成：

```powershell
# 需要在 <DSH_HOME>/profiles/desktop/node_modules/dsh-connect-trae 存在
node build-core.mjs
```

> ⚠️ **当前不要直接重建。** 仓库里这份 `lib/trae-core.js` 已经比 `build-core.mjs` 的产物多出
> 约 840 行（41 处差异），主要集中在模型 `multimodal` 标志驱动的图像输入（issue #16）等改动上
> ——那些是直接改在产物上的，脚本还没有对应的补丁步骤。直接跑 `node build-core.mjs` 会把这些
> 改动抹掉。要重建，先把这些差异补进脚本，再对比产物确认无回退。
>
> 脚本已经包含「删掉每请求调试输出」这一步（`4e`），所以重建至少不会把 issue #1 里那条
> `chat request received {...}` 带回来。

## 许可

MIT
