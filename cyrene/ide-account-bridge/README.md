# ide-account-bridge — Cyrene 插件源码

把本机**已经登录**的 Qoder 与 Trae 桌面账号接进 [Cyrene](https://github.com/Playa-Cyrene/Cyrene-Plugins)：
每个区域跑一个绑定 `127.0.0.1` 的回环服务，对外说 OpenAI 协议、对内翻译成该区域自己的私有协议，
用户在 Cyrene 的模型档案里填 Base URL + token 即可使用。

这是 `pi-connect` 两个 Pi 扩展的**宿主编译目标之一**：协议层（凭据读取、COSY / SOLO 签名、
回环 shim、模型目录、额度与签到）与 Pi 版共用，本目录只提供 Cyrene 侧的宿主适配层。

## 目录结构

**源码树（本目录）**

```
ide-account-bridge/
├── src/
│   ├── entry.js               Cyrene 插件入口（register / unregister / open，IPC + 三个 Agent 工具）
│   ├── endpoints.js           回环端点持久化：端口 + bearer token，跨重启稳定
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
├── panel/                     面板窗口（index.html + panel.js）：端点 / 模型 / 额度 / 签到按钮
├── smoke-test.cjs             SDK Mock Context 冒烟测试（14 项断言）
├── test-endpoint-stability.cjs / test-nonblocking.cjs / test-trae-compare.cjs /
│   test-trae-nonstream.cjs    端点稳定性、非阻塞、Trae 对比与非流式回归测试
└── package.json
```

**打包产物（`dist/`，即导入 Cyrene 的插件目录）**

```
dist/
├── index.cjs                  入口：esbuild 打包的 CommonJS，自包含（见下）
├── manifest.json              插件清单（id / name / version / entry / defaultEnabled: false）
├── panel/                     面板资源（与源码 `panel/` 同一份，随包分发）
├── README.md                  面向上游用户的说明（用法 + 网络/文件/子进程/风险披露）
└── THIRD_PARTY_NOTICES.md     上游 MIT 归属与改动说明
```

> `manifest.json` / `THIRD_PARTY_NOTICES.md` 目前只存在于打包产物，未纳入仓库源码目录；
> 构建只有 `index.cjs` 是产物，其余四个是随包分发的手写/静态文件。

## 使用方法

> 本节是宿主侧用法的正本；打包分发给用户的版本是 `dist/README.md`，内容为它的
> 用户视角改写，并额外包含网络访问 / 文件读写 / 子进程 / 风险披露。

### 1. 安装与启用

1. 构建并整理出 `dist/`（见下），压成 `ide-account-bridge-<版本>.zip`；
2. Cyrene → **设置 → 插件 → 导入 ZIP**；
3. 在插件列表里**手动启用**（`manifest.json` 里 `defaultEnabled: false`，用户插件默认停用）；
4. 点插件页的 **Open / 打开**，调出配置面板。

未登录的桌面账号对应的区域不会出现在面板里，也**不会启动回环服务、不占端口**。

### 2. 在 Cyrene 里配模型档案

**设置 → 模型 → 新增模型档案**：

| 字段 | 填什么 |
| --- | --- |
| 协议 | **OpenAI 兼容** |
| Base URL | 面板中对应区域的 Base URL（形如 `http://127.0.0.1:43110/v1`） |
| API Key / token | 面板中对应区域的 bearer token |
| 模型 ID | 面板中该区域列出的模型 ID（如 `DeepSeek-Flash`、`deepseek-v4.1-flash`） |
| `contextWindowTokens` | 手填（宿主默认 256K）；填 `1000000` 就是 1M，插件不参与这个值 |

四个区域就是四个独立档案，各用各的账号与额度（本机现有的是 workbuddy / Qoder / Qoder CN / TraeCN）。

**端口与 token 是持久的**：首次启用时每个区域从 `43110` 起顺次分配一个固定端口并生成一次
bearer token，两者记在插件存储目录的 `endpoints.json` 里，之后重启 Cyrene 都复用同一组值，
**模型档案不需要因为重启而修改**。仅两种情况会变，回到面板重新复制一次即可：端口被别的程序
先占（该区域回退到随机端口并记录新值）；或 `endpoints.json` 被删/损坏。

### 3. 面板上的三个按钮

| 按钮 | 作用 |
| --- | --- |
| 刷新状态 | 重新读取各区域端点与模型列表 |
| 查询额度 | 读取各区域额度、促销活动与今日签到状态（**只读**） |
| 领取今日签到 | 向账号领取今日签到额度 —— **本插件唯一会改动账号状态的操作**，点击后二次确认 |

### 4. 对话工具（Agent 可直接调）

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `ide-account-bridge_usage` | 只读 | 查询各区域额度与签到状态 |
| `ide-account-bridge_models` | 只读 | 列出各区域可用的模型 ID |
| `ide-account-bridge_checkin` | 改动账号状态 | 领取今日签到。**必须显式传 `confirm=true`**，否则只回报将要执行的动作 |

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
