---
name: pi-connect-model-catalog
description: 查 / 刷新 pi-connect 插件（Qoder 国内版+国际版、Trae 国内版+国际版）当前暴露的模型列表、上下文窗口与思考档位；并给出 workbuddy 网关 /v1/models 的查法。当用户问「Qoder / Trae 有哪些模型」「模型列表 / 目录里有什么」「新模型上了没」「刷新模型目录」「某个模型的上下文 / 思考档位是多少」「模型数量不对 / 少了几个」时使用。触发词：模型列表、模型目录、model catalog、Qoder 模型、Trae 模型、刷新模型、上下文档位、思考档位、qoder-cn、trae-global。
agent_created: true
---

# pi-connect 模型目录查询

本机副本（`~/.agents/skills/pi-connect-model-catalog/`，并硬链接到 .codex / .dsh / .trae / .trae-cn /
.workbuddy / .workbuddy-ai / opencode 的 skills 目录）。
随 npm 包分发的同一份在仓库的 `pi-connect/pi-connect-qoder/skills/model-catalog/SKILL.md` ——
两处内容保持一致（改了一处记得同步另一处）。

插件 = 两个 Pi 扩展：`pi-connect-qoder`（provider `qoder-cn` / `qoder`）、`pi-connect-trae`（provider `trae` / `trae-global`）。
它们把本机已登录的 Qoder / Trae 桌面账号通过回环 shim 接进 pi，模型清单来自各自的上游目录。

## 0. 一句话
- **最终广告的清单**（pi 实际会用哪些）→ `pi --list-models`；
- **上游的原话**（上下文档位、思考档位、促销、上游 key）→ 插件的目录缓存 JSON；
- `--list-models` **不联网**，读的是上一次会话拉到并落盘的目录；要新数据必须先跑一次会话（§3）。

## 1. pi 最终广告的清单

```bash
pi --list-models | grep -E '^qoder'      # qoder-cn / qoder
pi --list-models | grep -E '^trae'       # trae / trae-global
```

列含义：`provider / model / context / max-out / thinking / images`。
`pi` 不在 PATH 时用 `~/.pi/agent/bin/pi`。

## 2. 上游原话：Qoder 目录缓存

```bash
node -e "const p=process.env.USERPROFILE+'/.pi/agent/cache/dsh-connect-qoder/.qoder-catalog.qoder-cn.json';const d=require(p);console.log('fetchedAt',new Date(d.fetchedAt).toISOString(),d.entries.length,'个模型');d.entries.forEach(e=>console.log(e.id.padEnd(20),'ctx='+JSON.stringify(e.contextOptions),'efforts='+JSON.stringify(e.effortLevels),e.alwaysThinking?'alwaysThinking':'',e.isFree?'free':''))"
```

把 `qoder-cn` 换成 `qoder` 就是国际版。

字段（`lib/catalog-entry.js` 归一化后）：

| 字段 | 含义 |
| --- | --- |
| `id` / `name` | 展示名，也是 pi 的模型 id |
| `key` | Qoder 上游的模型 key，shim 发请求时用它（别改） |
| `contextOptions` | Qoder 客户端提供的窗口档位，常见 `[200000,400000,1000000]` |
| `defaultContextWindow` | Qoder 的默认档（200000）；pi 端已改成广告**最大档** |
| `maxInputTokens` | 单次请求的下限，**不是**容量，别拿它当 context |
| `effortLevels` | 思考档位（low/medium/xhigh…）；`alwaysThinking` 为真时不可关闭 |
| `isVL` | 支持图片输入 |
| `priceFactor` / `isFree` / `promotion` | 计费倍率 / 免费 / 错峰促销 |

同一份目录的其它副本：DSH `~/.dsh/.qoder-catalog.qoder-cn.json`；昔涟/Cyrene `%APPDATA%\live2d-cyrene\plugin-data\ide-account-bridge\qoder\.qoder-catalog.qoder-cn.json`（shape 相同）。

## 3. 强制刷新目录

缓存 TTL 30 分钟（`lib/catalog-store.js` 的 `CATALOG_TTL_MS`）；过期后由**会话启动 / 请求**触发 `refreshModels` 重取。
`--list-models` 这类 session-less 调用不会刷新。

