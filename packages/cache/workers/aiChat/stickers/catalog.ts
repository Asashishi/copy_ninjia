import type { StickerCatalogEntry } from "../../../../types/stickers/catalog";

/** 白名单贴纸包画面描述目录（packages/ai/stickers/catalog.ts）的权威内存状态。
 * 仅 ai/stickers/catalog.ts 直接读写；其它领域不得绕过其公开生命周期 API。
 * 每包容量由 Telegram 当前贴纸集合自然约束，不另设 TTL；目录快照持久化到
 * memory/stickers/，Worker 重建时先 hydrate，再与线上集合对账。dirty、失败
 * 与生成中集合只属于本次 Worker 生命周期，重启后清空重建。 */

/** pack short name -> (贴纸自身 file_unique_id -> 目录条目)。 */
export const catalogs: Map<string, Map<string, StickerCatalogEntry>> = new Map();

/** pack short name -> AI 生成的整包简介（≤200 字），供两层贴纸工具的第一层
 *  挑包；生成/重生成时机见 packages/ai/stickers/catalog.ts 的 generatePackCatalog。 */
export const packSummaries: Map<string, string> = new Map();

/** 自上次上报后有更新、待上报给主线程落盘的包。 */
export const dirtyPacks: Set<string> = new Set();

/** pack short name -> (贴纸 file_unique_id -> 可以再试的最早时刻)：退避重试用完
 *  仍失败才进来（见 ai/stickers/catalog.ts 的 callWithRetry），到期之前的对账
 *  跳过这枚贴纸。
 *
 *  **必须带 TTL、不能是永久闩**：首次部署撞上一次视觉端点故障（配额耗尽、密钥
 *  刚轮换、runMediaTask 饱和）会让整包每一枚都描述不出来、全部进这张表，此后
 *  retryIncompleteStickerCatalogs 虽然每 5 分钟正确地重新选中这个包，
 *  generatePackCatalog 却会把每一枚都原地跳过——目录永远填不起来，两个贴纸工具
 *  对所有回复返回 null 直到进程重启，而 systemd 托管的进程可以连跑几周。理由同
 *  cache/workers/aiChat/stickers/sets.ts 的 failedPacks 用负缓存而不是永久表。
 *
 *  按包分桶，让对账剪枝能把已被移出包的贴纸的失败记录一并清掉，不必滞留到
 *  Worker 重启。 */
export const failedEntries: Map<string, Map<string, number>> = new Map();

/** 正在后台生成中的包，防止 init 消息重放（Worker 崩溃重启）时重复发起。 */
export const generatingPacks: Set<string> = new Set();

/** 上一次「目录仍不完整」的周期重试时刻（见 ai/stickers/catalog.ts 的
 *  retryIncompleteStickerCatalogs）。0 表示本进程还没试过，第一次维护节拍
 *  就会补一次；只在主线程之外的 AI 闲聊线程里被读写。 */
export const stickerCatalogRetryState: { lastAttemptAt: number } = { lastAttemptAt: 0 };
