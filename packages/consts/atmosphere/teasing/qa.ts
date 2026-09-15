import { CHAT_QA_MAX_PER_CHAT, CHAT_QA_QUESTION_MAX_CHARS, CHAT_QA_ANSWER_MAX_CHARS, QA_FORM_SESSION_TTL_MS } from "../../qa";

/** `/qa query` 看板上一页按钮的文案。 */
export const QA_QUERY_PAGE_PREV_TEXT: string = "‹ 上一页";

/** `/qa query` 看板下一页按钮的文案。 */
export const QA_QUERY_PAGE_NEXT_TEXT: string = "下一页 ›";

/** 群问答三个子命令的表单、查询与删除文案。 */
export const QA_COMMAND_TEXTS: Readonly<{
  notInitialized: string;
  rejected: (label: string) => string;
  full: string;
  formBusy: string;
  formTaken: string;
  formPrompt: string;
  formUnset: string;
  questionTooLong: string;
  answerTooLong: string;
  questionSaved: string;
  answerSaved: string;
  created: string;
  replaced: string;
  persistFailed: string;
  queryEmpty: string;
  queryPrefix: string;
  queryMissing: (q: string) => string;
  removeUsage: string;
  removed: (q: string) => string;
  removeMissing: (q: string) => string;
}> = {
  notInitialized: "本群还没让本天才接管呢，先 /init enable 再来说问答的事，杂鱼♡",
  rejected: (label: string): string =>
    `${label} 也想动本群的问答？没有 isCanControllQaPermission 就别伸手，杂鱼♡`,
  full: `本群问答已经满 ${CHAT_QA_MAX_PER_CHAT} 条了，先 /qa remove 掉一条再来，笨蛋♡`,
  formBusy: "同时开着的问答表单太多了，等别人填完再来，杂鱼♡",
  formTaken:
    `本群已经有人在填问答表单了，等 TA 填完或 ${QA_FORM_SESSION_TTL_MS / 60_000} 分钟到期再来，杂鱼♡`,
  formPrompt:
    "哼～想让本天才替你回话？照下面的格式发两条消息过来，问题一条、回答一条，杂鱼♡\n" +
    "问题:\n（要人原样问出来的那句）\n" +
    "回答:\n（本天才替你答的那段，想塞 ``` 代码块也行）\n" +
    `${QA_FORM_SESSION_TTL_MS / 60_000} 分钟内两样都齐了本天才就把这张表单收走♡`,
  formUnset: "还没设呢，笨蛋♡",
  questionTooLong:
    `问题写这么长是要考谁？${CHAT_QA_QUESTION_MAX_CHARS} 字以内，重发一条，杂鱼♡`,
  answerTooLong:
    `答案超过 ${CHAT_QA_ANSWER_MAX_CHARS} 字了，本天才可背不动，删一点再发，笨蛋♡`,
  questionSaved: "问题嘛，本天才勉为其难记下了♡",
  answerSaved: "答案也收下了，就这点东西还要本天才替你背着♡",
  created: "新问答登记好了，以后有人原样问就由本天才代劳♡",
  replaced: "这条问题本来就有答案，已经换成新的那个了♡",
  persistFailed: "没写进硬盘，这条问答重启就没了，先去看看盘还在不在，笨蛋♡",
  queryEmpty: "本群一条问答都还没有呢，空空如也♡",
  queryPrefix: "本天才勉为其难给你看看本群的问答♡\n",
  queryMissing: (q: string): string => `没有「${q}」这条问答，看清楚再问，杂鱼♡`,
  removeUsage: "要删哪条？写成 /qa remove <问题文本>，笨蛋♡",
  removed: (q: string): string => `「${q}」已经从本群问答里划掉了♡`,
  removeMissing: (q: string): string => `本群根本没有「${q}」这条问答，删什么呀杂鱼♡`,
};
