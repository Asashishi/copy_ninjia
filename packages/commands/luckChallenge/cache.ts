import {
  dailyLuckCache,
  dailyLuckCacheSaturated,
  luckCacheState,
  luckReceiptSecretState,
  luckRuntimeState,
  pendingLuckDraws,
} from "../../cache/main/luckChallenge";
import {
  DAILY_LUCK_CACHE_MAX,
  luckTierByLabel,
  PENDING_LUCK_CACHE_MAX,
} from "../../consts/luckChallenge";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { logger } from "../../infra/logger";
import { getDateKey } from "../../libs/time";
import type { DiskIORecoveryTransport } from "../../types/diskIO/messages";
import type { LuckAppendStalledReply } from "../../types/diskIO/replies";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";
import { ensureLuckReceiptSecret, onDiskIORespawn, onDiskIOReply, postDiskIO } from "../../infra/diskIO";
import { setBoundedMapValue } from "../../libs/boundedMap";

/**
 * 采用某个配置时区自然日的持久化密钥，并清空日缓存与 pending。换日采用时置
 * luckRuntimeState.daySwitchedInProcess，标记进程内已跨过配置时区的零点（见
 * promotePendingDraw：此后 pending 未命中不允许重建派生）。
 */
function adoptLuckSecret(secret: LuckReceiptSecret): void {
  if (luckCacheState.dayKey && luckCacheState.dayKey !== secret.day) {
    luckRuntimeState.daySwitchedInProcess = true;
  }
  luckReceiptSecretState.current = secret;
  luckCacheState.dayKey = secret.day;
  dailyLuckCache.clear();
  dailyLuckCacheSaturated.current = false;
  pendingLuckDraws.clear();
}

/**
 * 收下一条当日已确认结果；达到 DAILY_LUCK_CACHE_MAX 时拒收（不淘汰既有条目）并只记一行日志
 * （见 consts/luckChallenge.ts）。被拒的 key 重新预览仍得到同一结果（派生是确定性的）。
 * @returns 真的收下了为 true；撑满拒收为 false，调用方据此决定要不要落盘。
 */
function admitDailyLuckEntry(cacheKey: string, draw: LuckDraw): boolean {
  if (!dailyLuckCache.has(cacheKey) && dailyLuckCache.size >= DAILY_LUCK_CACHE_MAX) {
    if (!dailyLuckCacheSaturated.current) {
      dailyLuckCacheSaturated.current = true;
      logger.error(
        `Daily luck cache reached its ${DAILY_LUCK_CACHE_MAX}-entry ceiling for ${luckCacheState.dayKey}; ` +
        "further confirmed draws will not be remembered or persisted until the configured local day rolls over."
      );
    }
    return false;
  }
  dailyLuckCache.set(cacheKey, draw);
  return true;
}

type LuckSecretLoader = (day: string) => Promise<LuckReceiptSecret>;

interface EnsureLuckCacheFreshOptions {
  loadSecret: LuckSecretLoader;
  retryAfterSharedFailure: boolean;
}

async function rotateLuckCache(
  requestedDay: string,
  loadSecret: LuckSecretLoader
): Promise<void> {
  let targetDay: string = requestedDay;
  for (;;) {
    const secret: LuckReceiptSecret = await loadSecret(targetDay);
    if (secret.day !== targetDay) {
      throw new Error(`Disk I/O Worker returned luck secret for ${secret.day}, expected ${targetDay}`);
    }
    const currentDay: string = getDateKey();
    if (currentDay === targetDay) {
      adoptLuckSecret(secret);
      return;
    }
    targetDay = currentDay;
  }
}

async function ensureLuckCacheFresh({
  loadSecret,
  retryAfterSharedFailure,
}: EnsureLuckCacheFreshOptions): Promise<void> {
  for (;;) {
    const todayKey: string = getDateKey();
    if (
      todayKey === luckCacheState.dayKey &&
      luckReceiptSecretState.current?.day === todayKey
    ) {
      return;
    }
    const sharedRefresh: Promise<void> | null = luckRuntimeState.dayRefreshPromise;
    if (sharedRefresh !== null) {
      try {
        await sharedRefresh;
      } catch (error: unknown) {
        if (!retryAfterSharedFailure) throw error;
      } finally {
        if (luckRuntimeState.dayRefreshPromise === sharedRefresh) {
          luckRuntimeState.dayRefreshPromise = null;
        }
      }
      continue;
    }
    const refresh: Promise<void> = rotateLuckCache(todayKey, loadSecret);
    luckRuntimeState.dayRefreshPromise = refresh;
    try {
      await refresh;
      return;
    } finally {
      if (luckRuntimeState.dayRefreshPromise === refresh) {
        luckRuntimeState.dayRefreshPromise = null;
      }
    }
  }
}

/** 跨配置时区的零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。 */
export function ensureLuckCacheFreshForToday(): Promise<void> {
  return ensureLuckCacheFresh({
    loadSecret: ensureLuckReceiptSecret,
    retryAfterSharedFailure: false,
  });
}

function currentLuckSecret(): LuckReceiptSecret {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (secret?.day !== luckCacheState.dayKey) {
    throw new Error("Daily luck receipt secret is not initialized");
  }
  return secret;
}

/** 预览优先复用已确认和 pending 结果；新结果只进有界 pending 缓存。 */
export function getOrDrawLuck(cacheKey: string): LuckDraw {
  const confirmed: LuckDraw | undefined = dailyLuckCache.get(cacheKey);
  if (confirmed) return confirmed;
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  if (pending) return pending;

  const draw: LuckDraw = deriveLuckDraw(currentLuckSecret(), cacheKey);
  setBoundedMapValue({
    map: pendingLuckDraws,
    key: cacheKey,
    value: draw,
    maxEntries: PENDING_LUCK_CACHE_MAX,
  });
  return draw;
}

