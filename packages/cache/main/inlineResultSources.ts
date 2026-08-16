import type { InlineResultSource } from "../../types/telegram";

/** 主线程 inline 应答的源文本登记表；Worker 不得 import。 */

/**
 * 查询者 id → 他最近一次 inline 应答的源文本与结果正文（见
 * infra/inlineResultSources.ts）。
 *
 * 广告检测只判用户自己写的字：inline 结果的正文是本 bot 渲染出来的（gag 的随机
 * 插点变形、运势的模板与防伪回执），只有源文本才是这个人真正打进去的内容，而
 * 落群消息里没有它。写入方是各 inline 功能的应答入口，读取方是
 * antiRaid/adCandidate.ts。
 *
 * 每个查询者只占一条、整体覆盖，不留历史；容量硬顶
 * INLINE_RESULT_SOURCE_MAX_AUTHORS，撑满按最久未登记的查询者淘汰。它不落盘，
 * 进程重启后随 isolate 一起消失，查不到只让那条消息退回「不判定」。
 */
export const inlineResultSources: Map<number, InlineResultSource> = new Map();
