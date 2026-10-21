# Pi Connect Qoder

把本机已登录的 **Qoder**（国内版 Qoder CN / 国际版 Qoder）模型接入 Pi coding agent，零配置即可在
Pi 的模型列表里使用你的 Qoder 账号额度。

本包是 DeepSeek Harness 插件 `@eghrhegpe/dsh-connect-qoder` 的 Pi 移植版：凭据读取、回环 shim、
上游 COSY 协议与模型目录逻辑全部复用原插件，只把 DSH 的 adapter/卡片换成 Pi 的
`registerProvider` 原生供应商接口。

## 供应商

| provider | 说明 |
| --- | --- |
| `qoder-cn` | 国内版 Qoder CN |
| `qoder` | 国际版 Qoder |

装哪个/登录哪个就出现哪一组模型；两个都登录则两组并存，各自使用自己的账号与额度。

## 工作原理

```
Pi 模型运行时（openai-completions API）
  -> 回环 shim（127.0.0.1 随机端口 + 进程内随机 secret）
  -> COSY 签名 + 自定义 base64 编码
  -> 国内版 https://gateway.qoder.com.cn/ / 国际版 https://api3.qoder.sh/
  -> Qoder 双层包装 SSE -> OpenAI SSE
```

凭据复用 Qoder 桌面应用自己的登录状态（Windows 上经 PowerShell + DPAPI 解开 Chromium
OSCrypt 密钥），**不写入应用文件、不启动 OAuth**。没有桌面登录时可用 `QODERCN_PAT` /
`QODER_PAT` 环境变量兜底。

## 延迟：钱花在哪一段

本机实测（2026-10-21，Pi 0.87.1，`qoder-cn`）：

| 环节 | 耗时 |
| --- | --- |
| 模型请求本身（经 shim 的首字节） | 332–1151 ms |
| 同一请求结束 | 0.8–2.7 s |
| 目录拉取（`fetchModels`） | 256–534 ms |
| 凭据首次读取（DPAPI + SQLite） | ~573 ms，之后缓存命中 0 ms |
| 开思考档（`effort=high` 对比不开） | 首字节约 +0.5 s |
| **Pi 启动（全部扩展）** | **~8.2 s** |

启动的 8.2 s 里，Pi 自身地板约 2.8 s，扩展导入合计约 2.7 s（本插件 0.59 s，其余是
`pi-subagents` 0.80 s、`pi-wechat-assistant` 0.70 s、`pi-mcp-adapter` 0.22 s、
`pi-goal-x` 0.22 s），剩余在会话运行时初始化（MCP 等）。**如果觉得「打开 Pi 很慢」，
瓶颈在启动而非 Qoder 请求**，关掉用不到的扩展比调模型参数有效得多。

本插件能控制的那部分已经收紧：

- 目录刷新有 5 s 上限（`CATALOG_REFRESH_TIMEOUT_MS`），且失败后 60 s 内不再重试
  （`CATALOG_RETRY_AFTER_FAILURE_MS`）。这两条不是洁癖：`refreshCatalog` 是在
  `auth.apiKey.resolve` 里 **await** 的，跑在请求发出之前，所以它的超时会直接加在每个
  回合上；`fetchModels` 早期版本没有自己的 signal 兜底，网关一旦黑洞化（防火墙、代理、
  无路由）就是「等待模型卡半天」，请求根本没发出去。
