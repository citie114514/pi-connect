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
 * `channels.state()` answers the *runtime's own* health (`{state: "ready"}`),
 * not per-channel sign-in: the service keeps credentials in its management
 * layer and only exposes a provider id list here. So this reports what is
 * actually known — which channels exist and whether the runtime is healthy —
 * and points at `/ourfreemodel-login` for the part it cannot answer. Inventing
 * a "not signed in" column from absent data would send users through logins
 * they do not need.
 */
function describeChannels(handle) {
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
  if (Array.isArray(ids) && ids.length > 0) {
    const shown = ids.slice(0, MAX_LISTED_CHANNELS);
    lines.push(`已接入渠道：${shown.join("、")}${ids.length > shown.length ? ` 等 ${ids.length} 个` : ""}`);
    lines.push("各渠道的登录状态请在管理页面查看（/ourfreemodel-login）");
  } else {
    lines.push("没有可列出的渠道");
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
      lines.push(...describeChannels(runtime.service.handle));
      const text = lines.join("\n");
      ctx?.ui?.notify?.(text, "info");
      console.log(text);
    },
  });
}
