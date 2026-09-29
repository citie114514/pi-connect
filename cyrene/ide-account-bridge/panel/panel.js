/**
 * Panel renderer for the IDE account bridge plugin.
 *
 * Runs inside a trusted `BrowserWindow` the plugin itself created with
 * `nodeIntegration: true`, so `ipcRenderer` is available directly. Every
 * channel is namespaced by the host as `plugin:<pluginId>:<channel>`.
 *
 * The panel is deliberately read-mostly: the only state-changing action it
 * offers is the check-in button, and that one asks for confirmation first.
 */
const { ipcRenderer } = require("electron");

const PLUGIN_ID = "ide-account-bridge";
const channel = (name) => `plugin:${PLUGIN_ID}:${name}`;

const $ = (id) => document.getElementById(id);

/** Render the "endpoint" cards. */
function renderRegions(state) {
  const host = $("regions");
  host.textContent = "";
  for (const region of state.regions) {
    const card = document.createElement("div");
    card.className = region.ready ? "card" : "card off";

    const head = document.createElement("div");
    head.className = "head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = region.label;
    const tag = document.createElement("span");
    tag.className = region.ready ? "tag ok" : "tag off";
    tag.textContent = region.ready ? `已就绪 · ${region.models.length} 个模型` : "未登录";
    head.append(name, tag);
    card.append(head);

    if (region.ready) {
      card.append(buildCopyRow("Base URL", region.baseUrl));
      card.append(buildCopyRow("token", region.token ?? "(未生成)"));
      if (region.models.length > 0) {
        const models = document.createElement("div");
        models.className = "models";
        for (const model of region.models) {
          const chip = document.createElement("span");
          chip.textContent = model.id;
          chip.title = model.name;
          models.append(chip);
        }
        card.append(models);
      }
    } else {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "本机没有该区域的登录状态。在对应的桌面应用里登录后，点「刷新状态」。";
      card.append(hint);
    }
    host.append(card);
  }
  if (state.regions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card off";
    empty.textContent = "插件尚未完成初始化。";
    host.append(empty);
  }
}

/** One "label + value + copy" line. */
function buildCopyRow(label, value) {
  const row = document.createElement("div");
  row.className = "row";
  const name = document.createElement("span");
  name.className = "label";
  name.textContent = label;
  const code = document.createElement("code");
  code.textContent = value;
  const button = document.createElement("button");
  button.className = "copy";
  button.textContent = "复制";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "已复制";
      setTimeout(() => { button.textContent = "复制"; }, 1200);
    } catch {
      button.textContent = "复制失败";
    }
  });
  row.append(name, code, button);
  return row;
}

/** Render the usage/check-in result blocks. */
function renderOps(title, data) {
  const lines = [`【${title}】`];
  const rows = [...data.qoder, ...data.trae];
  for (const row of rows) {
    if (row.lines && row.lines.length > 0) {
      lines.push(`${row.label}${row.account ? `（${row.account}）` : ""}`);
      for (const line of row.lines) lines.push(`  ${line}`);
    } else {
      lines.push(`${row.label}：${row.status ?? row.message ?? "无数据"}`);
    }
  }
  if (rows.length === 0) lines.push("没有可查询的区域。");
  return lines.join("\n");
}

/** Wrap a panel action with button locking and error surfacing. */
async function withBusy(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try {
    await fn();
  } catch (error) {
    $("out").textContent = `操作失败：${error && error.message ? error.message : String(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$("refresh").addEventListener("click", () => withBusy($("refresh"), async () => {
  const state = await ipcRenderer.invoke(channel("refresh"));
  renderRegions(state);
  $("out").textContent = `已刷新：${state.regions.filter((r) => r.ready).length} / ${state.regions.length} 个区域就绪。`;
}));

$("usage").addEventListener("click", () => withBusy($("usage"), async () => {
  $("out").textContent = renderOps("额度", await ipcRenderer.invoke(channel("usage")));
}));

$("checkin").addEventListener("click", () => withBusy($("checkin"), async () => {
  // The one state-changing action in this plugin; confirm before spending it.
  const ok = window.confirm(
    "确认领取今日签到额度？\n\n这会向本机已登录的 Qoder / Trae 账号领取今日额度，是本插件唯一会改动账号状态的操作。",
  );
  if (!ok) {
    $("out").textContent = "已取消签到。";
    return;
  }
  $("out").textContent = renderOps("签到", await ipcRenderer.invoke(channel("checkin")));
}));

// Paint on open so the user never faces an empty panel.
(async () => {
  try {
    renderRegions(await ipcRenderer.invoke(channel("state")));
  } catch (error) {
    $("out").textContent = `读取状态失败：${error && error.message ? error.message : String(error)}`;
  }
})();
