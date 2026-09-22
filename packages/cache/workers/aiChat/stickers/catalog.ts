import type { StickerCatalogEntry } from "../../../../types/stickers/catalog";

/** owner：aiChat Worker。白名单贴纸包画面描述目录的权威内存状态。
 * 仅 aiChat/ai/stickers/catalog.ts 直接读写；其它领域不得绕过其公开生命周期 API。
 * 每包容量由 Telegram 当前贴纸集合自然约束，不另设 TTL；目录快照持久化到
 * memory/stickers/，Worker 重建时接收主线程镜像并启动目录对账。dirty、失败
 * 与生成中集合只属于本次 Worker 生命周期，重启后清空重建。 */

/**
 * pack short name -> (贴纸自身 file_unique_id -> 目录条目)。
 * 填充：从主线程镜像 hydrate，或由目录生成任务补齐。
 * 清理：对账剪枝删掉已移出包的贴纸；包退出配置白名单后，等生成任务结算且
 * dirty 快照上报完成，再由 pruneStickerCatalogs 删整包；Worker 销毁时释放。
 * 容量：外层为配置白名单、在途生成及待上报包，内层为该包在 Telegram 上的贴纸数。
 * Worker 崩溃重建：主线程重放 init 与当前白名单目录镜像，接收侧恢复条目并对账。
 */
export const catalogs: Map<string, Map<string, StickerCatalogEntry>> = new Map();

/** pack short name -> AI 生成的整包简介（≤200 字），供两层贴纸工具的第一层
 *  挑包；生成/重生成时机见 packages/aiChat/ai/stickers/catalog.ts 的 generatePackCatalog。
 *  清理与容量跟随 catalogs：包退出白名单且生成、上报责任结束后随目录删除。
 *  Worker 重建时由主线程目录镜像恢复。 */
export const packSummaries: Map<string, string> = new Map();

/** 自上次上报后有更新、待上报给主线程落盘的包。
 *  清理：全部上报成功后清空；退出白名单的包在生成与上报责任结束后释放目录。
 *  容量：catalogs 的待上报子集；Worker 重建时此集合为空，目录由主线程镜像恢复。 */
export const dirtyPacks: Set<string> = new Set();

/** pack short name -> (贴纸 file_unique_id -> 可以再试的最早时刻)。
 *  填充：贴纸缺少视觉源，或请求重试、允许的业务重采样结束后仍未得到描述。
 *  TTL 内对账跳过该贴纸；到期项由下一次对账移除并重试，维护节拍只选择当前白名单。
 *  清理：贴纸移出包时剪枝；包退出白名单且生成、上报责任结束后删除整包记录。
 *  容量：外层为当前白名单、在途生成及待上报包，内层至多为该包的贴纸数。
 *  不按容量淘汰、不落盘；Worker 重建后清空，失败记录由后续生成任务重新填充。 */
export const failedEntries: Map<string, Map<string, number>> = new Map();

/**
 * 正在后台生成中的包及其任务句柄。既用于防止 init/维护节拍重复发起，也供
 * Worker 停机 flush 等到目录不再改写后再上报最终 dirty 快照。任务 settle 后
 * 立即删除；每包至多一个任务，容量包括当前白名单及配置轮换前尚未结算的包。
 * Worker 重建后清空，由 init 与维护节拍重新登记。
 */
export const generatingPacks: Map<string, Promise<void>> = new Map();

/** 维护节拍选中不完整目录时记录的重试时刻，见 aiChat/ai/stickers/catalog.ts。
 *  容量为单个时间戳；Worker 重建时归零，表示本实例尚未发起维护重试。
 *  无需定期清理；没有待重试包时保持原值。 */
export const stickerCatalogRetryState: { lastAttemptAt: number } = { lastAttemptAt: 0 };
