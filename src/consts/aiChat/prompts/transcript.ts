/** 群聊转录行内标注的共享模板。拼装侧（ai/utils/chatTranscript.ts 的
 * formatReplyReference/formatForwardTag）与说明文案侧（本目录 memory.ts 的
 * SUMMARY_SYSTEM_PROMPT、转录段首格式说明）共用同一模板，防止格式与说明
 * 各改各的漂移；说明里引用的占位形态直接以「…」代入模板生成，参照
 * workers/aiChat/mediaText.ts 的 resolvedTagFor 与 mediaTagHintFor。 */

/** 回复标注模板。target 是被回复者的完整身份段（[message_id:]/[id:] 等标记
 * 加显示名）；forwardTag/quote 传空串表示省略对应段。 */
export function replyTagTemplate(parts: { target: string; text: string; forwardTag: string; quote: string }): string {
  return `（回复 ${parts.target} 的消息${parts.forwardTag}：「${parts.text}」${parts.quote}）`;
}

/** 转发来源标注模板。origin 是预格式化的来源身份（见 auto/message/facts.ts
 * 的 resolveForwardOrigin）。 */
export function forwardTagTemplate(origin: string): string {
  return `（转发自 ${origin}）`;
}

/** 本轮回复任务使用的完整转发路径。origin 是原始来源，forwarder 是把内容
 * 带进当前群的发送者；箭头方向固定为「来源 → 转发者」。 */
export function forwardPathTemplate(origin: string, forwarder: string): string {
  return `转发路径：「${origin} → ${forwarder}」`;
}

/** 回复链中已滑出逐字热区、只剩上一跳回复快照的链尾标记。 */
export const REPLY_CHAIN_SNAPSHOT_TAG: string = "[仅回复快照]";

/** 多层回复链标注模板。triggerMessageId 是本轮触发消息的 message_id，links
 *  是已格式化的各跳行——第 1 行是触发消息直接回复的对象，逐级向更早追溯
 *  （见 ai/utils/chatTranscript.ts 的 formatReplyChain）。 */
export function replyChainTemplate(triggerMessageId: number, links: string[]): string {
  return (
    `补充：本轮触发消息（[message_id:${triggerMessageId}]）处在一条多层回复链上——它回复了下面第 1 条，第 1 条又回复了第 2 条，依此类推。` +
    `链沿仍在逐字聊天记录内的消息回溯；若最后一跳标有 ${REPLY_CHAIN_SNAPSHOT_TAG}，它是上一条消息自带的回复快照，原消息已不在逐字记录中。` +
    "各跳正文超长时会截断；除链尾快照外，完整原文以逐字记录为准。理解话题走向和人物指代时请顺着这条链看：\n" +
    links.map((link: string, index: number) => `${index + 1}. ${link}`).join("\n")
  );
}

/** 说明文案里引用的两种标注占位形态。 */
export const REPLY_TAG_HINT: string = replyTagTemplate({ target: "[message_id:…] …", text: "…", forwardTag: "", quote: "" });
export const FORWARD_TAG_HINT: string = forwardTagTemplate("…");
