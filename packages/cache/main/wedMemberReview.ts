/** Owner: 主线程。/wed 每日成员复核的启动门、取消句柄与单个在途目标。 */
import type { WedMemberReview } from "../../types/wed";

/**
 * initWedRuntime 创建，Bot 就绪后接纳统一午夜通知；停机取消等待与请求并由 wedRuntime 排空。
 * 容量为一个取消控制器、一个在途目标及两个日期标量；启动期间只保留最新待复核日期。
 * 同日通知去重，整轮未完成时跳过次日通知；Worker 崩溃保留本 owner，不重放维护通知。
 * 进程重启清空进度，下一次统一东京零点通知从已恢复成员开始。
 * 复核逐群保留至多 WED_MEMBER_LIMIT 个 ID 的快照，不持有跨线程镜像。
 * 当前目标只在查询期间填充，查询结算后清空；null 表示未初始化或已停止接纳。
 */
export const wedMemberReview: { current: WedMemberReview | null } = { current: null };

/** 群消息或成员更新确认当前探测目标仍在群时填充标记；由该次查询结算时清理。 */
export function noteWedMemberPresence(chatId: number, userId: number): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review?.chatId === chatId && review.userId === userId) review.observed = true;
}
