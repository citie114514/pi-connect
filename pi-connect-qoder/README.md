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
- **刻意不声明 `maxTokens`。** 一旦声明，pi-ai 会把它当作输出上限发成 `max_tokens`，而推理与
  回答共用这份预算，长回复会被从中间截断并报 `finish: max-tokens`。请求上限走
  `options.maxTokens`，模型只广告 `contextWindow` 供 `--list-models` 显示。

  > 0.3.3 修正：本 README 此前写成「额外广告 `maxTokens = contextWindow`」，与代码恰好相反 ——
  > Qoder 侧一直是不声明的。留着错描述会诱导后人去「修」一个并不存在的问题。
  >
  > 注意 Trae 包的处理是**相反**的：`pi-connect-trae` 确实广告 `maxTokens`。两个包各自继承了
  > 对应 DSH 插件的原决策，没有强行统一。

## 许可

MIT
