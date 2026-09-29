/**
 * Trae usage and daily check-in, expressed as data rather than as Pi UI calls.
 *
 * Same shape as the Qoder side (`./qoder/ops.js`): the Pi port called
 * `ctx.ui.notify` directly, while Cyrene has a panel and a tool surface that
 * each want to render the same reading differently.
 *
 * The check-in guards are the DSH route's, unchanged: read the status first,
 * and only claim when the account has not been paid today **and** this device
 * has not already spent its own check-in — the upstream enforces the second
 * condition separately and answers `CHECKIN_DEVICE_ALREADY_CLAIMED` for it.
 *
 * @module ide-account-bridge/trae-ops
 */
import {
  CHECKIN_DEVICE_ALREADY_CLAIMED,
  TraeUsageClient,
  safeMessage,
  toCheckin,
  toCredits,
} from './lib/trae-core.js'

/** Region labels, matching the DSH card's wording. */
const REGION_LABEL = { cn: 'Trae CN（国内版）', ai: 'Trae Global（国际版）' }

export function traeRegionLabel(region) {
  return REGION_LABEL[region] ?? region
}

/** One region's usage client, bound to that region's live credential store. */
function clientFor(stack) {
  return new TraeUsageClient({
    credential: () => stack.store.resolve(),
    deviceId: () => stack.device().then((d) => d?.deviceId),
  })
}

/** Flatten one region's credit snapshot into display lines. */
function creditLines(credits) {
  const lines = [`总额度 ${credits.total} / 已用 ${credits.consumed} / 可用 ${credits.available}`]
  for (const pack of credits.accounts) {
    lines.push(`· ${pack.displayDesc || '额度包'}：剩余 ${pack.remain} / ${pack.size}`)
  }
  return lines
}

/** Flatten one region's check-in status into display lines. */
function checkinLines(checkin) {
  const parts = [checkin.checkedIn ? '今日已领取' : '今日可领取']
  if (checkin.didCheckedIn) parts.push('本设备今日已签到')
  if (checkin.credits !== undefined) parts.push(`奖励 ${checkin.credits} 积分`)
  if (checkin.extraCredits !== undefined) parts.push(`额外 ${checkin.extraCredits}`)
  if (checkin.enabled === false) parts.push('（该账号未开通签到）')
  return [parts.join(' | ')]
}

/**
 * Read every region's usage. Never throws, for the same reason as the Qoder
 * side: one dead region must not blank the whole panel.
 *
 * The international region bills by subscription rather than by credit pack,
 * so it reports pay status instead of a quota grid.
 *
 * @returns `[{ regionId, label, ok, account?, status?, lines }]`
 */
export async function traeUsage(stacks) {
  const out = []
  for (const stack of stacks) {
    const regionId = stack.region
    const label = traeRegionLabel(regionId)
    try {
      const credential = await stack.store.resolve()
      if (credential === undefined) {
        out.push({ regionId, label, ok: false, status: '未登录', lines: [] })
        continue
      }
      const client = clientFor(stack)
      const current = await client.currentRegion()
      if (current === 'ai') {
        const pay = await client.payStatus()
        const bits = [`订阅计费：${pay.isDollarUsageBilling ? '是' : '否'}`]
        if (pay.hasPackage) bits.push('已购套餐')
        if (pay.inTrial) bits.push(`试用中（至 ${new Date(pay.trialEndTimeMs).toLocaleDateString()}）`)
        if (pay.fission) bits.push(`裂变额度 ${pay.fission.maxUsage}`)
        out.push({ regionId, label, ok: true, account: credential.accountName ?? credential.userId, lines: [bits.join(' | ')] })
        continue
      }
      const snapshot = await client.snapshot()
      const checkin = await client.checkinStatus()
      out.push({
        regionId,
        label,
        ok: true,
        account: credential.accountName ?? credential.userId,
        lines: [...creditLines(toCredits(snapshot)), ...checkinLines(toCheckin(checkin))],
      })
    } catch (error) {
      out.push({ regionId, label, ok: false, status: `读取失败：${safeMessage(error)}`, lines: [] })
    }
  }
  return out
}

/**
 * Claim today's check-in. Only the domestic region runs a check-in campaign;
 * the international region answers `enabled: false` and is reported as such
 * rather than silently skipped.
 *
 * @returns `[{ regionId, label, status, message }]` with the same status
 *   vocabulary as the Qoder side.
 */
export async function traeCheckin(stacks) {
  const out = []
  for (const stack of stacks) {
    const regionId = stack.region
    const label = traeRegionLabel(regionId)
    let client
    let current
    try {
      client = clientFor(stack)
      current = await client.checkinStatus()
    } catch (error) {
      out.push({ regionId, label, status: 'error', message: `签到状态读取失败：${safeMessage(error)}` })
      continue
    }
    if (!current.enabled) {
      out.push({ regionId, label, status: 'none', message: '该账号未开通签到' })
      continue
    }
    if (current.checkedIn) {
      out.push({ regionId, label, status: 'already', message: `今日已领取${current.credits === undefined ? '' : `（${current.credits} 积分）`}` })
      continue
    }
    if (current.didCheckedIn) {
      out.push({ regionId, label, status: 'already', message: '本设备今日已签到（可能用的是另一个账号）' })
      continue
    }
    try {
      const claim = await client.claimCheckin()
      if (claim.code === CHECKIN_DEVICE_ALREADY_CLAIMED) {
        out.push({ regionId, label, status: 'already', message: '本设备今日已签到（上游已拒绝重复领取）' })
        continue
      }
      if (claim.claimed) {
        const after = await client.checkinStatus()
        out.push({ regionId, label, status: 'claimed', message: `签到成功：${checkinLines(toCheckin(after)).join(' | ')}` })
      } else {
        out.push({ regionId, label, status: 'error', message: `签到未成功：${claim.message ?? `code ${claim.code ?? '?'}`}` })
      }
    } catch (error) {
      out.push({ regionId, label, status: 'error', message: `签到失败：${safeMessage(error)}` })
    }
  }
  return out
}
