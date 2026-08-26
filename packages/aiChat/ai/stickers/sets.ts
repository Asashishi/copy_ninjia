import type { StickerSet } from "@grammyjs/types";
import { logger } from "../../../infra/logger";
import { telegramApi } from "../../../infra/telegram";
import { raceAbort } from "../../../libs/abortSignal";
import { failedPacks, inflightStickerSets, stickerSetCache } from "../../../cache/workers/aiChat/stickers/sets";
import { STICKER_SET_FAILURE_RETRY_MS } from "../../../consts/aiChat/stickers";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";

/**
 * 与 grammy 的 `Api.getStickerSet(name, signal?)` 同签名，便于测试注入替身。
 *
 * signal 声明成 DOM 的 `AbortSignal`，而不是 grammy `.d.ts` 里那个来自
 * `abort-controller` 包的同名类型：两者运行期是同一个东西，静态结构却不兼容
 * （`dispatchEvent`/`composedPath` 的签名不同）。不兼容只在下面绑定
 * `telegramApi` 时断言，调用点与注入替身仍使用真实的 AbortSignal 类型检查。
 */
interface StickerSetApi {
  getStickerSet(packName: string, signal?: AbortSignal): Promise<StickerSet>;
}

/** grammy 的 signal 类型与 DOM 版结构不兼容（见 StickerSetApi），在这一处收口。 */
const defaultStickerSetApi: StickerSetApi = telegramApi as unknown as StickerSetApi;

/**
 * 白名单贴纸包的拉取与缓存（getStickerSet，按 pack short name）。
 * packages/aiChat/ai/tools/stickers.ts（两层贴纸工具）、packages/aiChat/ai/stickers/catalog.ts（贴纸目录
 * 生成）都用。
 *
 * 本模块持有 AI 闲聊 Worker 独占的贴纸集合缓存，因此**只能在那条线程里
 * 加载**；主线程也要用的两个纯函数在 aiChat/ai/stickers/describe.ts，理由见该文件
 * 模块头注。
 */

/** 拉取（或复用缓存）单个包的贴纸集合；失败返回 null（而非空集合），供
 *  调用方区分「拉取失败」与「包确实没有贴纸」——见 aiChat/ai/stickers/catalog.ts
 *  的 generatePackCatalog，剪枝逻辑必须能分辨这两种情况。
 *
 *  `signal` 只约束**本次调用自己的等待**，不驱动共享请求：合并后的那一次 Telegram
 *  请求属于所有等待者，其生命周期是 Worker 的（见下方 workerSignal）。把它绑到
 *  恰好第一个到达的调用方身上，会让那个调用方一取消就把结果连同正缓存回写和菜单
 *  失效一起作废，signal 仍存活的其余等待者只能拿到 null 并当成「这个包不可用」。 */
export async function getStickerSet(
  packName: string,
  api: StickerSetApi = defaultStickerSetApi,
  signal?: AbortSignal
): Promise<StickerSet | null> {
  if (signal?.aborted === true) return null;
  const cached: StickerSet | undefined = stickerSetCache.get(packName);
  if (cached) return cached;
  const retryAt: number | undefined = failedPacks.get(packName);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return null;
    failedPacks.delete(packName);
  }

  // 缓存未命中时把在途 Promise 也登记进缓存做请求合并（样式同
  // aiChat/ai/imageDescription.ts 的 describeMedia）：并发的几轮回复同时组装贴纸
  // 菜单时，同一个未缓存的包只对 Telegram 发一次请求。
  const inflight: Promise<StickerSet | null> | undefined = inflightStickerSets.get(packName);
  if (inflight) return waitForStickerSet(inflight, signal);

  // 共享请求绑 Worker 信号，而不是任一调用方的 signal：结果进的是 Worker 独占的
  // stickerSetCache，服务的是本线程后续所有回复，因此它的正确生命周期就是本线程的。
  // 现取当前 controller 的 signal（Worker 重建时 holder 会换一个新的，见
  // cache/workers/aiChat/worker.ts），这也正是下面两处 await 后守卫要挡的那件事。
  const workerSignal: AbortSignal = aiChatWorkerAbortController.current.signal;
  // 先登记占位、再启动请求：反过来的话，`api.getStickerSet` 同步抛出时（线程还
  // 没 installTelegramApi，currentTelegramApi() 就是内联抛）整个 IIFE 体在第一个
  // await 之前跑完，finally 删掉一个尚不存在的条目，随后这一行又把**已经 settle
  // 的** promise 塞回登记表，从此没人再删它。等 STICKER_SET_FAILURE_RETRY_MS 解除
  // failedPacks 之后，上面的 `if (inflight) return inflight` 永远返回那个
  // resolved-null，该贴纸包在 Worker 余生里静默缺席且不再报一次错。
  const request: Promise<StickerSet | null> = (async (): Promise<StickerSet | null> => {
    try {
      const set: StickerSet = await api.getStickerSet(packName, workerSignal);
      // 某些注入实现或代理可能忽略 signal；Worker 已停时仍不得回写正缓存。
      if (workerSignal.aborted) return null;
      stickerSetCache.set(packName, set);
      // 拉到一个此前拿不到的包会让贴纸菜单多出一项，记忆化的那份就旧了。
      invalidateStickerMenu();
      failedPacks.delete(packName);
      return set;
    } catch (error: unknown) {
      if (workerSignal.aborted) return null;
      logger.error(`Failed to fetch sticker set "${packName}":`, error);
      failedPacks.set(packName, Date.now() + STICKER_SET_FAILURE_RETRY_MS);
      return null;
    }
  })();
  inflightStickerSets.set(packName, request);
  // 摘除改挂在登记之后的 then 上，而不是 IIFE 自己的 finally：同步抛出那条路上
  // request 此刻已经 settle，回调只能进微任务队列，必然晚于上一行的 set，因此
  // 不会再出现「删了一个还没登记的键、随后又登记一个永不删除的条目」。按对象
  // 身份守卫删除，后来者登记的新请求不会被前一轮的回调误删。
  const settleInflight = (): void => {
    if (inflightStickerSets.get(packName) === request) {
      inflightStickerSets.delete(packName);
    }
  };
  void request.then(settleInflight, settleInflight);
  return waitForStickerSet(request, signal);
}

/** 每个调用方只取消自己的等待；共享请求继续服务其余等待者，见 libs/abortSignal.ts。 */
function waitForStickerSet(
  request: Promise<StickerSet | null>,
  signal?: AbortSignal
): Promise<StickerSet | null> {
  return raceAbort(request, { signal, cancelled: null, rejected: null });
}