```bash
pi --provider qoder-cn --model DeepSeek-Flash --no-tools --print "1+1=?"   # 会话内会预热 shim 并重取目录
```
想强制丢掉旧的：先 `rm -f ~/.pi/agent/cache/dsh-connect-qoder/.qoder-catalog.qoder-cn.json` 再跑上面这条。

判断是否真的刷新了，看日志行：
```
[dsh-connect-qoder] ready: qoder-cn (14 models)
```
括号里的数字就是上游目录里的模型数（`registered provider ... with N cached models` 是启动时读缓存的数量）。

## 4. Trae 的差别（重要）

Trae 扩展**没有磁盘目录缓存**：实时目录只在会话里拉，`pi --list-models` 看到的是**静态 fallback**
（CN 只有 `FALLBACK_TRAE_MODELS` 里那几个）。所以：
- 想确认 Trae 真实名册 → 必须跑会话看 `[dsh-connect-trae] ready: trae (N models)`；
- fallback 名单在 `pi-connect-trae/lib/trae-core.js`，已带 dev/Max 窗口与已公布的思考档位。

## 5. pi 实际广告成什么（含 thinkingLevelMap）

```bash
node -e "const p=process.env.USERPROFILE+'/.pi/agent/models-store.json';const d=require(p);const m=d['qoder-cn'];console.log('checkedAt',new Date(m.checkedAt).toISOString());m.models.forEach(x=>console.log(x.id.padEnd(20),'ctx='+x.contextWindow,'mt='+x.maxTokens,JSON.stringify(x.thinkingLevelMap)))"
```

`models-store.json` 是 pi 的**描述符缓存**（离线阶段用），`checkedAt` 是上次落盘时间；
它落后于 `--list-models` 是正常的，真源仍是插件目录 + `getModels()`。

`thinkingLevelMap` 的语义（pi-ai）：`null` = 该档**不支持**；字符串 = 发到线上的值；
键**缺失** = 支持且不发值（只有 `off` 适合这么用）；`xhigh` / `max` 必须显式给出才算支持。

## 6. 常见坑

1. **模型数与上游不符**：先看装在本机的**工作副本**是否带本地补丁 ——
   `~/.pi/agent/extensions/pi-connect-qoder/index.js` 的 `buildModels()` 里
   `const enabled = ...` 决定过滤。pi 端没有持久化 settings 源，`enabledIdsFor({})` 恒为空 = 不过滤；
   历史上曾有一份把 `qoder-cn` 收窄到 2 个模型的白名单，已撤销。
2. **`Auto` 显示 200K**：它的 `contextOptions` 是空数组，只能回落到 `defaultContextWindow`，不是 1M。
3. **两个区域名册不同**：CN 约 14 个、国际版只有 Qwen3.8-Max / Flash；未登录的区域不出现、不启服务、不占端口。
4. **别用 python**：本机（Windows）没有 python，用 `node -e` 读这些 JSON。
5. **上游偶发 `provider_error`**：Qoder 侧账号额度 / 网关问题，换一个模型或稍后重试即可，
   与目录/清单无关（换 `--model DeepSeek-Flash` 试）。
6. 想改 pi 端的模型过滤：只能改代码（上面 §6.1），或在 DSH 侧配 `enabledModelIds`
   （`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-qoder` 段，`useMaximumContextWindow` 也在那里）。

## 7. 顺带：workbuddy 网关（wb2api）的模型清单

别的 provider 的权威清单不在插件里，而在网关 `/v1/models`（带 `context_length` /
`reasoning_supported_efforts` / `reasoning_default_effort` / `only_reasoning`）：

```bash
node -e "const a=require(process.env.USERPROFILE+'/.pi/agent/auth.json');(async()=>{const r=await fetch('http://192.168.31.78:7863/v1/models',{headers:{authorization:'Bearer '+a.workbuddy.key}});const j=await r.json();for(const m of (j.data||[]))console.log(String(m.id).padEnd(32),'ctx='+m.context_length,'efforts='+m.reasoning_supported_efforts,'off='+(m.only_reasoning?'不可关':'可关'))})()"
```

`~/.pi/agent/models.json` 里 workbuddy 的 `thinkingLevelMap` / `compat.supportsReasoningEffort`
就是照这个逐模型写的；网关新增模型时这里不会自动跟进，需要重新生成。
