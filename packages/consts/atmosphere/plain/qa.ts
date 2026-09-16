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
  notInitialized: "本群尚未接管，请先执行 /init enable。",
  rejected: (label: string): string => `${label} 没有 isCanControllQaPermission 权限，无法修改本群问答。`,
  full: `本群已达到 ${CHAT_QA_MAX_PER_CHAT} 条问答的上限，请先使用 /qa remove 删除不需要的条目。`,
  formBusy: "同时开启的问答表单已满，请稍后重试。",
  formTaken: `本群已有问答表单，请等待填写完成或 ${QA_FORM_SESSION_TTL_MS / 60_000} 分钟后到期。`,
  formPrompt: "请按以下格式分别发送问题和回答：\n问题:\n（需要原样匹配的文本）\n回答:\n（机器人发送的答案，可包含代码块）\n" + `请在 ${QA_FORM_SESSION_TTL_MS / 60_000} 分钟内填完，两项齐全后表单会自动关闭。`,
  formUnset: "尚未设置",
  questionTooLong: `问题不能超过 ${CHAT_QA_QUESTION_MAX_CHARS} 字，请缩短后重新发送。`,
  answerTooLong: `答案不能超过 ${CHAT_QA_ANSWER_MAX_CHARS} 字，请缩短后重新发送。`,
  questionSaved: "问题已记录。", answerSaved: "答案已记录。", created: "问答已登记，原样匹配问题时将自动发送答案。",
  replaced: "已有问题的答案已更新。", persistFailed: "问答未能保存，请管理员检查存储状态。", queryEmpty: "本群尚未登记问答。", queryPrefix: "本群问答：\n",
  queryMissing: (q: string): string => `未找到问题「${q}」。`, removeUsage: "请使用 /qa remove <问题文本> 指定要删除的问题。",
  removed: (q: string): string => `已删除问题「${q}」。`, removeMissing: (q: string): string => `本群不存在问题「${q}」，未删除任何条目。`,
};
