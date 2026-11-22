# pi-connect-ourfreemodel

把 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（`dsh-our-free-model`）
的免费池与已登录账号渠道接进 Pi coding agent。

**开箱即用**：服务本体已随包附带（`vendor/ofm/`），不需要装 DSH，不需要先装上游包，
也不需要任何额外运行时。

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

账号渠道的登录发生在 **Our Free Model 自己的管理页面**，本包不介入——这也是
不复刻登录流程的意义。要登录 LobsterAI / Qoder / TRAE 等：

```powershell
node "~/.pi/agent/extensions/pi-connect-ourfreemodel/vendor/ofm/packages/standalone/cli.mjs" --data-dir <Pi 的 ofm 数据目录>
```

启动时会打印一次性管理链接，在浏览器里打开即可登录账号、查看积分与额度。
**注意**：让这个独立进程使用的数据目录与 Pi 不同（见下节），否则两者会争同一把锁。

不登录账号也能用：免密免费池开箱即用，只是额度受上游限制。

## 数据目录与锁（重要）

默认数据目录是 **Pi 自己的路径**：

```
~/.pi/agent/cache/pi-connect-ourfreemodel/ofm-data
```

刻意**不与** `~/.our-free-model` 共用。原因：那个服务对数据目录加独占锁，一个目录
只能跑一个实例，而锁文件只记 pid、不记端口，所以第二个进程**无法接管**已有实例。
共用目录的后果不是「共享账号池」，而是「只要独立服务开着，Pi 就用不了」。

想让 Pi 用你已有的账号池，显式指定：

```powershell
$env:PI_OURFREEMODEL_DATA_DIR = "$env:USERPROFILE\.our-free-model"
```

代价是两者不能同时运行。

| 变量 | 作用 |
| --- | --- |
| `PI_OURFREEMODEL_DATA_DIR` | Pi 用的数据目录（优先级最高） |
| `OFM_HOME` | 上游自己的变量，本包在其未设置时也会用 |
| `PI_OURFREEMODEL_PATH` | 改用外部的 `dsh-our-free-model` 安装，而不是自带的 |

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

29 项离线断言：解析顺序（自带副本优先、外部安装作后备、覆盖变量可指定）、
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
| 账号渠道（LobsterAI / Qoder / TRAE 等） | ⚠️ 未联调：需先在管理页面登录 |

## 已知边界

- 免费额度由上游单方面决定，随时可能限流或下线；本包只是客户端。
- `/v1/models` 不发布模态信息，所以模型一律声明为纯文本输入。
- 若上游更新了渠道协议，需要重新同步 `vendor/ofm/`。
- 本包不保存对话内容或上传统计；落盘的只有模型清单缓存与 ofm 数据目录。
