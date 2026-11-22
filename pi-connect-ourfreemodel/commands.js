/**
 * Slash commands for the Our Free Model Pi extension.
 *
 * Why this is a command and not an OAuth flow implemented here: the channels
 * that need a sign-in (LobsterAI, Qoder, TRAE, Cline, Loomy, Raccoon, MiniMax,
 * ZCode, Gemini) each use a different protocol, and Our Free Model already
 * implements every one of them behind its own management page. Reimplementing
 * them in Pi would fork that work. So this module's job is narrower and more
 * useful: make that page reachable from inside a Pi session.
 *
 * The one thing that makes this possible is that the service runs **inside the
 * Pi process** once a session starts. Its management link carries a one-time
 * bootstrap token that the service only reveals while that token is live
 * (ten minutes, and it is cleared the moment the page is opened). Handing the
 * user that link is therefore the whole feature — there is no second process to
 * start, and no lock contention with a separately launched standalone service.
 *
 * @module pi-connect-ourfreemodel/commands
 */

import { spawn } from "node:child_process";

/** How many channels the last status rendering should list at most. */
const MAX_LISTED_CHANNELS = 24;

/**
 * Open a URL in the platform's default browser.
 *
 * Deliberately not `open`/`start` through a shell string: the URL contains a
 * bearer-equivalent token, and interpolating it into a shell command line would
 * expose it to any process that can read the command line (and to shell
 * metacharacter handling). `spawn` with an argv array avoids both.
 */
function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: false });
      child.on("error", () => done(false));
      child.on("spawn", () => {
        // `cmd /c start` returns immediately; the browser is a grandchild.
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

/**
 * Summarize the service's channel surface.
 *
 * `channels.state()` answers only the *runtime's own* health (`{state:"ready"}`).
 * Per-channel account counts come from `channels.rpc("provider.status", …)`,
 * which is what the management page itself uses — so this asks the same source
 * rather than guessing from absent fields. When that call fails the sign-in
 * column is omitted entirely rather than shown as zero, because "0 accounts"
 * and "could not ask" call for different user action.
 */
async function describeChannels(handle) {
  const lines = [];
  let runtimeState;
  try {
    runtimeState = handle?.channels?.state?.();
  } catch {
    runtimeState = undefined;
  }
  if (runtimeState !== undefined) {
    const state = runtimeState?.state ?? "unknown";
    const reason = runtimeState?.error;
    lines.push(`渠道运行时：${state}${typeof reason === "string" && reason !== "" ? `（${reason}）` : ""}`);
  }
  let ids = [];
  try {
    ids = handle?.channels?.providers ?? [];
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    lines.push("没有可列出的渠道");
    return lines;
  }

  // Ask the channel runtime for account counts, the same call the management
  // page makes. A failure here is reported as "unknown", never as "0 accounts".
  let statuses;
  try {
    const answer = await handle.channels.rpc?.(
      { method: "provider.status", payload: { providers: ids } },
      AbortSignal.timeout(30_000),
    );
    if (answer?.ok === true && answer.value?.statuses !== undefined) statuses = answer.value.statuses;
  } catch {
    statuses = undefined;
  }

  if (statuses === undefined) {
    lines.push(`已接入渠道（${ids.length} 个）：${ids.join("、")}`);
    lines.push("登录状态暂时无法读取（provider.status 调用失败）");
    return lines;
  }

  const signedIn = [];
  const signedOut = [];
  for (const id of ids) {
    const entry = statuses[id];
    const accounts = entry?.accounts;
    // Only a numeric `total` is trusted. An absent field means the runtime did
    // not report on this channel, which is not the same as zero accounts.
    const total = typeof accounts?.total === "number" ? accounts.total : undefined;
    if (total === undefined) {
      signedOut.push(`${id}（未知）`);
    } else if (total > 0) {
      const enabled = typeof accounts.enabled === "number" ? accounts.enabled : total;
      signedIn.push(`${id}（${enabled}/${total} 账号启用）`);
    } else {
      signedOut.push(id);
    }
  }
  if (signedIn.length > 0) lines.push(`已登录：${signedIn.join("、")}`);
  if (signedOut.length > 0) {
    const shown = signedOut.slice(0, MAX_LISTED_CHANNELS);
    lines.push(`未登录：${shown.join("、")}${signedOut.length > shown.length ? " 等" : ""}`);
  }
  if (signedIn.length === 0) {
    lines.push("当前只有免密免费池可用；登录任意渠道后会出现该渠道的模型");
    lines.push("用 /ourfreemodel-login 打开管理页面登录");
  }
  return lines;
}

/**
 * Register the extension's slash commands.
 *
 * @param {object} pi   the Pi extension API
 * @param {object} runtime  the extension's Runtime (service handle + catalog)
 */
export function registerOurFreeModelCommands(pi, runtime) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("ourfreemodel-login", {
    description: "打开 Our Free Model 管理页面，登录 LobsterAI / Qoder / TRAE 等账号渠道",
    handler: async (_args, ctx) => {
      // Starting the service here is intentional: this command only exists in a
      // session, which is exactly when a listener is allowed to open.
      const position = await runtime.service.ensure();
      if (position === undefined) {
        ctx?.ui?.notify?.(
          `Our Free Model 不可用：${runtime.service.lastFailure ?? "服务没能启动"}`,
          "error",
        );
        return;
      }
      const url = position.managementUrl;
      const opened = await openInBrowser(url);
      // Print the link either way. Auto-opening is a convenience, not the
      // deliverable: a browser that opens on the wrong machine, a locked-down
      // desktop, or a headless session all leave the user needing the URL
      // itself. The token is single-use, so a user who cannot reach the page
      // has to run the command again — worth avoiding.
      console.log(`Our Free Model 管理页面：${url}`);
      ctx?.ui?.notify?.(`管理页面链接已输出到终端：${url}`, "info");
      if (!opened) {
        ctx?.ui?.notify?.("无法自动打开浏览器，请手动访问上面的链接", "warning");
      }
      ctx?.ui?.notify?.(
        "该链接一次性有效（10 分钟）。若已失效，重新执行 /ourfreemodel-login 会得到新链接。",
        "info",
      );
    },
  });

  pi.registerCommand("ourfreemodel-status", {
    description: "查看 Our Free Model 服务状态、数据目录与各渠道登录情况",
    handler: async (_args, ctx) => {
      const lines = [];
      const installed = runtime.service.position;
      lines.push(`数据目录：${installed?.dataDir ?? runtime.service.lastFailure ?? "未启动"}`);
      if (installed !== undefined) {
        lines.push(`服务版本：${installed.version}（${installed.root.includes("vendor") ? "随包附带" : "外部安装"}）`);
        lines.push(`本机模型：${runtime.models.length} 个`);
      }
      // `channels` is only meaningful once the service is up; asking for it is
      // also what triggers a lazy start in a session.
      if (installed === undefined) {
        const position = await runtime.service.ensure();
        if (position !== undefined) {
          lines.length = 0;
          lines.push(`数据目录：${position.dataDir}`);
          lines.push(`服务版本：${position.version}（${position.root.includes("vendor") ? "随包附带" : "外部安装"}）`);
          lines.push(`本机模型：${runtime.models.length} 个`);
        }
      }
      lines.push(...(await describeChannels(runtime.service.handle)));
      const text = lines.join("\n");
      ctx?.ui?.notify?.(text, "info");
      console.log(text);
    },
  });
}
