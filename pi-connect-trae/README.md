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

## 许可

MIT
