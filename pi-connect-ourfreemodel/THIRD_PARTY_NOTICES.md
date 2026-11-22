# 第三方代码归属

## Our Free Model（`dsh-our-free-model`）

`vendor/ofm/` 是本包随附的第三方代码，源自：

- 项目：Our Free Model
- 仓库：https://github.com/Ebony-Vinyl/dsh-our-free-model
- 版本：2.7.2
- 许可：MIT（原文见 `vendor/ofm/LICENSE`）

### 随附了哪些、为什么

只随附它自己的 `scripts/pack-standalone.mjs` 中 `standaloneSourceFiles()` 列出的文件集
——也就是上游为「独立本地服务」定义的那一份清单，减去 DSH 插件入口
（`index.js` / `client.js`，那部分依赖 `@deepseek-ai/cordis` 等宿主包，本包不使用）。

因此 `vendor/ofm/` 里没有：

- 上游的 DSH 插件入口（跑在 DSH 宿主里的那套）
- 桌面壳（Tauri）
- `src/engine-parts/`（34 MB 的预编译引擎分片，不在上述清单内）

`vendor/ofm/package.json` 是本包为这份子集补的说明文件，不是上游的原文件。

### 改动

未修改上游任何源码。若要更新随附版本，重新按上游清单复制即可；
本包的定位是薄适配层，不对上游行为做本地修补。

### 上游的第三方组件

上游还随附了 `vendor/channel-pack/`（渠道协议实现）及其自带许可与 NOTICE，
已一并复制到 `vendor/ofm/vendor/channel-pack/`，原文见：
- `vendor/ofm/vendor/channel-pack/LICENSE`
- `vendor/ofm/vendor/channel-pack/NOTICE.md`