/**
 * chosen result 或有效签名把 pending 转正；重复确认幂等。
 *
 * pending 未命中时的重建派生（deriveLuckDraw 是确定性的）只在密钥同日时进行：
 * 进程重启后确认信号迟到时，重建结果与用户看到的一致。进程内跨过配置时区的零点后
 * （luckRuntimeState.daySwitchedInProcess），pending 未命中一律丢弃，除非调用方证明
 * 确认属于当天（签名回执验签，见 receipt.ts 的 confirmLuckDraw）；
 * chosen_inline_result 不带日期证明，跨天后丢弃。
 * @param confirmedForToday 调用方已证明这次确认属于当天（签名回执验签通过），
 *   允许在跨天后仍走重建派生。
 */
export function promotePendingDraw(cacheKey: string, confirmedForToday: boolean = false): void {
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (dailyLuckCache.has(cacheKey)) return;
  if (!pending && luckRuntimeState.daySwitchedInProcess && !confirmedForToday) return;
  const draw: LuckDraw = pending ?? deriveLuckDraw(currentLuckSecret(), cacheKey);

  // 撑满时不投递落盘消息。
  if (!admitDailyLuckEntry(cacheKey, draw)) return;
  // 判 postDiskIO 的返回值：Worker 已终止、或恢复握手期积压达到硬顶时返回 false，
  // 条目此刻只在 dailyLuckCache 中，记一行错误日志；Worker 重生后由
  // onDiskIORespawn 的全量重放补投。
  if (!postDiskIO({
    type: "luckDraw",
    day: luckCacheState.dayKey,
    key: cacheKey,
    label: draw.tier.label,
    fortunePercent: draw.fortunePercent,
  })) {
    logger.error(
      `Daily luck draw for key ${cacheKey} on ${luckCacheState.dayKey} was not handed to the persistence Worker; ` +
      `it is only in memory until the Worker respawns and the cache is replayed.`
    );
  }
}

function initializeRespawnRecovery(): void {
  if (luckRuntimeState.respawnRecoveryInitialized) return;
  luckRuntimeState.respawnRecoveryInitialized = true;
  onDiskIORespawn("daily luck", DISK_IO_RESPAWN_PRIORITIES.DAILY_LUCK, async (
    transport: DiskIORecoveryTransport
  ): Promise<boolean> => {
    await ensureLuckCacheFresh({
      loadSecret: transport.ensureLuckReceiptSecret,
      retryAfterSharedFailure: true,
    });
    for (const [key, draw] of dailyLuckCache) {
      if (!transport.post({
        type: "luckDraw",
        day: luckCacheState.dayKey,
        key,
        label: draw.tier.label,
        fortunePercent: draw.fortunePercent,
      })) {
        return false;
      }
    }
    return true;
  });
  // 落盘线程连续追加失败的告警在主线程经 logger 写入 logs/；触发口径与边沿语义见
  // workers/diskIO/luckFiles.ts。
  onDiskIOReply("luckAppendStalled", (reply: LuckAppendStalledReply): void => {
    logger.error(
      `Daily luck appends for ${reply.day} have failed ${reply.consecutiveFailures} times in a row; ` +
      `${reply.pendingEntries} confirmed draw(s) are stuck in the persistence Worker and are not on disk. ` +
      `Last error: ${reply.error}`
    );
  });
}

/** 启动时接管当天密钥与已确认缓存，并显式安装 diskIO Worker 重建重放。 */
export function restoreLuckState(secret: LuckReceiptSecret, loaded: LuckDayCache | null): void {
  initializeRespawnRecovery();
  const todayKey: string = getDateKey();
  if (secret.day !== todayKey) {
    // 进程恰好卡在配置时区 00:00 前后启动：Disk I/O Worker 在启动边界取的是 D，
    // 主线程收到 load 回执时已经是 D+1。丢掉这份过期凭据：不 adopt，缓存留空，
    // 首次用到运势时由 ensureLuckCacheFreshForToday 向 Worker 重新取当天密钥。
    // 同时置 daySwitchedInProcess，让 promotePendingDraw 对拿不出当天证明的确认
    // 一律丢弃。loaded 一并丢弃，它属于 secret.day 那一天，磁盘上那份由 Worker 侧的
    // cleanupStaleLuckFiles 按新日期清掉。
    logger.warn(
      `Loaded luck receipt secret is for ${secret.day} but the configured local day already rolled over to ${todayKey}; ` +
      "discarding it and re-deriving today's secret on first use."
    );
    luckRuntimeState.daySwitchedInProcess = true;
    return;
  }
  adoptLuckSecret(secret);
  if (loaded?.day !== todayKey) return;

  for (const [key, record] of loaded.entries) {
    const tier: LuckTier | undefined = luckTierByLabel(record.label);
    if (!tier) {
      throw new Error("Loaded luck state violates the validated tier-label invariant.");
    }
    const [min, max]: readonly [number, number] = tier.fortunePercentRange;
    if (record.fortunePercent < min || record.fortunePercent > max) {
      throw new Error("Loaded luck state violates the validated tier-range invariant.");
    }
    // 恢复同样经 admitDailyLuckEntry 过闸，超过上限时抛错。
    if (!admitDailyLuckEntry(key, { tier, fortunePercent: record.fortunePercent })) {
      throw new Error("Loaded luck state exceeds the validated persistence capacity.");
    }
  }
}
