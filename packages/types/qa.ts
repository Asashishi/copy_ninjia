/** 群问答（`/set_qa`）的共享类型。 */

/**
 * 一条已登记的群问答。
 *
 * `q` 是**原样保存的问题文本**（写入前只 trim 一次，不做大小写或标点归一化）：
 * 直答路径按原串在 Map 里查，热路径因此不必为每条群消息造一个归一化字符串。
 * 语义相近但文本不同的提问不走直答，交给模型的 group_qa_answer 判定。
 */
export interface QaEntry {
  readonly q: string;
  readonly a: string;
}

/** `chat_qa.data` 的严格 JSON 结构；答案单独成字段，便于将来扩展而不再迁移。 */
export interface ChatQaEntryData {
  readonly a: string;
}

/**
 * `/set_qa` 的一张按钮表单会话。
 *
 * 只活在主线程内存里：半填的表单不是需要跨重启恢复的状态，进程重启后按钮点下去
 * 会因为找不到会话而被拒绝，重开一张即可。两项都填好后由状态机删掉表单消息。
 *
 * **按群唯一，不按人**。inline 模式没有匿名概念：匿名管理员或频道身份发出的
 * `/set_qa`，命令侧看到的是 `sender_chat`（本群或该频道），而随后那条 inline
 * 查询必然来自操作者的真实用户账号——两个 id 天然对不上，按人索引的表单他们
 * 永远填不了。改成按群索引之后，「谁有资格写」由落群那一步重新校验权限决定，
 * 而不是由「谁开的表单」决定。
 */
export interface QaFormSession {
  readonly chatId: number;
  /** 开这张表单的身份，只用于日志定位；不参与查找，也不决定谁能填。 */
  readonly openedById: number;
  /** 表单消息 id；发送成功后回填，结算时按它删除。 */
  formMessageId: number | undefined;
  /** 已登记的问题文本；未设置时为 undefined。 */
  q: string | undefined;
  /** 已登记的答案文本；未设置时为 undefined。 */
  a: string | undefined;
  /** 到期自动结算的 timer；结算或提前完成时清除。 */
  timer: ReturnType<typeof setTimeout> | null;
}
