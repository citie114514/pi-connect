# pi-connect-ourfreemodel

把 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（`dsh-our-free-model`）
的免费池与已登录账号渠道接进 Pi coding agent。

**开箱即用**：服务本体已随包附带（`vendor/ofm/`），不需要装 DSH，不需要先装上游包，
也不需要任何额外运行时。免密免费池装完即可对话；账号渠道在 Pi 里用
`/ourfreemodel-login` 打开管理页面登录。

## 为什么是薄适配层 + 自带服务

Our Free Model 本身是一个完整的本地 OpenAI 兼容服务
（`packages/standalone/service.mjs`），它自己负责全部账号渠道及其登录流程
（LobsterAI / Qoder / TRAE / Cline / Loomy / Raccoon / MiniMax / ZCode / Gemini）、
匿名免费池、账号池、积分领取与额度账本。

在 Pi 侧重新实现任何一项都会把协议工作分叉出去，上游一变就失配。所以本包只做两件事：
**启动随包附带的那份服务**，并**注册一个指向它的 Pi provider**。

```
Pi provider "ourfree"
  -> 127.0.0.1:<随机端口>/v1    （vendor/ofm 里的 standalone 服务）
  -> 各渠道自己的私有协议 / 免费池
  -> 上游
```

`vendor/ofm/` 的内容严格取自上游 `scripts/pack-standalone.mjs` 的
`standaloneSourceFiles()` 清单（上游为「独立本地服务」定义的权威文件集），
减去 DSH 插件入口、桌面壳和 34 MB 的预编译引擎分片。共 102 个文件、约 5.3 MiB。
未修改任何上游源码，详见 `THIRD_PARTY_NOTICES.md`。

## 安装

```powershell
pi install npm:@citie114514/pi-connect-ourfreemodel
```

或直接把本目录复制到 `~/.pi/agent/extensions/pi-connect-ourfreemodel`。

装完即可用，没有额外前置条件。

## 使用

```powershell
pi --list-models                                     # 模型出现在 provider "ourfree" 下
pi --provider ourfree --model hy4-flash-free --print "你好"
```

渠道在模型列表里是**平铺**的：Our Free Model 用同一份 `/v1/models` 暴露所有渠道，
按模型 id 在内部路由。

### 与 pi-connect-qoder / pi-connect-trae 的关系

本包也有 Qoder 和 TRAE 渠道，但它们**从本机桌面应用读取登录态**是那两个独立包的
做法；本包的这两个渠道需要你在管理页面里用账号登录一次。

两边都装是本包推荐的用法（各自独立、互不影响），代价是同一个模型可能同时出现在
`trae` 和 `ourfree` 下。这不是冲突——provider 不同，选哪个都能用：

| 需求 | 用哪个 |
| --- | --- |
| 只想用桌面端已登录的 Qoder / TRAE | `qoder-cn` / `trae`（独立包，零配置） |
| 想用 LobsterAI / Loomy / Raccoon / Cline / MiniMax / ZCode / Gemini | `ourfree`（本包独有） |
| Qoder / TRAE 有多账号、要账号池与积分管理 | `ourfree`（本包提供账号池） |

如果只想用本包独有的渠道，不登录这里的 Qoder / TRAE 即可——未登录的渠道不产生
任何模型，列表里自然不会有重复项。

## 账号渠道怎么登录

免密免费池**不需要登录**，装完就能用。

要接入已登录的账号渠道，在 Pi 会话里执行：

```
/ourfreemodel-login     打开管理页面（一次性链接，10 分钟有效）
/ourfreemodel-status    查看各渠道登录状态
```

### 具体步骤

1. 在 Pi 里输入 `/ourfreemodel-login`。它会打开浏览器并同时把链接打印到终端。
2. 管理页面左侧选 **免费账号渠道**，选一个渠道（如 LobsterAI）。
3. 点该渠道的**添加账号**。各渠道的登录方式不同：

| 渠道 | 登录方式 |
| --- | --- |
| LobsterAI（有道） | 点「添加账号」后会打开有道授权页，浏览器登录后自动回跳 |
| Qoder / Qoder CN | 同设备码/授权页形式，授权后自动回跳 |
| TRAE | 授权页回跳 |
| Cline / Loomy / Raccoon | 各自的设备码或扫码流程，页面会给出指引 |
| MiniMax / ZCode / Gemini | 设备码或授权页 |

回跳地址是本机的 `127.0.0.1:<随机端口>/auth/callback`，由服务自己接住，
不需要你复制粘贴任何 token。

4. 回到 Pi，模型列表里就会出现该渠道的模型（`/ourfreemodel-status` 可确认）。

### `/ourfreemodel-status` 会告诉你什么

