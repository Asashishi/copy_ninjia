/** 群问答（`/qa set`）的共享类型。 */

/**
 * 一条已登记的群问答。
 *
 * `q` 是原样保存的问题文本（写入前只 trim 一次，不做大小写或标点归一化）：
 * 直答路径按原串在 Map 里查。语义相近但文本不同的提问不走直答，交给模型的
 * group_qa_answer 判定。
 *
 * `a` 里的代码块以字面 ``` 围栏保存（见 libs/codeFence.ts），直答时原样渲染回代码块，
 * 落盘结构为单一字符串。
 */
export interface QaEntry {
  readonly q: string;
  readonly a: string;
}

/** `chat_qa.data` 的严格 JSON 结构，只含答案 `a`。 */
export interface ChatQaEntryData {
  readonly a: string;
}

/**
 * 从一条群消息里解析出的表单字段。
 *
 * 两项都可能缺席：一条消息可只带「问题」或「回答」之一，也可同时带两项。
 * 两项都解析不出来时调用方拿到的是 undefined，那条消息与本领域无关。
 */
export interface QaFieldInput {
  readonly q: string | undefined;
  readonly a: string | undefined;
}

/**
 * 一项表单字段被挡下的原因：超过长度上限（CHAT_QA_QUESTION_MAX_CHARS / CHAT_QA_ANSWER_MAX_CHARS），
 * 或含会被渲染成可点命令的文字（问题整条判定，答案只判定 ``` 代码块之外的部分）。
 */
export type QaFieldRejection =
  | "questionTooLong"
  | "questionHasCommand"
  | "answerTooLong"
  | "answerHasCommand";

/**
 * 一次表单投递的认领结果，交给命令层决定回执与是否结算表单。
 *
 * 被挡下的那一项不写进会话；`rejection` 告诉命令层该回哪句提示，表单本身保留。
 * 两项都被挡下时取问题的原因。
 */
export interface QaFormIngressResult {
  readonly session: QaFormSession;
  /** 本次真正写进会话的字段；被挡下或缺席的为 undefined。 */
  readonly accepted: QaFieldInput;
  /** 被挡下的原因；两项都合规（或缺席）时为 null。 */
  readonly rejection: QaFieldRejection | null;
}

/**
 * `/qa set` 的一张表单会话。
 *
 * 只活在主线程内存里，进程重启后不恢复。两项都填好后由状态机删掉表单消息。
 *
 * 按群索引，按发起人鉴权：同一群同时只有一张表单，`openedById` 决定谁能往里填，
 * 投递消息的可见身份必须与它一致。可见身份取 `sender_chat ?? from`（见
 * commands/commandActor.ts），命令侧与投递侧使用同一个 id。
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

/** 一条已投给 Disk I/O、尚未收到精确 ACK 的问答写入。 */
export interface UnacknowledgedChatQaWrite {
  readonly revision: number;
  /** 这次写入（问题加正文或墓碑）的准入估算字节，计入 unacknowledgedChatQaTotals。 */
  readonly bytes: number;
}
