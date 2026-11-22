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

## 账号渠道怎么登录

免密免费池**不需要登录**，装完就能用。

要接入已登录的账号渠道（LobsterAI / Qoder / TRAE / Cline / Loomy / Raccoon /
MiniMax / ZCode / Gemini），在 Pi 会话里执行：

```
/ourfreemodel-login     打开管理页面（一次性链接，10 分钟有效）
/ourfreemodel-status    查看服务状态与已接入的渠道
```

`/ourfreemodel-login` 会打开浏览器并同时把链接打印到终端——自动打开只是便利，
链接本身才是交付物（headless 会话、锁定的桌面都能手动访问）。链接带一次性
bootstrap token，打开后即失效；失效就再执行一次命令拿新的。

管理页面里可以：
- 逐个登录账号渠道、查看账号池与积分
- 查看/领取各渠道额度
- 调整模型可见性等设置

**为什么是在网页里登录而不是在 Pi 里敲命令**：这些渠道各自是不同协议
（设备码、回环回调、扫码、人机验证），Our Free Model 已经把它们全部实现了一遍。
在 Pi 侧再做一遍只会把协议工作分叉出去，上游一变就失配。所以本包负责的是
「让那个页面在 Pi 会话里够得着」，而不是再造一套登录。

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

## 测试

```powershell
node test-ourfreemodel.cjs
```

32 项离线断言：解析顺序（自带副本优先、外部安装作后备、覆盖变量可指定）、
数据目录优先级、key 读取、传输选择、模型行归一化、Pi 模型映射（含 Pi 渲染器
必需的 `input` / `cost` 字段）、缓存往返。

不联网、不启动服务、不消耗额度。

## 验证到什么程度

| 项目 | 状态 |
| --- | --- |
| 无 DSH / 无外部安装冷启动 | ✅ 实测：自带的 vendor 副本独立启动 |
| npm 打包产物（1.5 MB）独立运行 | ✅ 实测：解包后不依赖本机任何安装即可启动 |
| Pi 端到端对话 | ✅ 实测：`hy4-flash-free` 在 Pi 里返回正常回复 |
| 模型清单 | ✅ 实测：26 个模型 |
| 上游免费池可用性 | ⚠️ 波动：多数池当日返回 429（上游额度限制） |
| `/ourfreemodel-login` 管理页面 | ✅ 实测：页面 200、一次性 token 可换取管理会话 |
| `/ourfreemodel-status` 渠道列表 | ✅ 实测：10 个渠道 runtime ready |
| 账号渠道实际登录 | ⚠️ 未联调：本机未在管理页面登录过任何账号 |

## 已知边界

- 免费额度由上游单方面决定，随时可能限流或下线；本包只是客户端。
- `/v1/models` 不发布模态信息，所以模型一律声明为纯文本输入。
- 若上游更新了渠道协议，需要重新同步 `vendor/ofm/`。
- 本包不保存对话内容或上传统计；落盘的只有模型清单缓存与 ofm 数据目录。