```
数据目录：C:\Users\...\pi-connect-ourfreemodel\ofm-data
服务版本：2.7.2（随包附带）
渠道运行时：ready
已登录：lobsterai（1/2 账号启用）
未登录：qoder、traecn、cline、loomy、raccoon、minimax、gemini、zcode
```

账号数来自 `provider.status`——和你在管理页面看到的是同一个数据源。
如果那次调用失败，会明确显示「登录状态暂时无法读取」，**而不是显示成 0 个账号**
（"问不到" 和 "确实没登录" 需要你做不同的事）。

### 为什么是在网页里登录而不是在 Pi 里敲命令

这些渠道各自是不同协议（授权页回跳、设备码、扫码、短信验证码），Our Free Model
已经把它们全部实现了一遍。在 Pi 侧再做一遍只会把协议工作分叉出去，上游一变就
失配。所以本包负责的是「让那个页面在 Pi 会话里够得着」，而不是再造一套登录。

关键点：开这个页面**不需要另起进程**——服务本来就在 Pi 进程里跑着，所以不存在
和数据目录锁冲突的问题（这正是下面数据目录那节的约束）。

## 数据目录与锁（重要）

默认数据目录是 **Pi 自己的路径**：

```
~/.pi/agent/cache/pi-connect-ourfreemodel/ofm-data
```

刻意**不与** `~/.our-free-model` 共用。原因：那个服务对数据目录加独占锁，一个目录
只能跑一个实例，而锁文件只记 pid、不记端口，所以第二个进程**无法接管**已有实例。
共用目录的后果不是「共享账号池」，而是「只要独立服务开着，Pi 就用不了」。

所以：**登录请用 `/ourfreemodel-login`**，不要另起 `cli.mjs` 进程。如果你确实要
在终端里跑独立服务（比如用它自己的网页看运行日志），把它指向另一个目录：

```powershell
node "$env:USERPROFILE\.pi\agent\extensions\pi-connect-ourfreemodel\vendor\ofm\packages\standalone\cli.mjs" --data-dir "$env:USERPROFILE\ofm-standalone"
```

| 变量 | 作用 |
| --- | --- |
| `PI_OURFREEMODEL_DATA_DIR` | Pi 用的数据目录（优先级最高） |
| `OFM_HOME` | 上游自己的变量，本包在其未设置时也会用 |
| `PI_OURFREEMODEL_PATH` | 改用外部的 `dsh-our-free-model` 安装，而不是自带的 |
| `PI_OFM_GEMINI_CLIENT_ID` / `_SECRET` | 覆盖内置的 Gemini CLI installed-app 客户端标识 |

## 免费池的 Bun 传输

Our Free Model 的 OpenCode 免费通道默认优先通过本地 **Bun** 转发，没有 Bun 时会
直接拒绝该通道。本包在启动前自行判断：

- 你显式设了 `OUR_FREE_MODEL_FREE_TRANSPORT`（`node` / `bun` / `auto`）→ 尊重你的设置；
- 本机确实能找到 Bun（PATH 或 `OUR_FREE_MODEL_BUN`）→ 保持 `auto`；
- 否则 → 固定为 `node`（上游保留的旧传输，不需要额外运行时）。

## 模型缓存

Pi 在 `--list-models`、启动选择器和 `/scoped-models` 里是**同步**读模型清单的，
不会等网络请求。所以清单落盘到
`~/.pi/agent/cache/pi-connect-ourfreemodel/catalog.json`：

- 有缓存时冷启动直接读缓存，请求路径再按 TTL（10 分钟）后台刷新；
- **缓存为空时**，激活后做一次后台引导：起服务、读清单、**立刻关掉服务**。
  关掉是必须的——服务持独占锁，不关会让本进程后续每个请求都失败。

### 为什么要等服务「频道就绪」才读清单

`/v1/models` 是服务把 `listProviders()` 里每个渠道的模型汇总出来的，而账号渠道
是在 HTTP 监听器已经起来**之后**才异步挂载上去的。实测（2026-11，含迁移账号的数据目录）：

| 时刻 | `/v1/models` |
| --- | --- |
| 监听器刚起（+0.5 s） | 26 个（只有免费池） |
| 频道挂载完成（+2.5 s） | 44 个（其中 18 个账号渠道） |

也就是说，一起服务就去读清单，读到的必然是**没有账号渠道**的那一版；而这一版会被
缓存 10 分钟——账号渠道要等 TTL 到期才可能出现。这不是上游的问题，是本包和
服务的启动时序赛跑输了，所以首次取清单改为等 `service.ready`（上限 20 秒）再读。
20 秒是相对实测 2–4 秒的宽松上限：冷启动还要读账号池，等久一点只是晚一会儿出清单，
而读早了是清单里整整十分钟没有付费渠道。

