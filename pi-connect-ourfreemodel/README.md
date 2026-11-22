# pi-connect-ourfreemodel

把 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（`dsh-our-free-model`）
的免费池与已登录账号渠道接进 Pi coding agent。

本包是一个**很薄的适配层**，这是刻意的设计。

## 为什么是薄适配层

Our Free Model 本身已经是一个完整的本地 OpenAI 兼容服务
（`packages/standalone/service.mjs`），它自己负责：

- 全部账号渠道及其登录流程（LobsterAI / Qoder / TRAE / Cline / Loomy /
  Raccoon / MiniMax / ZCode / Gemini），
- 匿名免费池，
- 账号池、积分领取与额度账本。

在 Pi 侧重新实现任何一项都会把协议工作分叉出去，而上游渠道一变就会失配。
所以本包只做两件事：**启动那个服务**，并**注册一个指向它的 Pi provider**。
Pi 看到的是一个普通的 OpenAI provider；干活的是 Our Free Model。

```
Pi provider "ourfree"
  -> 127.0.0.1:<随机端口>/v1    （Our Free Model 自己的 standalone 服务）
  -> 各渠道自己的私有协议 / 免费池
  -> 上游
```

## 前置条件

必须已安装 `dsh-our-free-model`。本包按以下顺序查找：

1. `PI_OURFREEMODEL_PATH`（显式指定，优先级最高）
2. `$DSH_HOME/profiles/desktop/node_modules/dsh-our-free-model`（默认 `~/.dsh`）
3. `~/.dsh/pi-extensions/dsh-our-free-model`

版本必须包含 `packages/standalone/service.mjs`（2.x 起有）。找不到或版本太旧时，
`/ourfreemodel-status` 会给出具体原因，而不是笼统的「不可用」。

## 安装

```powershell
pi install npm:@citie114514/pi-connect-ourfreemodel
```

或直接把本目录复制到 `~/.pi/agent/extensions/pi-connect-ourfreemodel`。

## 使用

```powershell
pi --list-models                                     # 模型出现在 provider "ourfree" 下
pi --provider ourfree --model hy4-flash-free --print "你好"
```

渠道在模型列表里是**平铺**的：Our Free Model 用同一份 `/v1/models` 暴露所有渠道，
按模型 id 在内部路由。所以没有「每个渠道一个 provider」——那会和上游模型重复。

## 数据目录与锁

默认复用 Our Free Model 自己的目录（`~/.our-free-model`，或 `OFM_HOME`），
这样你在它的管理页面登录的账号，就是 Pi 用的账号，不会多出一个空账号池。

**代价**：那个服务对数据目录上独占锁，一个目录只能跑一个实例，而锁文件只记 pid、
不记端口，所以第二个进程**无法接管**已有实例。因此：

- 同时开着独立服务（`npm run start:standalone`）时，Pi 会明确报
  「另一个 Our Free Model 实例正在使用数据目录」，而不是静默失败；
- 想让两者并用，用 `PI_OURFREEMODEL_DATA_DIR` 给 Pi 单独指一个目录
  （账号需要各自登录一次）。

## 免费池的 Bun 依赖

Our Free Model 的 OpenCode 免费通道默认优先通过本地 **Bun** 转发，没有 Bun 时会
直接拒绝该通道，所有免费模型都会 502。本包在启动前会自己判断一次：

- 你显式设了 `OUR_FREE_MODEL_FREE_TRANSPORT`（`node` / `bun` / `auto`）→ 尊重你的设置；
- 本机确实能找到 Bun（PATH 或 `OUR_FREE_MODEL_BUN`）→ 保持 `auto`；
- 否则 → 固定为 `node`，即上游保留的旧传输，不需要额外运行时。

否则「装完就能用」在纯 Node 机器上是不成立的，那是本包必须替用户判断的一件事。

## 模型缓存

Pi 在 `--list-models`、启动选择器和 `/scoped-models` 里是**同步**读模型清单的，
不会等网络请求。所以清单会落盘到
`~/.pi/agent/cache/pi-connect-ourfreemodel/catalog.json`：

- 有缓存时，冷启动直接读缓存，请求路径再按 TTL（10 分钟）后台刷新；
- **缓存为空时**，激活后做一次后台引导：起服务、读清单、**立刻关掉服务**。
  关掉是必须的——服务持有独占锁，不关会让本进程后续每个请求都失败。

## 测试

```powershell
node test-ourfreemodel.cjs
```

28 项离线断言：安装解析（含「版本太旧」的专门报错）、数据目录优先级、
key 读取、传输选择、模型行归一化、Pi 模型映射（含 Pi 渲染器必需的
`input` / `cost` 字段）、缓存往返。

不联网、不启动服务、不消耗任何额度。真实联调结果记录在下方。

## 验证到什么程度

| 项目 | 状态 |
| --- | --- |
| 服务启动 / 模型清单 | ✅ 实测：26 个模型 |
| Pi 端到端对话 | ✅ 实测：`hy4-flash-free` 在 Pi 里返回正常回复 |
| 上游免费池可用性 | ⚠️ 波动：多数池当日返回 429（上游额度），少量可用 |
| 账号渠道（LobsterAI / Qoder / TRAE 等） | ⚠️ 未联调：本机 `~/.our-free-model` 无已登录渠道 |

账号渠道的登录发生在 Our Free Model 自己的管理页面（启动时打印的一次性链接），
本包不介入——这也是不复刻登录流程的意义。

## 已知边界

- 免费额度由上游单方面决定，随时可能限流或下线；本包只是客户端。
- `/v1/models` 不发布模态信息，所以模型一律声明为纯文本输入。声称支持图像而未
  验证过，只会在发送时变成一次失败请求。
- 本包不保存对话内容或上传统计；落盘的只有模型清单缓存。
