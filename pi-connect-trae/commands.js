/**
 * Daily check-in / usage commands for the Trae Pi extension.
 *
 * The DSH bundle exposed these through its settings card and a private
 * loopback web route. Pi has no card and no host web server, so the same
 * verified logic is surfaced as Pi slash commands instead:
 *
 *   /trae-usage    readable credit + check-in snapshot for every signed-in region
 *   /trae-checkin  claim today's check-in (the ONLY state-changing call; asks first)
 *
 * The guards are the ones the DSH route used, unchanged: read the status
 * first, and only claim when the account has not been paid today and this
 * device has not spent its own check-in.
 *
 * @module dsh-connect-trae/commands
 */
import {
  CHECKIN_DEVICE_ALREADY_CLAIMED,
  TraeUsageClient,
  safeMessage,
  toCheckin,
  toCredits,
} from "./lib/trae-core.js";

/** Region labels shown to the user. */
const REGION_LABEL = { cn: "Trae CN (国内版)", ai: "Trae Global (国际版)" };

/** Render one credit snapshot as a compact multi-line block. */
function renderCredits(credits) {
  const lines = [];
  lines.push(`  总额度: ${credits.total} / 已用: ${credits.consumed} / 可用: ${credits.available}`);
  if (credits.accounts.length > 0) {
    for (const pack of credits.accounts) {
      lines.push(`  · ${pack.displayDesc || "额度包"}: 剩余 ${pack.remain} / ${pack.size}`);
    }
  }
  return lines.join("\n");
}

/** Render one check-in status. */
function renderCheckin(checkin) {
  const parts = [];
  parts.push(checkin.checkedIn ? "今日已领取" : "今日可领取");
  if (checkin.didCheckedIn) parts.push("本设备今日已签到");
  if (checkin.credits !== undefined) parts.push(`奖励 ${checkin.credits} 积分`);
  if (checkin.extraCredits !== undefined) parts.push(`额外 ${checkin.extraCredits}`);
  if (checkin.enabled === false) parts.push("(该账号未开通签到)");
  return parts.join(" | ");
}

/**
 * Read a full usage view for one region. Returns a rendered string; never
 * throws, so one failing region cannot hide the other's reading.
 */
async function usageForRegion(stack, logger) {
  const label = REGION_LABEL[stack.region];
  try {
    const credential = await stack.store.resolve();
    if (credential === undefined) return `${label}: 未登录`;
    const client = new TraeUsageClient({
      credential: () => stack.store.resolve(),
      deviceId: () => stack.device().then((d) => d?.deviceId),
    });
    const region = await client.currentRegion();
    if (region === "ai") {
      const pay = await client.payStatus();
      const bits = [`订阅计费: ${pay.isDollarUsageBilling ? "是" : "否"}`];
      if (pay.hasPackage) bits.push("已购套餐");
      if (pay.inTrial) bits.push(`试用中(至 ${new Date(pay.trialEndTimeMs).toLocaleDateString()})`);
      if (pay.fission) bits.push(`裂变额度 ${pay.fission.maxUsage}`);
      return `${label}: ${bits.join(" | ")}`;
    }
    const snapshot = await client.snapshot();
    const checkin = await client.checkinStatus();
    return `${label} (${credential.accountName ?? credential.userId}):\n${renderCredits(toCredits(snapshot))}\n  签到: ${renderCheckin(toCheckin(checkin))}`;
  } catch (error) {
    return `${label}: 读取失败 - ${safeMessage(error)}`;
  }
}

/**
 * Register the Trae usage / check-in commands on the Pi extension API.
 *
 * @param pi - the Pi extension API.
 * @param stacks - the live region stacks (credential store + catalog + shim).
 */
export function registerTraeCommands(pi, stacks) {
  const stackFor = (region) => stacks.find((stack) => stack.region === region);

  pi.registerCommand("trae-usage", {
    description: "查看 Trae 各区域额度与今日签到状态",
    handler: async (_args, ctx) => {
      if (stacks.length === 0) {
        ctx.ui.notify("Trae: 本机没有已登录的 Trae 账号", "warning");
        return;
      }
      const blocks = [];
      for (const stack of stacks) blocks.push(await usageForRegion(stack, ctx));
      ctx.ui.notify(`Trae 用量概览:\n\n${blocks.join("\n\n")}`, "info");
    },
  });

  pi.registerCommand("trae-checkin", {
    description: "领取 Trae 今日签到奖励（仅国内版，需确认）",
    handler: async (_args, ctx) => {
      const stack = stackFor("cn");
      if (stack === undefined) {
        ctx.ui.notify("Trae 国内版未登录，无法签到", "warning");
        return;
      }
      let client;
      let current;
      try {
        client = new TraeUsageClient({
          credential: () => stack.store.resolve(),
          deviceId: () => stack.device().then((d) => d?.deviceId),
        });
        current = await client.checkinStatus();
      } catch (error) {
        ctx.ui.notify(`Trae 签到状态读取失败: ${safeMessage(error)}`, "error");
        return;
      }
      if (!current.enabled) {
        ctx.ui.notify("该 Trae 账号未开通签到", "warning");
        return;
      }
      if (current.checkedIn) {
        ctx.ui.notify(`今日已领取签到奖励${current.credits === undefined ? "" : `（${current.credits} 积分）`}`, "info");
        return;
      }
      if (current.didCheckedIn) {
        ctx.ui.notify("本设备今日已签到（可能用的是另一个账号）", "warning");
        return;
      }
      const ok = await ctx.ui.confirm(
        "确认领取 Trae 今日签到奖励?",
        "这是本扩展唯一会改动 Trae 账号状态的操作，将向你自己的账号领取今日额度。",
      );
      if (!ok) {
        ctx.ui.notify("已取消签到", "info");
        return;
      }
      try {
        const claim = await client.claimCheckin();
        const after = await client.checkinStatus();
        if (claim.code === CHECKIN_DEVICE_ALREADY_CLAIMED) {
          ctx.ui.notify("本设备今日已签到（上游已拒绝重复领取）", "warning");
          return;
        }
        if (claim.claimed) {
          ctx.ui.notify(`签到成功 ✅ ${renderCheckin(toCheckin(after))}`, "info");
        } else {
          ctx.ui.notify(`签到未成功: ${claim.message ?? `code ${claim.code ?? "?"}`}`, "warning");
        }
      } catch (error) {
        ctx.ui.notify(`签到失败: ${safeMessage(error)}`, "error");
      }
    },
  });
}
