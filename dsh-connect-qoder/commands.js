/**
 * Usage / daily check-in commands for the Qoder Pi extension.
 *
 * The DSH bundle exposed this data through its settings card and private
 * loopback web routes (`/plugins/dsh-connect-qoder/{usage,checkin,account}`).
 * Pi has neither, so the same verified logic runs behind Pi slash commands:
 *
 *   /qoder-usage    quota + promotion + today's check-in state per region
 *   /qoder-checkin  claim today's `CLAIM_BENEFIT` round (asks first)
 *
 * The check-in is the single state-changing operation; it re-reads the
 * campaign list immediately before claiming, because Qoder re-issues the round
 * with a new id each day and a remembered id would be a stale one.
 *
 * @module dsh-connect-qoder/commands
 */
import {
  benefitOf,
  campaignIsClaimed,
  claimableCampaignOf,
  normalizeClaimResult,
} from "./lib/claim.js";
import { claimCampaign, fetchUsage, readCampaigns } from "./lib/upstream.js";

/** Human-readable region labels. */
const REGION_LABEL = { "qoder-cn": "Qoder CN (国内版)", qoder: "Qoder (国际版)" };

/** The account identifier a Qoder credential exposes for display. */
function accountLabel(credential) {
  return credential?.name || credential?.email || credential?.userID || "本机登录";
}

/** Render one quota bucket (`{ total, used, remaining, percentage, unit }`). */
function renderBucket(name, bucket) {
  if (bucket === undefined) return undefined;
  const bits = [`剩余 ${bucket.remaining} / ${bucket.total}${bucket.unit === "credits" ? "" : ` ${bucket.unit}`}`];
  bits.push(`${Math.round(bucket.percentage * 100)}%`);
  return `  ${name}: ${bits.join(" ")}`;
}

/** Render a usage reading for one region. */
function renderUsage(region, usage) {
  // `fetchUsage` answers undefined when the region exposes no usable quota
  // bucket at all — the upstream reports `userQuota.total = 0` for an
  // exhausted/free plan, which the plugin (faithfully) treats as "no data"
  // rather than as a zero balance.
  if (usage === undefined) return "  无可用额度数据（该账号额度为 0 或账号未开通）";
  const lines = [];
  for (const line of [
    renderBucket("主额度", usage.userQuota),
    renderBucket("附加额度", usage.addOnQuota),
  ]) {
    if (line !== undefined) lines.push(line);
  }
  for (const pkg of usage.dedicatedPackages ?? []) {
    const bits = [];
    if (pkg.name) bits.push(pkg.name);
    bits.push(`剩余 ${pkg.remaining}/${pkg.total}`);
    lines.push(`  ${bits.join(" ")}`);
  }
  if (usage.isQuotaExceeded) lines.push("  ⚠ 额度已用尽");
  const checkin = usage.checkin;
  if (checkin !== undefined) {
    if (checkin.active) {
      lines.push(`  签到: ${checkin.todayCheckedIn ? "今日已领取" : "今日可领取"}${checkin.amount === undefined ? "" : `（${checkin.amount} ${checkin.unit ?? "积分"}）`}`);
    } else {
      lines.push("  签到: 今日无进行中的活动");
    }
  } else {
    lines.push("  签到: 状态不可读");
  }
  for (const campaign of usage.campaigns ?? []) {
    if (campaign.title) lines.push(`  · ${campaign.title}${campaign.description ? ` — ${campaign.description}` : ""}`);
  }
  return lines.length === 0 ? "  无可显示数据" : lines.join("\n");
}

/**
 * Register the Qoder usage / check-in commands.
 *
 * @param pi - the Pi extension API.
 * @param runtimes - the live region runtimes (credential cache + catalog + shim).
 */
export function registerQoderCommands(pi, runtimes) {
  const runtimeFor = (regionId) => runtimes.find((runtime) => runtime.region.id === regionId);

  pi.registerCommand("qoder-usage", {
    description: "查看 Qoder 各区域额度与今日签到状态",
    handler: async (_args, ctx) => {
      if (runtimes.length === 0) {
        ctx.ui.notify("Qoder: 本机没有已登录的 Qoder 账号", "warning");
        return;
      }
      const blocks = [];
      for (const runtime of runtimes) {
        const label = REGION_LABEL[runtime.region.id] ?? runtime.region.id;
        try {
          const credential = await runtime.resolveCredential();
          if (credential === undefined) {
            blocks.push(`${label}: 未登录`);
            continue;
          }
          const usage = await fetchUsage(runtime.region, credential, AbortSignal.timeout(20000));
          blocks.push(`${label} (${accountLabel(credential)}):\n${renderUsage(runtime.region, usage)}`);
        } catch (error) {
          blocks.push(`${label}: 读取失败 - ${error?.message ?? error}`);
        }
      }
      ctx.ui.notify(`Qoder 用量概览:\n\n${blocks.join("\n\n")}`, "info");
    },
  });

  pi.registerCommand("qoder-checkin", {
    description: "领取 Qoder 今日签到额度（需确认）",
    handler: async (_args, ctx) => {
      if (runtimes.length === 0) {
        ctx.ui.notify("Qoder: 本机没有已登录的 Qoder 账号", "warning");
        return;
      }
      for (const runtime of runtimes) {
        const label = REGION_LABEL[runtime.region.id] ?? runtime.region.id;
        let campaign;
        try {
          const credential = await runtime.resolveCredential();
          if (credential === undefined) continue;
          const payload = await readCampaigns(runtime.region, credential, AbortSignal.timeout(20000));
          campaign = claimableCampaignOf(payload);
          if (campaign === undefined) {
            ctx.ui.notify(`${label}: 今日无进行中的签到活动`, "info");
            continue;
          }
          if (campaignIsClaimed(campaign)) {
            ctx.ui.notify(`${label}: 今日已领取${benefitOf(campaign)?.amount === undefined ? "" : `（${benefitOf(campaign).amount} 积分）`}`, "info");
            continue;
          }
          const benefit = benefitOf(campaign);
          const ok = await ctx.ui.confirm(
            `确认领取 ${label} 今日签到?`,
            `${benefit?.amount === undefined ? "今日签到奖励" : `${benefit.amount} ${benefit.kind ?? "积分"}`} —— 这是本扩展唯一会改动 Qoder 账号状态的操作。`,
          );
          if (!ok) {
            ctx.ui.notify(`${label}: 已取消`, "info");
            continue;
          }
          const campaignId = String(campaign.campaignKey ?? campaign.campaignId ?? "");
          const result = await claimCampaign(runtime.region, credential, campaignId, AbortSignal.timeout(20000));
          const normalized = normalizeClaimResult(result, campaign);
          if (normalized.claimed && !normalized.replayed) {
            ctx.ui.notify(`${label}: 签到成功 ✅${normalized.amount === undefined ? "" : ` 获得 ${normalized.amount} 积分`}`, "info");
          } else if (normalized.replayed) {
            ctx.ui.notify(`${label}: 今日已领取过（上游未重复发放）`, "info");
          } else {
            ctx.ui.notify(`${label}: 签到未成功`, "warning");
          }
        } catch (error) {
          ctx.ui.notify(`${label}: 签到失败 - ${error?.message ?? error}`, "error");
        }
      }
    },
  });
}
