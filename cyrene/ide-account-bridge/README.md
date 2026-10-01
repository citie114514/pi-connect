# ide-account-bridge — Cyrene 插件源码

把本机**已经登录**的 Qoder 与 Trae 桌面账号接进 [Cyrene](https://github.com/Playa-Cyrene/Cyrene-Plugins)：
每个区域跑一个绑定 `127.0.0.1` 的回环服务，对外说 OpenAI 协议、对内翻译成该区域自己的私有协议，
用户在 Cyrene 的模型档案里填 Base URL + token 即可使用。

这是 `pi-connect` 两个 Pi 扩展的**宿主编译目标之一**：协议层（凭据读取、COSY / SOLO 签名、
回环 shim、模型目录、额度与签到）与 Pi 版共用，本目录只提供 Cyrene 侧的宿主适配层。

## 目录结构

```
ide-account-bridge/
├── src/
│   ├── entry.js               Cyrene 插件入口（register / unregister / open）
│   ├── qoder/
│   │   ├── runtime.js         区域运行时：凭据缓存 + 目录 + shim
│   │   ├── ops.js             额度 / 签到，返回结构化数据
│   │   ├── commands.js        同上的 Pi 版（斜杠命令），保留作参考
│   │   └── lib/               DSH 插件的协议模块，原样复用
│   └── trae/
│       ├── runtime.js         Trae 区域栈
│       ├── ops.js             额度 / 签到
│       ├── commands.js        Pi 版，保留作参考
│       └── lib/trae-core.js   从 DSH bundle 手术提取的协议核心
├── panel/                     面板窗口（index.html + panel.js）
├── smoke-test.cjs             SDK Mock Context 冒烟测试
└── package.json
```

## 构建

```bash
npm install
npx esbuild src/entry.js --bundle --platform=node --format=cjs --target=node22 \
  --outfile=dist/index.cjs --external:electron --legal-comments=none \
  --footer:js='var __p = module.exports.default; module.exports = __p; module.exports.default = __p;'
```

产物 `dist/index.cjs` 即 Cyrene 插件目录里的入口文件，与 `manifest.json`、`README.md`、
`THIRD_PARTY_NOTICES.md`、`panel/` 一起打包为可安装的插件目录。

**`--footer` 不是可选项**：源码用 `export default`，esbuild 的 CJS 输出会得到
`{ default: plugin }`，而宿主按 `module.exports = plugin` 取用。少了这一行，插件加载后
`register` 会取不到。

**`--external:electron`** 同理：`electron` 由宿主在运行时提供，不能打进产物，否则
「空目录 require 入口文件不抛 MODULE_NOT_FOUND」这项自包含检查会失败。

## 测试

```bash
node smoke-test.cjs     # 14 项断言：工具 / IPC / 契约 / dispose 可重复调用
```

冒烟测试用 SDK 的 `createMockPluginContext()`，不需要安装 Cyrene。

## 与 Pi 版的关系

同一套协议层有两个宿主编译目标：

| | Pi 版 | Cyrene 版（本目录） |
| --- | --- | --- |
| 交付形态 | npm 包 `@citie114514/pi-connect-qoder` / `-trae` | 插件目录（ZIP） |
| 模型接入 | `pi.registerProvider` 注册原生 provider | 回环端点 + 用户手填 Base URL |
| 上下文窗口 | 扩展广告的 `contextWindow`（默认取上游公布的最大档） | 用户在每个模型档案里手填 `contextWindowTokens` |
| 用量 / 签到 | Pi 斜杠命令 | 面板按钮 + Agent 工具 |
| 协议层 | 共用 | 共用 |

两处宿主差异已参数化：凭据与缓存根路径由宿主注入（`cacheRoot` / `setTraeOwnDir()`），
用量与签到返回结构化数据而非直接调用宿主 UI。

## 上下文窗口（为何 Cyrene 侧不用改）

Cyrene 的模型档案自带 `contextWindowTokens`，在设置里手填（宿主默认 256K），插件不参与这个值 ——
所以**没有 Pi 版那个「不可达的保守默认」缺陷**：想要 1M 就在档案里填 1000000。

残留限制：插件给的模型列表只有 `{ id, name }`，回环 shim 的 `/v1/models` 也只有
`{ id, object, created, owned_by }`，都**不带上下文长度**，因此新增端点或换模型时仍要手填。
Cyrene 侧的 `subscription-oauth` 插件其实认 `context_length` / `context_window` /
`max_input_tokens` 等字段（`lib/model-context.cjs` 的 `CATALOG_FIELDS`），缺失时才按模型族兜底；
要让它自动识别，需要给两个 shim 的 `/v1/models` 补上这些字段。

## 许可

MIT。协议层来自 `@eghrhegpe/dsh-connect-qoder` 与 `dsh-connect-trae`（均为 MIT），
逐项归属见插件目录内的 `THIRD_PARTY_NOTICES.md`。
