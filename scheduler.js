import fs from 'node:fs';
import { execFile } from 'node:child_process';

const LOG_PATH = 'C:/Users/MR/Desktop/mix_api_bridge_src/proxy-hub/debug.log';
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  console.error(line);
}

/**
 * 计算距下一个目标小时的毫秒数。
 * 如果当前已过目标小时，算到明天的该小时。
 */
function msUntilHour(targetHour) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

/**
 * 在指定本地小时每天执行一次 fn。
 * 返回 stop() 函数。
 */
export function scheduleDaily(hour, fn, label = '') {
  const tag = label || `hour=${hour}`;
  const initial = msUntilHour(hour);
  log(`SCHEDULER: ${tag} will fire in ${Math.round(initial / 60000)}min (at ${hour}:00)`);
  const timer = setTimeout(async () => {
    try { await fn(); } catch (e) { log(`SCHEDULER: ${tag} error: ${e.message}`); }
    // 之后每 24h 重复
    const interval = setInterval(async () => {
      try { await fn(); } catch (e) { log(`SCHEDULER: ${tag} error: ${e.message}`); }
    }, 24 * 60 * 60 * 1000);
    // 保存 interval 引用以便清理
    stop._interval = interval;
  }, initial);
  function stop() {
    clearTimeout(timer);
    if (stop._interval) clearInterval(stop._interval);
  }
  stop._timer = timer;
  return stop;
}

/**
 * Trae 签到：检查状态 → 领取 → 查询额度
 */
async function checkinTraeAdapter(adapter) {
  const id = adapter.id;
  try {
    // 1. 查询签到状态
    const status = await adapter.checkinStatus();
    const checkedIn = status.checked_in || status.data?.checked_in;
    const credits = status.credits ?? status.data?.credits ?? '?';
    const enabled = status.enable ?? status.data?.enable ?? true;

    if (checkedIn) {
      log(`CHECKIN: ${id} — already checked in, credits=${credits}`);
      return { id, result: 'already_checked_in', credits };
    }

    if (!enabled) {
      log(`CHECKIN: ${id} — checkin disabled by upstream`);
      return { id, result: 'disabled' };
    }

    // 2. 领取签到奖励
    const claim = await adapter.checkinClaim();
    const code = claim.code ?? claim.data?.code ?? 0;
    const msg = claim.message || claim.data?.message || '';
    if (code !== 0 && code !== 200) {
      log(`CHECKIN: ${id} — claim failed: code=${code} ${msg}`);
      return { id, result: 'claim_failed', code, message: msg };
    }
    log(`CHECKIN: ${id} — claimed successfully`);

    // 3. 查询剩余额度
    try {
      const usage = await adapter.entUsage();
      const packs = usage.user_entitlement_pack_list || usage.data?.user_entitlement_pack_list || [];
      let totalCredits = 0;
      for (const pack of packs) {
        const limit = pack.entitlement_base_info?.quota?.credits_limit ?? 0;
        const used = pack.usage?.credits_amount ?? 0;
        totalCredits += Math.max(0, limit - used);
      }
      log(`CHECKIN: ${id} — remaining credits: ${totalCredits}`);
      return { id, result: 'claimed', credits: totalCredits };
    } catch (e) {
      log(`CHECKIN: ${id} — entUsage failed: ${e.message}`);
      return { id, result: 'claimed_usage_unknown' };
    }
  } catch (e) {
    log(`CHECKIN: ${id} — error: ${e.message}`);
    return { id, result: 'error', error: e.message };
  }
}

/**
 * TraeWork Token 主动刷新（ExchangeToken）
 */
async function refreshTraeWorkToken(adapter) {
  const id = adapter.id;
  if (typeof adapter.refreshAuth !== 'function') {
    log(`REFRESH: ${id} — no refreshAuth method, skip`);
    return;
  }
  // TraeCN 没有 exchangeToken，只靠重读磁盘；TraeWork 有
  if (typeof adapter.exchangeToken !== 'function') {
    log(`REFRESH: ${id} — no exchangeToken (desktop-managed), re-read disk`);
    adapter.cache?.invalidate?.('auth');
    return;
  }
  try {
    await adapter.refreshAuth();
    log(`REFRESH: ${id} — token refreshed via ExchangeToken`);
  } catch (e) {
    log(`REFRESH: ${id} — failed: ${e.message}`);
  }
}

/**
 * Qoder 签到（通过 CLI）
 */
async function checkinQoderAdapter(adapter) {
  const id = adapter.id;
  const cmd = adapter.command || process.env.QODERCN_CLI || 'qoderclicn';
  return new Promise((resolve) => {
    execFile(cmd, ['checkin'], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        // CLI 未安装或签到失败
        if (err.code === 'ENOENT') {
          log(`CHECKIN: ${id} — CLI not found (${cmd}), skip`);
        } else {
          log(`CHECKIN: ${id} — CLI error: ${(stderr || err.message).slice(0, 200)}`);
        }
        resolve({ id, result: 'cli_error' });
        return;
      }
      const out = (stdout || '').trim();
      log(`CHECKIN: ${id} — CLI result: ${out.slice(0, 200)}`);
      resolve({ id, result: 'cli_done', output: out });
    });
  });
}

/**
 * 启动所有定时任务。
 * @param {Array} adapters adapter 实例数组
 */
export function startScheduler(adapters) {
  const traeAdapters = adapters.filter(a => a.id === 'traework' || a.id === 'traecn');
  const qoderAdapters = adapters.filter(a => a.id === 'qoder');

  // 每天 09:00 签到
  scheduleDaily(9, async () => {
    log('SCHEDULER: === daily checkin start ===');
    for (const a of traeAdapters) await checkinTraeAdapter(a);
    for (const a of qoderAdapters) await checkinQoderAdapter(a);
    log('SCHEDULER: === daily checkin done ===');
  }, 'checkin-09:00');

  // 每天 03:00 Token 刷新
  scheduleDaily(3, async () => {
    log('SCHEDULER: === token refresh start ===');
    for (const a of traeAdapters) await refreshTraeWorkToken(a);
    log('SCHEDULER: === token refresh done ===');
  }, 'refresh-03:00');

  log(`SCHEDULER: started with ${traeAdapters.length} trae + ${qoderAdapters.length} qoder adapters`);
}

// 导出供测试
export { checkinTraeAdapter, refreshTraeWorkToken, checkinQoderAdapter, msUntilHour };
