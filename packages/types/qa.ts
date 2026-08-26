/** 群问答（`/set_qa`）的共享类型。 */

/**
 * 一条已登记的群问答。
 *
 * `q` 是**原样保存的问题文本**（写入前只 trim 一次，不做大小写或标点归一化）：
 * 直答路径按原串在 Map 里查，热路径因此不必为每条群消息造一个归一化字符串。
 * 语义相近但文本不同的提问不走直答，交给模型的 group_qa_answer 判定。
 *
 * `a` 里的代码块以**字面 ``` 围栏**保存（见 libs/codeFence.ts）：Telegram 把
 * 用户写的围栏折成了 `pre` 实体，存字面围栏才能在直答时原样渲染回代码块，
 * 同时让落盘结构保持单一字符串。
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
 * 从一条群消息里解析出的表单字段。
 *
 * 两项都可能缺席：一条消息通常只带「问题」或「回答」中的一样（用户分两条发），
 * 两样写在同一条里也照收。两项都解析不出来时调用方拿到的是 undefined，
 * 那条消息与本领域无关。
 */
export interface QaFieldInput {
  readonly q: string | undefined;
  readonly a: string | undefined;
}

/**
 * 一次表单投递的认领结果，交给命令层决定回执与是否结算表单。
 *
 * 超长的那一项**不会**写进会话：`tooLong` 只是告诉命令层该回哪句提示，
 * 用户重发一条合法的即可，表单本身留着。
 */
export interface QaFormIngressResult {
  readonly session: QaFormSession;
  /** 本次真正写进会话的字段；超长或缺席的为 undefined。 */
  readonly accepted: QaFieldInput;
  /** 问题超过 CHAT_QA_QUESTION_MAX_CHARS。 */
  readonly questionTooLong: boolean;
  /** 答案超过 CHAT_QA_ANSWER_MAX_CHARS。 */
  readonly answerTooLong: boolean;
}

/**
 * `/set_qa` 的一张表单会话。
 *
 * 只活在主线程内存里：半填的表单不是需要跨重启恢复的状态，进程重启后再发
 * 「问题:」「回答:」会因为找不到会话而不被认领，重开一张即可。两项都填好后
 * 由状态机删掉表单消息。
 *
 * **按群索引，按发起人鉴权**。表单在表里按群唯一（同一群同时只有一张），而
 * `openedById` 决定谁能往里填——投递消息的可见身份必须与它一致。可见身份取
 * `sender_chat ?? from`（见 commands/commandActor.ts），因此匿名管理员与频道
 * 身份开的表单，随后由同一层皮投递就能对上：命令侧与投递侧看到的是同一个 id。
 * inline 查询必然来自真实用户账号，因此不承担频道身份表单输入。
 */
export interface QaFormSession {
  readonly chatId: number;
  /** 开这张表单的可见身份；投递消息的身份必须与它相同才会被认领。 */
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
