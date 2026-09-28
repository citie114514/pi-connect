# DSH Connect Qoder / Trae → Pi 移植

把 DeepSeek Harness 的两个插件移植为 **Pi coding agent** 扩展，直接生效可用：

| 上游插件 | Pi provider | 说明 |
| --- | --- | --- |
| `@eghrhegpe/dsh-connect-qoder` v0.3.2 | `qoder-cn`、`qoder` | 国内版 / 国际版 Qoder 并行 |
| `dsh-connect-trae` v2.3.1 | `trae`、`trae-global` | 国内版 / 国际版 Trae 并行 |

本仓库是一个 npm workspaces 单仓库，产出两个可发布到 npm 的 Pi 扩展包
（`@citie114514/dsh-connect-qoder-pi`、`@citie114514/dsh-connect-trae-pi`）。


## 工作原理

两个扩展都复用了 DSH 插件的协议与凭据逻辑，改造成 Pi 的 **native provider**（与 Pi 内置 llama.cpp 扩展同一套接口）：

```
Pi 模型运行时（openAI-completions API）
  -> 回环 shim（127.0.0.1 随机端口 + 进程内随机 secret）
  -> 原插件的上游协议（Qoder COSY 签名 / Trae SOLO 协议）
  -> 各自网关
```

- **凭据**：读取本机 Qoder / Trae 桌面应用自己的登录（OSCrypt/DPAPI、storage.json），零配置，不写应用文件，不启动 OAuth。
- **认证**：`auth.apiKey.check()` 只认已登录的区域（未登录的区域不出现）；`auth.apiKey.resolve()` 每次请求把 shim 的 bearer token 交给 Pi。Qoder/Trae 的真实令牌从不进入 Pi。
- **目录**：`refreshModels()` 拉取实时模型目录；失败时保留磁盘缓存的最后一份（Qoder CatalogStore / Trae 静态 fallback）。
- **推理档位**：保留了 DSH 插件的关键决策 —— `compat.supportsDeveloperRole: false`（Qoder 不接受 developer 角色）、不声明 `maxTokens` 输出上限（pi-ai 只发 `options.maxTokens`，模型字段仅作思考预算上限，广告为 contextWindow 以兼容 `--list-models` 显示）。

## 目录

```
pi-extensions/                        (仓库根：npm workspaces)
├─ package.json          workspaces + pack/publish 脚本
├─ .gitignore            node_modules / dist / *.tgz
├─ LICENSE               MIT（含上游归属说明）
├─ README.md             本文件
├─ dsh-connect-qoder/
│  ├─ index.js            Pi 扩展入口（注册 qoder-cn / qoder）
│  ├─ commands.js         /qoder-usage、/qoder-checkin
│  ├─ package.json        npm 包元数据 + pi.extensions 清单
│  ├─ README.md           包说明
│  ├─ THIRD_PARTY_NOTICES.md  上游 MIT 归属
│  └─ lib/                原插件无依赖协议模块（原样复用）
├─ dsh-connect-trae/
│  ├─ index.js            Pi 扩展入口（注册 trae / trae-global）
│  ├─ commands.js         /trae-usage、/trae-checkin
│  ├─ build-core.mjs      从 DSH bundle 生成 lib/trae-core.js 的构建脚本
│  ├─ package.json        npm 包元数据 + pi.extensions 清单
│  ├─ README.md           包说明
│  ├─ THIRD_PARTY_NOTICES.md  上游 MIT 归属
│  └─ lib/trae-core.js    从 DSH bundle 手术提取的协议核心
└─ dist/                  npm pack 产物（.tgz，已 gitignore）
```

### trae-core.js 的提取方式

`build-core.mjs` 对 `profiles/desktop/node_modules/dsh-connect-trae/lib/index.js` 做四处手术：

1. 替换 `@deepseek-ai/*` 依赖为 Node 内置（`node:fs/promises` 等）；
2. 删除 DSH 专用 adapter 区（`createTraeAdapter` / `PiAiAdapter` / `resolveRetryPolicy`）；
3. 插件自有凭据副本路径从 `resolveDshHome()` 改为 `~/.pi/agent/cache/dsh-connect-trae/`；
4. 保留协议核心 **与 usage/web-status 的纯逻辑**（`TraeUsageClient`、`toCredits`、`toCheckin`、
   签到守卫），只剥离 model-config/model-detail/DSH 入口区，并补 `pi-entry` 导出。

## 安装

```powershell
# 已安装：~/.pi/agent/extensions/{dsh-connect-qoder,dsh-connect-trae}/
# 重新安装（从本目录）：
Copy-Item pi-extensions\dsh-connect-qoder  C:\Users\citie\.pi\agent\extensions\dsh-connect-qoder -Recurse -Force
Copy-Item pi-extensions\dsh-connect-trae   C:\Users\citie\.pi\agent\extensions\dsh-connect-trae  -Recurse -Force
```

Pi 启动时自动发现 `~/.pi/agent/extensions/` 下的扩展（目录级 `package.json` 的 `pi.extensions` 清单）。

### 从 npm 包安装

两个包也可打成 npm 包分发：

