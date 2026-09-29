/**
 * Qoder usage and daily check-in, expressed as data rather than as Pi UI calls.
 *
 * The Pi port surfaced these through slash commands that called `ctx.ui.notify`
 * directly. Cyrene has three consumers for the same readings — the panel, the
 * tool surface, and a future scheduler hook — so the logic returns plain
 * objects here and each consumer renders them its own way.
 *
 * The check-in guards are the DSH bundle's, unchanged: re-read the campaign
 * list immediately before claiming (Qoder re-issues the round with a new id
 * every day, so a remembered id would be stale), and never claim when the
 * account already shows today's payout.
 *
 * @module ide-account-bridge/qoder-ops
 */
import { benefitOf, campaignIsClaimed, claimableCampaignOf, normalizeClaimResult } from './lib/claim.js'
import { claimCampaign, fetchUsage, readCampaigns } from './lib/upstream.js'

/** Region labels, matching the DSH card's wording. */
const REGION_LABEL = { 'qoder-cn': 'Qoder CN（国内版）', qoder: 'Qoder（国际版）' }

/** Ceiling for one quota/claim round-trip. */
const TIMEOUT_MS = 20000

export function qoderRegionLabel(regionId) {
  return REGION_LABEL[regionId] ?? regionId
}

/** The account identifier a Qoder credential exposes for display. */
function accountLabel(credential) {
  return credential?.name || credential?.email || credential?.userID || '本机登录'
}

/** Flatten one region's quota reading into display lines. */
function usageLines(usage) {
  // `fetchUsage` answers undefined when the region exposes no usable bucket:
  // the upstream reports `userQuota.total = 0` for an exhausted or free plan,
  // which is faithfully "no data" rather than a zero balance.
  if (usage === undefined) return ['无可用额度数据（该账号额度为 0 或未开通）']
  const lines = []
  const bucket = (name, b) => {
    if (b === undefined) return
    const unit = b.unit === 'credits' ? '' : ` ${b.unit}`
    lines.push(`${name}：剩余 ${b.remaining} / ${b.total}${unit}（${Math.round(b.percentage * 100)}%）`)
  }
  bucket('主额度', usage.userQuota)
  bucket('附加额度', usage.addOnQuota)
  for (const pkg of usage.dedicatedPackages ?? []) {
    lines.push(`${pkg.name ? `${pkg.name} ` : ''}剩余 ${pkg.remaining}/${pkg.total}`)
  }
  if (usage.isQuotaExceeded) lines.push('⚠ 额度已用尽')
  const checkin = usage.checkin
  if (checkin === undefined) lines.push('签到：状态不可读')
  else if (!checkin.active) lines.push('签到：今日无进行中的活动')
  else lines.push(`签到：${checkin.todayCheckedIn ? '今日已领取' : '今日可领取'}${checkin.amount === undefined ? '' : `（${checkin.amount} ${checkin.unit ?? '积分'}）`}`)
  for (const campaign of usage.campaigns ?? []) {
    if (campaign.title) lines.push(`· ${campaign.title}${campaign.description ? ` — ${campaign.description}` : ''}`)
  }
  return lines.length > 0 ? lines : ['无可显示数据']
}

/**
 * Read every region's quota. Never throws: one failing region must not hide
 * the other's reading.
 *
 * @returns `[{ regionId, label, ok, account?, status?, lines }]`
 */
export async function qoderUsage(runtimes, signal) {
  const out = []
  for (const runtime of runtimes) {
    const regionId = runtime.region.id
    const label = qoderRegionLabel(regionId)
    try {
      const credential = await runtime.resolveCredential()
      if (credential === undefined) {
        out.push({ regionId, label, ok: false, status: '未登录', lines: [] })
        continue
      }
      const usage = await fetchUsage(runtime.region, credential, signal ?? AbortSignal.timeout(TIMEOUT_MS))
      out.push({ regionId, label, ok: true, account: accountLabel(credential), lines: usageLines(usage) })
    } catch (error) {
      out.push({ regionId, label, ok: false, status: `读取失败：${error?.message ?? error}`, lines: [] })
    }
  }
  return out
}

/**
 * Claim today's check-in for every region that has one outstanding.
 *
 * This is the only operation in the whole plugin that changes account state on
 * the upstream side, which is why it re-reads before writing and reports a
 * per-region outcome instead of a single boolean.
 *
 * @param runtimes - the live region runtimes.
 * @param signal - caller-owned cancellation.
 * @returns `[{ regionId, label, status, message }]` where status is one of
 *   `claimed` / `already` / `none` / `skipped` / `error`.
 */
export async function qoderCheckin(runtimes, signal) {
  const out = []
  for (const runtime of runtimes) {
    const regionId = runtime.region.id
    const label = qoderRegionLabel(regionId)
    try {
      const credential = await runtime.resolveCredential()
      if (credential === undefined) {
        out.push({ regionId, label, status: 'skipped', message: '未登录' })
        continue
      }
      const payload = await readCampaigns(runtime.region, credential, signal ?? AbortSignal.timeout(TIMEOUT_MS))
      const campaign = claimableCampaignOf(payload)
      if (campaign === undefined) {
        out.push({ regionId, label, status: 'none', message: '今日无进行中的签到活动' })
        continue
      }
      if (campaignIsClaimed(campaign)) {
        const amount = benefitOf(campaign)?.amount
        out.push({ regionId, label, status: 'already', message: `今日已领取${amount === undefined ? '' : `（${amount} 积分）`}` })
        continue
      }
      const campaignId = String(campaign.campaignKey ?? campaign.campaignId ?? '')
      const result = await claimCampaign(runtime.region, credential, campaignId, signal ?? AbortSignal.timeout(TIMEOUT_MS))
      const normalized = normalizeClaimResult(result, campaign)
      if (normalized.claimed && !normalized.replayed) {
        out.push({ regionId, label, status: 'claimed', message: `签到成功${normalized.amount === undefined ? '' : `，获得 ${normalized.amount} 积分`}` })
      } else if (normalized.replayed) {
        out.push({ regionId, label, status: 'already', message: '今日已领取过（上游未重复发放）' })
      } else {
        out.push({ regionId, label, status: 'error', message: '签到未成功' })
      }
    } catch (error) {
      out.push({ regionId, label, status: 'error', message: `签到失败：${error?.message ?? error}` })
    }
  }
  return out
}
