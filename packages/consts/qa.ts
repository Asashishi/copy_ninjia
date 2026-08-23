/** 群问答（`/set_qa`、`/query_qa`、`/remove_qa`）的字面量常量。 */

/**
 * 每群可登记的问答条数上限。
 *
 * 这个数同时是直答路径的成本上界：命中判定是一次 Map 查表，与条数无关，但
 * `/query_qa` 的全量渲染和 group_qa_query 交给模型的问题清单都按这个数封顶，
 * 因此它也是「一次工具调用最多喂给模型多少条」的硬约束。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_MAX_PER_CHAT: number = 5;

/**
 * 单条问题文本的最大长度（UTF-16 code unit）。
 *
 * 上限存在的理由不是存储，而是直答路径：问题文本是 Map 的键，超长键会让每条
 * 群消息的哈希与比较成本随之上涨。同时它也挡住把整段文章塞进 inline 预填。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_QUESTION_MAX_CHARS: number = 200;

/**
 * 单条答案文本的最大长度（UTF-16 code unit）。
 *
 * 留足一条正常 Telegram 消息的篇幅，同时远低于 4096 的单条消息上限——答案要能
 * 原样发出去，不能出现「存得下但发不出」的条目。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_ANSWER_MAX_CHARS: number = 2_000;

/**
 * `/set_qa` 按钮预填 inline 查询的问题前缀。
 *
 * 与 gag 同一套机制（switchInlineCurrent 预填当前输入框），因此前缀必须与
 * gag 的前缀互不为前缀，否则 inline 分发会认错领域。
 * 所属模块：packages/commands/qa/。
 */
export const QA_INLINE_QUESTION_PREFIX: string = "qa_q:";

/** `/set_qa` 按钮预填 inline 查询的答案前缀；约束同上。 */
export const QA_INLINE_ANSWER_PREFIX: string = "qa_a:";

/** `/set_qa` 表单上「设置文本」按钮的文案。 */
export const QA_QUESTION_BUTTON_TEXT: string = "设置文本";

/** `/set_qa` 表单上「设置答案」按钮的文案。 */
export const QA_ANSWER_BUTTON_TEXT: string = "设置答案";

/**
 * `/set_qa` 表单会话的存活时长：15 分钟内两项没填齐就算超时。
 *
 * 会话只握在主线程内存里（见 packages/cache/main/qa.ts），到点由状态机自己
 * 结算并删掉按钮表单；不进持久化——半填的表单不是需要跨重启恢复的状态。
 * 所属模块：packages/commands/qa/。
 */
export const QA_FORM_SESSION_TTL_MS: number = 15 * 60 * 1000;

/**
 * 全局同时存在的 `/set_qa` 表单会话上限。
 *
 * 会话按 (群, 发起人) 唯一，同一个人在同一群重开表单只会替换掉旧的那张，因此
 * 增长只可能来自「多个群 × 多个获授权身份」。这个数把它封死：达到上限后新的
 * `/set_qa` 直接被拒绝，而不是让一张永远不会被填完的表单表无声地长下去。
 * 所属模块：packages/cache/main/qa.ts。
 */
export const QA_FORM_SESSION_MAX: number = 50;

/**
 * inline 结果落群时的问题/答案标签。
 *
 * 它同时是 ingress 的认领判据：只有 `via_bot` 是本机器人、正文以这两个标签之一
 * 开头、且该 (群, 发起人) 确有未完成表单的消息才会被认领。三条都由 Telegram
 * 提供的事实判定，没有一条来自可伪造的载荷——用户手打同样的前缀不带 `via_bot`，
 * 走不到这条路径。落群后立刻删除，标签只在屏幕上闪一下。
 * 所属模块：packages/commands/qa/inline.ts。
 */
export const QA_INLINE_QUESTION_LABEL: string = "【问答·问题】";

/** inline 结果落群时的答案标签；语义与 QA_INLINE_QUESTION_LABEL 相同。 */
export const QA_INLINE_ANSWER_LABEL: string = "【问答·答案】";

/** 群问答三条命令的全部用户可见文案。 */
export const QA_COMMAND_TEXTS: Readonly<{
  notInitialized: string;
  rejected: (label: string) => string;
  full: string;
  formBusy: string;
  channelActor: string;
  formPrompt: string;
  formUnset: string;
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
  full: "本群问答已经满 5 条了，先 /remove_qa 掉一条再来，笨蛋♡",
  formBusy: "同时开着的问答表单太多了，等别人填完再来，杂鱼♡",
  channelActor:
    "套着频道马甲可不行——本天才根本看不见皮底下是谁，也没法让你用 inline。" +
    "换成你自己的号再来说话，杂鱼♡",
  formPrompt:
    "哼～想让本天才替你回话？问题和答案两样都给齐了才算数哦，杂鱼♡\n" +
    "点下面两个按钮分别设置，两样都齐了本天才就把这张表单收走♡",
  formUnset: "还没设呢，笨蛋♡",
  questionSaved: "问题嘛，本天才勉为其难记下了♡",
  answerSaved: "答案也收下了，就这点东西还要本天才替你背着♡",
  created: "新问答登记好了，以后有人原样问就由本天才代劳♡",
  replaced: "这条问题本来就有答案，已经换成新的那个了♡",
  persistFailed: "没写进硬盘，这条问答重启就没了，先去看看盘还在不在，笨蛋♡",
  queryEmpty: "本群一条问答都还没有呢，空空如也♡",
  queryPrefix: "本天才勉为其难给你看看本群的问答♡\n",
  queryMissing: (q: string): string => `没有「${q}」这条问答，看清楚再问，杂鱼♡`,
  removeUsage: "要删哪条？写成 /remove_qa <问题文本>，笨蛋♡",
  removed: (q: string): string => `「${q}」已经从本群问答里划掉了♡`,
  removeMissing: (q: string): string => `本群根本没有「${q}」这条问答，删什么呀杂鱼♡`,
};
