# pi-connect-free

把**本机已经登录的账号**和**上游公开发布的免费池**接进 Pi coding agent。不需要注册新账号，不需要注册 API Key，也不需要粘贴任何 token。

```
Pi provider
  -> 127.0.0.1:<随机端口>/v1   （本包的回环网关，OpenAI 协议）
  -> 各渠道自己的私有协议
  -> 对应上游
```

## 支持哪些渠道

| 渠道 | 凭据从哪来 | 说明 |
| --- | --- | --- |
| Kilo Free Pool | 无需凭据 | 上游公开发布的免密免费池（`isFree` 清单） |
| Qoder CN / Qoder | 本机 Qoder 桌面端登录态 | 复用 `pi-connect-qoder` 的协议实现 |
| TRAE CN / TRAE Global | 本机 TRAE 桌面端 / CLI 登录态 | 复用 `pi-connect-trae` 的协议实现 |

两个 Qoder 区域与两个 TRAE 区域各自独立，未登录的区域不会启动服务、不会占用端口。

## 不支持哪些渠道，以及为什么

以下两类**刻意不实现**，原因写在 `src/registry.js` 里，面板与日志也会如实说明：

- **OpenCode Zen**：它的免费层只对「伪装成官方 CLI」的请求放行——伪造 User-Agent、构造一个能被服务端解码回时间戳的会话 ID、并附带请求方从未声明过的工具定义。这是在绕开上游正在主动做的准入判断，而且上游每次收紧校验都要重写一遍。本包不做。
- **ZCode**：它的登录需要驱动浏览器通过人机验证。本包不做验证码自动化。

这两类与「协议适配」不是一回事：前者是上游在问「你是不是官方客户端」，伪装就是在说谎；后者把模型插件变成自动化工具。

## 安装

```powershell
pi install npm:@citie114514/pi-connect-free
```

或直接把本目录复制到 `~/.pi/agent/extensions/pi-connect-free`。

> 本包的 Qoder / TRAE 渠道依赖同级的 `pi-connect-qoder` 与 `pi-connect-trae`。这两个包缺失时，本包会跳过对应渠道并在日志里说明原因；Kilo 渠道不受影响。

## 使用

```powershell
pi --list-models                       # 看到 free-kilo / free-qoder-cn / free-trae-cn …
pi --provider free-trae-cn --model Doubao-Seed-2.1-Turbo --print "你好"
```

模型 ID 不带渠道前缀（`kilo-auto/free`、`Doubao-Seed-2.1-Turbo` 这类），渠道由 provider 区分。

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