- 两个区域的预热并发执行，不再把两次凭据读取（各约 0.6 s）串行摆在第一条消息前面。
- 目录未过期时（30 min TTL）刷新直接短路，不产生任何网络请求。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/qoder-usage` | 查看各区域额度、促销活动与今日签到状态 |
| `/qoder-checkin` | 领取今日签到额度（唯一会改动账号状态的操作，会先确认） |

## 安装

方式一 —— 直接放进 Pi 的扩展目录（推荐，自动发现）：

```powershell
Copy-Item <本包目录> $env:USERPROFILE\.pi\agent\extensions\pi-connect-qoder -Recurse
```

方式二 —— 用 npm 源安装：

```powershell
pi install npm:@citie114514/pi-connect-qoder
```

> 两种方式**不要同时使用**，否则供应商会注册两次。

## 使用

```powershell
pi --list-models                       # 查看 qoder-cn / qoder 的模型
pi --provider qoder-cn --model DeepSeek-Flash --print "你好"
```

## 模型 ID

模型 ID 取自 Qoder 目录的 `display_name`（去掉空白），例如 `DeepSeek-Flash`、`Qwen3.8-Max`。

**为什么不用 Qoder 自己的 `key`。** 实测 CN 目录里 `Qwen3.7-Max` 的 key 是 `qmodel_latest`、
`Kimi-K3` 是 `kmodel_latest`、`Qwen3.7-Plus` 是 `qmodel` —— 这类内部代号按设计就是滚动的，
拿它当 ID 只会漂移得更隐蔽。硬编码 slug 虽然绝对稳定，代价却是必须人工维护一张模型表：
Qoder 上了新模型，在包发新版之前用户根本用不到。`display_name` 是带版本号的产品名
（`Qwen3.8-Max`、`GLM-5.3`），改名罕见；新模型以**新 ID** 出现而不是改旧名，因此派生自它
既不需要维护、也不会滞后上游。

**匹配是容错的。** `enabledModels` 的比较会忽略大小写与分隔符，所以 `DeepSeek-Flash`、
`deepseek-flash`、`DeepSeek Flash`、`deepseekflash` 指向同一个模型 —— 手写配置不会因为一个
连字符就让模型从列表里静默消失。

## 与 DSH 版的差异

- 移除了 DSH 的设置卡片与私有 web 路由（Pi 没有对应宿主）；用量/签到改为上面的斜杠命令。
- **默认广告最大上下文窗口。** DSH 的卡片里有 `useMaximumContextWindow` 开关，默认关 = 用
  Qoder 目录的 200K 默认值；Pi 没有持久化 settings 源，`preferMaximumContext({})` 永远是
  false，于是每个模型都被钉在 200K。此处改为默认开启该偏好：Qoder 客户端本来就提供
  200K / 400K / 1M 三档，网关接受最大值，所以没有可达开关时 1M 才是账号实际跑的窗口。
  目录未公布窗口的条目（如 `Auto`）仍回落到目录的 `defaultContextWindow`。
- **`maxTokens` 只广告网关的 128K 输出上限，不广告上下文窗口。** Pi 的 `--list-models` 用
  `formatTokenCount(m.maxTokens)` 渲染 max-out 列，该函数末尾是 `count.toString()`，`undefined`
  会直接抛错，所以这个字段必须给值。但 pi-ai 会把它原样发成 `parameters.max_tokens`，而 Qoder
  网关对 `max_tokens > 131072` 的请求返回一个**内容为空的 200 流**，里面只有一个
  `provider_error` / "Error in upstream response" 帧 —— 每个请求都 502，表现就是「连不上」。
  实测（2026-10-21，`qoder-cn`）：Auto（200K）、Qwen3.8-Max（1M）、MiniMax-M3.1-Flash（200K）
  三个模型都在 131072 成功、131073 失败，说明这条上限是网关常量，与上下文窗口无关。
  因此 `index.js` 取 `min(contextWindow, MAX_OUTPUT_TOKENS = 131072)`（常量在
  `lib/upstream.js`，旁边记了测量方法）。

  > 0.3.6 修正：0.3.3 的说明写「刻意不声明 `maxTokens`」，但 `index.js` 从 0.3.0 起就一直在补这个
  > 值，当时补的是 `contextWindow`。填成上下文窗口会让所有 200K / 1M 模型的**每一个**请求都被上游
  > 拒绝，这正是 0.3.5 及之前「Qoder 连不上」的全部原因；`--list-models` 看起来完全正常，只有真发
  > 请求才暴露。留着错描述会诱导后人去「修」一个并不存在的问题。
  >
  > 注意 Trae 包的处理是**相反**的：`pi-connect-trae` 确实广告 `maxTokens`，且没有做这道收敛。
  > 两个包各自继承了对应 DSH 插件的原决策，没有强行统一。

## 随包 skill：查模型目录

包里带一个 skill `pi-connect-model-catalog`（`skills/model-catalog/SKILL.md`，由 `package.json` 的
`pi.skills` 声明）：告诉 agent 怎么拿到当前模型清单 —— `pi --list-models`、插件的目录缓存
（`.qoder-catalog.<region>.json` 的 `contextOptions` / `effortLevels` / `promotion`）、
强制刷新（跑一次会话）、以及 `models-store.json` / DSH / 昔涟 里的同一份目录，附带常见坑
（`Auto` 只有 200K、Trae 没有磁盘缓存、本地工作副本可能带过滤补丁、workbuddy 要走网关 `/v1/models`）。

- **npm 安装**（`pi install npm:@citie114514/pi-connect-qoder`）：skill 随包安装，直接用
  `/skill:pi-connect-model-catalog`；
- **目录安装**（把本目录复制到 `~/.pi/agent/extensions/`）：pi 不从扩展目录读 skill，需要把
  `skills/model-catalog/` 放到 `~/.agents/skills/pi-connect-model-catalog/`（本机已放好，并硬链接到
  `.codex` / `.dsh` / `.trae` / `.trae-cn` / `.workbuddy` / `.workbuddy-ai` / opencode 的 skills 目录）。

## 许可

MIT
