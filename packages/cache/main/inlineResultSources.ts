/** owner: main。主线程 inline 应答的源文本登记表；Worker 不得 import。 */

import { INLINE_RESULT_SOURCE_MAX_AUTHORS } from "../../consts/telegram";
import { LruCache } from "../../libs/lruCache";
import type { InlineResultSource } from "../../types/telegram";

/**
 * 发言身份 id（结果落群后的发送者：gag 会话目标或运势查询者）→ 它最近一次
 * inline 应答的源文本与结果正文（见 infra/inlineResultSources.ts）。
 *
 * inline 结果正文由本 bot 渲染（gag 的随机插点变形、运势的模板与防伪回执），
 * 本表保存发言身份实际输入的源文本，落群消息里不含它。写入方是各 inline 功能的应答入口，
 * 读取方是 antiRaid/adCandidate.ts。
 *
 * 每个发言身份只占一条、整体覆盖，不留历史；容量硬顶
 * INLINE_RESULT_SOURCE_MAX_AUTHORS，撑满按最久未登记的发言身份淘汰（登记用 set 刷新
 * 顺位，查询只 peek，不算一次使用）。不落盘，进程重启后为空；查不到时该消息整条不做广告判定。
 */
export const inlineResultSources: LruCache<number, InlineResultSource> =
  new LruCache<number, InlineResultSource>(INLINE_RESULT_SOURCE_MAX_AUTHORS);
