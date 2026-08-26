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
import { getTokyoDateKey } from "../../libs/time";
import type { DiskIORecoveryTransport, LuckAppendStalledReply } from "../../types/diskIO";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";
import { ensureLuckReceiptSecret, onDiskIORespawn, onLuckAppendStalled, postDiskIO } from "../../infra/diskIO";
import { setBoundedMapValue } from "../../libs/boundedMap";

/** 进程内是否发生过跨东京零点的日切换（即 adoptLuckSecret 清空过前一天的
 *  pending）。见 promotePendingDraw：切换后 pending 未命中不再允许重建派生。 */

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
 * 收下一条当日已确认结果，撑满时拒收并只记一行日志。
 *
 * 拒收而不是淘汰最旧：淘汰等于让一个刷子把当天正常用户的记录顶掉。被拒的 key
 * 只是「今天测过」记不住——派生是确定性的，重新预览仍是同一条结果（取舍见
 * consts/luckChallenge.ts 的 DAILY_LUCK_CACHE_MAX）。
 * @returns 真的收下了为 true；撑满拒收为 false，调用方据此决定要不要落盘。
 */
function admitDailyLuckEntry(cacheKey: string, draw: LuckDraw): boolean {
  if (!dailyLuckCache.has(cacheKey) && dailyLuckCache.size >= DAILY_LUCK_CACHE_MAX) {
    if (!dailyLuckCacheSaturated.current) {
      dailyLuckCacheSaturated.current = true;
      logger.error(
        `Daily luck cache reached its ${DAILY_LUCK_CACHE_MAX}-entry ceiling for ${luckCacheState.dayKey}; ` +
        "further confirmed draws will not be remembered or persisted until the Tokyo day rolls over."
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
    const currentDay: string = getTokyoDateKey();
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
    const todayKey: string = getTokyoDateKey();
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

/** 跨东京零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。 */
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
 * pending 未命中时的重建派生（deriveLuckDraw 是确定性的）只对「同一天丢了
 * 内存」的场景成立：进程重启后确认信号迟到（pending 全丢、密钥同日），
 * 重建结果与用户看到的完全一致。而进程内一旦跨过东京零点，未命中的主因
 * 就是旧日 pending 被 adoptLuckSecret 整体清空——用新一天的密钥重派生出来
 * 的是用户根本没见过的另一个结果，不能落盘「确认」，除非调用方能证明确认
 * 属于当天（签名回执自带发放当天的密钥、验签即证明，见 receipt.ts 的
 * confirmLuckDraw）；chosen_inline_result 不带任何日期证明，跨天后一律
 * fail closed 丢弃，与回执路径「验签失败即丢弃」对齐。同日内被容量淘汰的
 * pending 被顺带拒绝也无损：派生是确定性的，重新预览仍是同一结果。
 * @param confirmedForToday 调用方已证明这次确认属于当天（目前只有签名回执
 *   验签通过这一种证明），允许在跨天后仍走重建派生。
 */
export function promotePendingDraw(cacheKey: string, confirmedForToday: boolean = false): void {
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (dailyLuckCache.has(cacheKey)) return;
  if (!pending && luckRuntimeState.daySwitchedInProcess && !confirmedForToday) return;
  const draw: LuckDraw = pending ?? deriveLuckDraw(currentLuckSecret(), cacheKey);

  // 撑满时连落盘消息都不投：那正是 Worker 侧当日镜像与 memory/luck/<day>.json
  // 一起无界增长的入口。
  if (!admitDailyLuckEntry(cacheKey, draw)) return;
  // 返回值必须判：条目此刻已经进了 dailyLuckCache，而 postDiskIO 在 Worker 已
  // 终止、或恢复握手期积压撑到硬顶时返回 false 且自己不打印任何东西——不判就
  // 意味着这条抽签只存在于主线程内存里，磁盘上没有、日志里也没有。
  // onDiskIORespawn 的全量重放能补上窗口期的空洞，但那要 Worker 真的重生；
  // fatal 之后不再拉起、或重放自己也 post 失败时，空洞就永久留着。
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
  // 落盘线程连续追加失败时唯一能进 logs/ 的告警：Worker 侧只有 console.error，
  // 而把 stdout/stderr 接到 /dev/null 的部署上那等于没有——那种部署上「抽签
  // 在 dailyLuckCache 里命中、memory/luck/<day>.json 却永远不涨」是完全不可
  // 观测的。触发口径与边沿语义见 workers/diskIO/luckFiles.ts。
  onLuckAppendStalled((reply: LuckAppendStalledReply): void => {
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
  const todayKey: string = getTokyoDateKey();
  if (secret.day !== todayKey) {
    // 进程恰好卡在东京 00:00 前后启动：Disk I/O Worker 在启动边界算出的
    // 是 D，主线程等到 load 回执时已经是 D+1。这不是坏数据，只是这套「两个线程
    // 各算一次日期」天然带的竞态窗口。在这里抛错的话异常会逸出
    // ApplicationLifecycle.init()（调用点没有 try/catch），run() 记一行日志并以
    // 退出码 1 结束——一次日切让 bot 起不来，靠进程管理器重启才恢复，日志上留下
    // 一次无从解释的启动失败。
    //
    // 正确处置是丢掉这份过期凭据而不是拒绝启动：不 adopt，缓存留空，首次用到
    // 运势时由 ensureLuckCacheFreshForToday 向 Worker 重新取当天密钥（那条路本来
    // 就是为跨天准备的，每个入口都会先 await 它）。同时标记「本进程内已跨日」，
    // 让 promotePendingDraw 对拿不出当天证明的确认一律 fail closed——旧日 pending
    // 根本没恢复过来，用新一天的密钥重派生出的是用户没见过的另一个结果。
    // loaded 一并丢弃：它属于 secret.day 那一天，磁盘上那份也会被 Worker 侧的
    // cleanupStaleLuckFiles 按新日期清掉。
    logger.error(
      `Loaded luck receipt secret is for ${secret.day} but the Tokyo day already rolled over to ${todayKey}; ` +
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
    // 恢复同样过闸：磁盘上那份可能是上一版本留下的、超过当前上限的文件。
    if (!admitDailyLuckEntry(key, { tier, fortunePercent: record.fortunePercent })) {
      throw new Error("Loaded luck state exceeds the validated persistence capacity.");
    }
  }
}
