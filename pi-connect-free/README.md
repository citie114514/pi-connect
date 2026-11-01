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
| Cline | `free-cline` | 本包内登录 | WorkOS 设备码 |
| MiniMax Code | `free-minimax` | 本包内登录 | 设备码 + PKCE |
| LobsterAI（有道） | `free-lobsterai` | 本包内登录 | 浏览器授权，回环回调 |
| CodeArts（华为云） | `free-codearts` | 本包内登录 | 浏览器授权，回环回调 |
| Raccoon Work（商汤） | `free-raccoon` | 本包内登录 | 扫码 |
| Qoder CN / Qoder | `free-qoder-cn` / `free-qoder` | 本机桌面端登录态 | 复用已有登录 |
| TRAE CN / TRAE Global | `free-trae-cn` / `free-trae-ai` | 本机桌面端 / CLI 登录态 | 复用已有登录 |

凭据保存在 `~/.pi/agent/cache/pi-connect-free/credential-<渠道>.json`（0600）。
Qoder / TRAE 不写这个文件——它们每次都从各自桌面端读取。

### 验证到什么程度

诚实区分「实现并实测」与「实现但未联调」：

| 渠道 | 状态 |
| --- | --- |
| Kilo | ✅ 实测：15 个模型、完整流式对话 |
| TRAE CN | ✅ 实测：16 个模型 |
| Cline | ✅ 设备码端点实测取到短码，轮询正确 |
| MiniMax | ✅ 设备码端点实测取到短码，`slow_down` 累积生效，协议翻译有单测 |
| CodeArts | ✅ 签名格式与可重复性实测 |
| LobsterAI | ⚠️ 已实现，本机无登录态，**未跑通真实授权** |
| Raccoon | ⚠️ 已实现，本机无登录态，**未跑通真实授权** |
| Qoder | ⚠️ 本机 token 已过期，上游返回 403 |

标 ⚠️ 的三个是最可能还需要调整的。

## 不支持哪些渠道，以及为什么

以下三类**刻意不实现**，原因写在 `src/registry.js` 里，面板与日志也会如实说明：

- **OpenCode Zen**：免费层只对「伪装成官方 CLI」的请求放行——伪造 User-Agent、
  构造能被服务端解码回时间戳的会话 ID、并附带请求方从未声明过的工具定义。
- **Gemini（Cloud Code Assist）**：要求逐字节复刻另一个厂商的客户端——五个身份头
  写死、不多带任何头、JSON 按字母序序列化，使请求与那个客户端无法区分。
- **ZCode**：登录需要驱动浏览器通过人机验证。

这三类与「协议适配」不是一回事：上游在判断「你是谁」，而这些做法是在给出一个
不真实的答案。它们也会在上游每次收紧校验时失效。

## 安装

```powershell
pi install npm:@citie114514/pi-connect-free
```

或直接把本目录复制到 `~/.pi/agent/extensions/pi-connect-free`。

**依赖**：Qoder / TRAE 两个渠道复用同级 `pi-connect-qoder` 与 `pi-connect-trae`
的协议实现，本包不重复实现它们的私有协议。这两个包缺失时，对应渠道会跳过并在
日志里说明原因；其余渠道不受影响。

## 登录

在 Pi 里输入：

```
/free-status              查看哪些渠道需要登录
/free-login minimax       登录 MiniMax（设备码）
/free-login cline         登录 Cline（设备码）
/free-login lobsterai     登录 LobsterAI（浏览器授权）
/free-login codearts      登录 CodeArts（浏览器授权）
/free-login raccoon       登录 Raccoon（扫码）
/free-logout minimax      清除登录
```

设备码渠道会给出一个 URL 和短码：打开 URL，输入短码，回来等它自动完成。
回调渠道只要在浏览器里点授权，本机监听会接住回跳。扫码渠道把给出的 URL 用手机扫。

Qoder 和 TRAE 不需要这一步——它们直接用桌面端已登录的账号。

## 使用

```powershell
pi --list-models                                    # 列出所有渠道的模型
pi --provider free-kilo --model kilo-auto/free --print "你好"
pi --provider free-trae-cn --model Doubao-Seed-2.1-Turbo --print "你好"
```

模型 ID 不带渠道前缀（`kilo-auto/free`、`Doubao-Seed-2.1-Turbo` 这类），渠道由
provider 区分。同一模型可能出现在多个渠道下，按需要选。

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
- **缺的渠道是刻意缺的**，不是没做完：OpenCode Zen / Gemini / ZCode 三类需要伪装成
  另一家客户端或绕过人机验证，见上文「不支持哪些渠道」。`/free-status` 与
  `EXCLUDED_CHANNELS` 里都能查到同一份理由。
- 本包不保存对话内容、不上传统计；唯一落盘的是各渠道的凭据与模型目录缓存。