```powershell
npm run pack          # 在本仓库根目录执行，产物写入 dist/
pi install npm:@citie114514/dsh-connect-qoder-pi
pi install npm:@citie114514/dsh-connect-trae-pi
```

> **两种方式二选一**：`extensions/` 目录直接安装与 `pi install`（写入 settings.json）同时使用会让
> 供应商注册两次。

### 发布到 Pi 官方包画廊（pi.dev/packages）

Pi 没有独立的插件服务器 —— **官方包画廊索引的就是 npm**。按 Pi 官方
[package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)：
带 `"keywords": ["pi-package"]` 的 npm 包会被 [pi.dev/packages](https://pi.dev/packages) 自动收录。

已满足的发布要求：

| 要求 | 状态 |
| --- | --- |
| `keywords` 含 `pi-package` | ✅ 两个包都有 |
| `pi.extensions` 清单 | ✅ |
| 导入的 Pi 包声明为 `peerDependencies`（`"*"`，不打包） | ✅ `@earendil-works/pi-ai` |
| `license` | ✅ MIT |
| 上游归属（MIT 要求保留版权） | ✅ `THIRD_PARTY_NOTICES.md` |
| `repository` / `homepage` / `bugs` | ✅ 指向本仓库 |
| scoped 包 `publishConfig.access = public` | ✅ |

发布步骤（需要先登录）：

```powershell
gh auth login                 # 首次：登录 GitHub（用 HTTPS 或 SSH）
gh repo create dsh-connect-pi --public --source=. --remote=origin --push

npm login                     # 首次：登录 npm
npm run publish:qoder
npm run publish:trae
```

发布成功后画廊会在数分钟内自动收录，用户即可 `pi install npm:@citie114514/dsh-connect-qoder-pi`。


## 扩展生命周期（遵循 Pi 官方约定）

Pi 官方 `docs/extensions.md` 要求：**不要在扩展 factory 里启动 socket/进程，长生命周期资源应在
`session_start` 或首次真正需要时启动**。两个扩展都遵循该约定：

- **factory** 只 `registerProvider`（读缓存目录/静态 fallback，**不开 socket、不联网、不读凭据**）；
- **`session_start`** 预热 shim 并拉取实时模型目录；
- **`auth.apiKey.resolve`**（请求路径）按需启动 shim，并把实时 `baseUrl` 随 auth 一起交给 Pi
  （`ModelRuntime.prepareRequest` 会用它覆盖模型的 baseUrl）；
- **`session_shutdown`** 关闭 shim；两个 shim 的 server 都调用了 `unref()`，因此即使某个
  session-less 调用触发了 shim，也绝不会拖住进程退出。

实测：`pi --list-models` 期间 **0 个 socket**（日志无 `ready:`），会话内才启动 3 个 shim。


## 命令

DSH 版把用量/签到放在设置卡片里；Pi 没有卡片，因此改为斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/qoder-usage` | Qoder 各区域额度、促销活动、今日签到状态 |
| `/qoder-checkin` | 领取 Qoder 今日签到额度（唯一改动账号状态的操作，先确认） |
| `/trae-usage` | Trae 各区域额度（CN 积分 / 国际订阅）与今日签到状态 |
| `/trae-checkin` | 领取 Trae 今日签到奖励（仅国内版，先确认） |

签到守卫与 DSH 版一致：**先读状态**，账号今日已领或本设备今日已签到则不发起领取请求。

## 使用

```powershell
pi --list-models                       # 查看全部模型（含 qoder-cn / qoder / trae）
pi --provider qoder-cn --model DeepSeek-Flash --print "你好"
pi --provider trae --model DeepSeek-V4-Flash-Official --print "你好"
# 在交互式会话中：
/qoder-usage
/trae-checkin
```

## 验证结果（2026-09-28）

- `pi --list-models`：qoder-cn 14 模型、qoder 2 模型、trae 4 模型全部列出；
- `pi --print` 实测对话：qoder-cn（DeepSeek-Flash）、trae（DeepSeek-V4-Flash-Official）均正常回复；
- `trae` 完整 agent 工具会话（14 工具）实测算出 17×23=391、12×34=408；
- 命令实测：`/trae-usage` 读到 CN 额度 650/650 与今日已签到；`/qoder-usage` 读到 CN 额度
  167/300 与今日可领 100 credits；
- `trae-global` 本机无国际版登录，正确跳过；`qoder`（国际版）上游偶发 `provider_error` 为该账号额度/网关问题（与 DSH 插件 README 记录的已知行为一致），非移植缺陷。
- `npm pack` 产物解包后单独加载，14+2+4 模型全部注册、对话正常。

## 与 DSH 版本的差异

- 移除了 DSH 专属的**设置卡片与私有 web 路由**（依赖 DSH 宿主）；用量 / 每日签到改为斜杠命令，
  逻辑与守卫完整保留；
- Trae 的 Raw Chat 回退通道未接线（协议核心仍在 `lib/trae-core.js`，需要时可再补）；
- 插件自有凭据副本落在 `~/.pi/agent/cache/<name>/`；
- 模型描述符额外广告 `maxTokens`：Pi 的 `--list-models` 不做 undefined 保护，而该字段只约束
  思考预算（请求上限走 `options.maxTokens`），因此不会截断回复。
