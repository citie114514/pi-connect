# pi-connect-free

把**本机已经登录的账号**和**上游公开发布的免费池**接进 Pi coding agent。不需要注册新账号，不需要注册 API Key，也不需要粘贴任何 token。

```
Pi provider
  -> 127.0.0.1:<随机端口>/v1   （本包的回环网关，OpenAI 协议）
  -> 各渠道自己的私有协议
  -> 对应上游
```

## 支持哪些渠道

| 渠道 | provider id | 凭据从哪来 | 登录方式 |
| --- | --- | --- | --- |
| Kilo Free Pool | `free-kilo` | 无需凭据 | 上游公开发布的免密池 |
| Qoder CN / Qoder | `free-qoder-cn` / `free-qoder` | 本机桌面端登录态 | 复用已有登录 |
| TRAE CN / TRAE Global | `free-trae-cn` / `free-trae-ai` | 本机桌面端 / CLI 登录态 | 复用已有登录 |

Qoder / TRAE 不写任何凭据文件——它们每次都从各自桌面端读取。

### 验证到什么程度

诚实区分「实现并实测」与「实现但未联调」：

| 渠道 | 状态 |
| --- | --- |
| Kilo | ✅ 实测：15 个模型、完整流式对话 |
| TRAE CN | ✅ 实测：16 个模型 |
| Qoder | ✅ 实测：11 个模型，端到端对话通过 |

## 不支持哪些渠道

本包只管**不需要额外登录动作**的渠道：Kilo 的免密池，以及 Qoder / TRAE 两个
本机已登录的桌面端。其余账号类渠道（Cline、MiniMax、LobsterAI、CodeArts、
Raccoon 等）不在这里实现——它们各自需要设备码、回环回调或扫码等完整登录流程，
属于 `pi-connect-ourfreemodel` 的职责范围，不在本包重复。

## 安装

```powershell
pi install npm:@citie114514/pi-connect-free
```

或直接把本目录复制到 `~/.pi/agent/extensions/pi-connect-free`。

**依赖**：Qoder / TRAE 两个渠道复用同级 `pi-connect-qoder` 与 `pi-connect-trae`
的协议实现，本包不重复实现它们的私有协议。这两个包缺失时，对应渠道会跳过并在
日志里说明原因；其余渠道不受影响。

## 使用

```powershell
pi --list-models                                    # 列出所有渠道的模型
pi --provider free-kilo --model kilo-auto/free --print "你好"
pi --provider free-trae-cn --model Doubao-Seed-2.1-Turbo --print "你好"
```

模型 ID 不带渠道前缀（`kilo-auto/free`、`Doubao-Seed-2.1-Turbo` 这类），渠道由
provider 区分。同一模型可能出现在多个渠道下，按需要选。

Qoder 和 TRAE 不需要登录这一步——它们直接用桌面端已登录的账号。

## 测试

```powershell
node test-free.cjs
```

全部离线：上游用注入的 fetch 与受控响应代替，不消耗任何真实额度。

## 设计上的几个选择

- **模型目录落盘缓存**（`~/.pi/agent/cache/pi-connect-free/catalog-<渠道>.json`）。Pi 在 `--list-models`、启动时的选择器和 `/scoped-models` 里是**同步**读模型清单的，不落盘的话新进程只会看到空列表。
- **刷新不阻塞对话**。目录过期后的重新拉取在请求被接受之后才发起，绝不让用户等着它。
- **鉴权在路由之前**。回环网关的 bearer 是每进程随机生成的，未通过鉴权的请求连上游都不会碰——一个未鉴权的请求不该有机会花掉你的额度。
- **失败必须显式**。拿不到目录就抛错，不用空列表冒充成功；上游的错误原文保留在消息里，否则线上问题无法定位。
- **能力如实声明**。某个渠道没有额度查询端点就写 `balance: false` 并给出原因，而不是运行时静默失败。

## 已知边界

- Kilo 免费池的模型卡明确声明 **prompt 可能被上游记录并用于改进其服务**。请勿发送敏感内容。
- 免费额度由上游单方面决定，随时可能限流、变更或下线。本包只是这些渠道的客户端，不提供也不承诺任何额度。
- 上游协议是私有的，改动不通知。某个渠道失效时，通常需要更新对应通道的协议实现。
- 本包不保存对话内容、不上传统计；唯一落盘的是模型目录缓存。