## 从 DSH 迁移已登录的账号渠道

如果本机 DSH 那边已经登录过渠道，不必在 Pi 里重新登录一遍。Our Free Model 的
standalone 只读自己的数据目录（源码注释明确「从不读取 DSH 文件」），所以迁移就是
把两处状态搬过来：

| 来源（DSH） | 目标（本包数据目录） | 内容 |
| --- | --- | --- |
| `~/.dsh/.credentials.yaml` 的 `refs:` | `channel-credentials.json` | 各渠道凭据（`{渠道: "JSON 字符串"}`） |
| `~/.dsh/channel-pack/state.json` | `channel-pack/state.json` | 账号池、禁用的模型、渠道顺序 |
| `~/.dsh/channel-pack/auto-checkin.json` | `channel-pack/auto-checkin.json` | 签到记录 |

`~/.dsh/.credentials.yaml` 的 `refs:` 是**明文**（YAML 单引号包住的 JSON 字符串），
`records:` 则是加密的授权记录——迁移只需要 `refs:`。

`channel-credentials.json` 写完后权限设为 `0600`。迁移后重启服务，
`/ourfreemodel-status` 会和你在管理页面看到的一致。

### 迁移只搬「登录态」，搬不动「上游还认不认」

这一点必须直说：迁移能保证凭据在本地就位，**不能**让已经失效的凭据复活。
实测某台机器迁移 5 个账号的结果：

| 渠道 | 结果 |
| --- | --- |
| Loomy | ✅ 可用，`loomy/DeepSeek-V4.1-Flash` 实测正常返回 |
| Raccoon | ❌ 登录态已过期（`登录态已过期，请重新登录`），其余模型上游限流超时 |
| MiniMax | ❌ `refresh_token 已失效，请重新登录` |
| ZCode | ❌ 上游并发限流 3009 / 该模型额度用尽 |
| CodeArts | ❌ 凭据本身已过期（DSH 里 `expires_at` 已过），服务直接忽略该账号 |
| Cline | ⚠️ 在 DSH 里就是禁用状态（`enabled: 0`），迁移过来也不产出模型 |

所以迁移后请用 `/ourfreemodel-status` 看一遍，失效的渠道用
`/ourfreemodel-login` 重新登录即可——那边本来也需要重登，与迁移无关。

## 测试

```powershell
node test-ourfreemodel.cjs
```

34 项离线断言：解析顺序（自带副本优先、外部安装作后备、覆盖变量可指定）、
数据目录优先级、key 读取、传输选择、模型行归一化、Pi 模型映射（含 Pi 渲染器
必需的 `input` / `cost` 字段）、缓存往返、频道就绪等待上限。

不联网、不启动服务、不消耗额度。

## 验证到什么程度

| 项目 | 状态 |
| --- | --- |
| 无 DSH / 无外部安装冷启动 | ✅ 实测：自带的 vendor 副本独立启动 |
| npm 打包产物（1.5 MB）独立运行 | ✅ 实测：解包后不依赖本机任何安装即可启动 |
| Pi 端到端对话（免费池） | ✅ 实测：`hy4-flash-free` 在 Pi 里返回正常回复 |
| Pi 端到端对话（迁移账号） | ✅ 实测：`loomy/DeepSeek-V4.1-Flash` 返回「你好」 |
| 模型清单 | ✅ 实测：44 个（26 免费池 + 18 迁移账号渠道），`pi --list-models` 正确渲染 |
| 从 DSH 迁移登录态 | ✅ 实测：5 个账号凭据就位，4 个渠道显示 `1/1`；可用性取决于上游是否仍认该凭据 |
| 上游免费池可用性 | ⚠️ 波动：多数池当日返回 429（上游额度限制） |
| `/ourfreemodel-login` 管理页面 | ✅ 实测：页面 200、一次性 token 可换取管理会话 |
| `/ourfreemodel-status` 登录状态 | ✅ 实测：经 `provider.status` 正确报告各渠道账号数 |
| 登录发起（`account.create`） | ✅ 实测：LobsterAI 返回真实授权 URL 与回环回调地址 |
| 登录回调完成 | ⚠️ 未联调：本机未走完任何渠道的授权 |

## 已知边界

- 免费额度由上游单方面决定，随时可能限流或下线；本包只是客户端。
- `/v1/models` 不发布模态信息，所以模型一律声明为纯文本输入。
- 若上游更新了渠道协议，需要重新同步 `vendor/ofm/`。
- 本包不保存对话内容或上传统计；落盘的只有模型清单缓存与 ofm 数据目录。
