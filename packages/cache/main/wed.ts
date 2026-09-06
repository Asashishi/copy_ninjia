/** Owner: 主线程。/wed 的按钮会话与执行器。 */
import { WED_CHAT_CACHE_MAX_ENTRIES } from "../../consts/wed";
import { LruCache } from "../../libs/lruCache";
import type { WedChat, WedRuntime } from "../../types/wed";

/**
 * 已初始化群首次交互时填充，成员集合引用 wedMembers.ts 的 owner；每位发起人
 * 一张会话，每群最多 WED_SESSION_LIMIT 张，最多 WED_CHAT_CACHE_MAX_ENTRIES 个群。
 * 命中刷新 LRU 顺序；新增由 getOrCreateWedChat 在满额时清理并淘汰最旧群。
 * 会话满额拒绝新建；移除按钮、重开、LRU 淘汰与群 teardown 清理会话并取消在途操作。
 * Worker 崩溃不影响本表；进程重启清空交互，旧按钮提示重新 /wed。
 */
export const wedChats: LruCache<number, WedChat> = new LruCache(WED_CHAT_CACHE_MAX_ENTRIES);

/**
 * 启动时创建 /wed 执行器，最多 WED_MAX_CONCURRENT 个在途交互和 WED_MAX_PENDING
 * 个 FIFO 等待项。群 teardown 撤销该群等待项；停机停止接纳并有界排空，超时取消。
 * LRU 淘汰后的空闲结果删除同样登记到 tasks，结算自摘除并参与本代停机排空。
 * 每日成员复核至多一项登记到 tasks；quiesce 先取消复核，再等待结算并投递最终成员集合。
 * Worker 崩溃不影响本主线程 owner；进程重启不重放纯内存交互。
 */
export const wedRuntime: { current: WedRuntime | null } = { current: null };
