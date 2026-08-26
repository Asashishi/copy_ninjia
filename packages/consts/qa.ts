/** 群问答（`/set_qa`、`/query_qa`、`/remove_qa`）的字面量常量。 */

/**
 * 每群可登记的问答条数上限。
 *
 * 这个数同时是直答路径的成本上界：命中判定是一次 Map 查表，与条数无关，但
 * `/query_qa` 的全量渲染和 group_qa_query 交给模型的问题清单都按这个数封顶，
 * 因此它也是「一次工具调用最多喂给模型多少条」的硬约束。
 *
 * 它还乘出三个派生上界，改这个数就要一起重算：主线程热表与 Disk I/O 未提交
 * 缓冲各自的 `STATE_MANAGED_CHAT_LIMIT × 本数`（当前 375 条），以及看板页数
 * `ceil(本数 / QA_QUERY_PAGE_MAX_ENTRIES)`（当前 5 页）。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_MAX_PER_CHAT: number = 15;

/**
 * 单条问题文本的最大长度（UTF-16 code unit）。
 *
 * 上限存在的理由不是存储，而是直答路径：问题文本是 Map 的键，超长键会让每条
 * 群消息的哈希与比较成本随之上涨。同时它也挡住把整段文章当成问题登记。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_QUESTION_MAX_CHARS: number = 256;

/**
 * 单条答案文本的最大长度（UTF-16 code unit），按**含 ``` 围栏的落盘文本**计。
 *
 * 答案要能原样发出去，不能出现「存得下但发不出」的条目，因此上限必须留在
 * Telegram 单条消息 4096 之下；余量留给围栏被拆回 `pre` 实体之外的正文。
 * 代码块在落盘时以字面围栏保存（见 libs/codeFence.ts），围栏本身也算进这个数。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_ANSWER_MAX_CHARS: number = 3_840;

/**
 * `/set_qa` 表单接受的问题字段标签。
 *
 * 半角与全角冒号都收：用户在中文输入法下打出的是「问题：」，而从文档里抄的
 * 多半是「问题:」，两种都判失败只会让人反复重发。标签只在**行首**生效，
 * 且不认代码块内部的行（见 commands/qa/rendering.ts）。
 * 所属模块：packages/commands/qa/rendering.ts。
 */
export const QA_QUESTION_LABELS: readonly string[] = ["问题:", "问题："];

/**
 * `/set_qa` 表单接受的答案字段标签；「答案」是本天才自己回执里的说法，
 * 一并收下，免得用户照着回执抄反而对不上。判定口径同 QA_QUESTION_LABELS。
 */
export const QA_ANSWER_LABELS: readonly string[] = ["回答:", "回答：", "答案:", "答案："];

/**
 * `/set_qa` 表单会话的存活时长：15 分钟内两项没填齐就算超时。
 *
 * 会话只握在主线程内存里（见 packages/cache/main/qa.ts），到点由状态机自己
 * 结算并删掉表单；不进持久化——半填的表单不是需要跨重启恢复的状态。
 * 所属模块：packages/commands/qa/。
 */
export const QA_FORM_SESSION_TTL_MS: number = 15 * 60 * 1000;

/**
 * 全局同时存在的 `/set_qa` 表单会话上限。
 *
 * 会话按群唯一，同一个群重开表单只会替换掉旧的那张，因此增长只可能来自群数。
 * 这个数把它封死：达到上限后新的 `/set_qa` 直接被拒绝，而不是让一张永远不会
 * 被填完的表单表无声地长下去。
 * 所属模块：packages/cache/main/qa.ts。
 */
export const QA_FORM_SESSION_MAX: number = 50;

/**
 * `/query_qa` 看板上单条答案的展示上限（UTF-16 code unit，含省略号）。
 *
 * 看板是给人扫一眼对照用的，不是取回答案的通道——真要完整答案，原样问一次
 * 就由直答给出。问题**不截断**：它是 `/remove_qa` 的入参，截断过的问题照抄
 * 回去会删不掉任何东西。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_ANSWER_PREVIEW_MAX_CHARS: number = 256;

/**
 * 群问答回显被截断时补的省略号，看板与表单共用一份。
 *
 * 两处都把它算进各自的预算之内，因此截断结果不会超出上限；它同时是「这里
 * 还没看全」的唯一提示，不能省。
 * 所属模块：packages/commands/qa/board.ts 与 packages/commands/qa/rendering.ts。
 */
export const QA_TRUNCATION_MARK: string = "…";

/**
 * `/query_qa` 看板 JSON 代码块的语言标记，决定 Telegram 用哪套高亮渲染。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_JSON_LANGUAGE: string = "json";

/**
 * `/query_qa` 看板单页装几条问答。
 *
 * 按条数装页而不是按长度预算：预算装页会让短问答全挤进一页，翻页条整个不出现
 * （`buildQaBoardKeyboard` 在只有一页时返回 undefined），看板每次都是一整屏。
 * 固定条数才让版面稳定、翻页行为可预期。
 *
 * 不需要再叠一道长度闸：问题受 CHAT_QA_QUESTION_MAX_CHARS（256）约束、由
 * database/codec/chatQa.ts 在落库与解码两侧强制，答案在看板上被
 * QA_QUERY_ANSWER_PREVIEW_MAX_CHARS（256）压过，因此满页三条的上界远在
 * TELEGRAM_MESSAGE_MAX_CHARS 之内。改动这三个数中的任何一个都要重算这个乘积。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_PAGE_MAX_ENTRIES: number = 3;

/**
 * `/query_qa` 翻页按钮的 callback_data 前缀，后面接目标页号（从 0 起）。
 *
 * 前缀必须与入群验证按钮的前缀互不为前缀，否则 callback 分发会认错领域。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_PAGE_CALLBACK_PREFIX: string = "qa_page:";

/**
 * 页码指示按钮的 callback_data：它只是块占位，点了什么都不改。
 *
 * 单独给一个取值而不是复用当前页号，是因为「翻到当前页」会让 Telegram 以
 * 「消息未改变」报错；这里直接在分发处短路，连编辑请求都不发。
 */
export const QA_QUERY_PAGE_NOOP_DATA: string = "qa_page:-";

/** `/query_qa` 看板上一页按钮的文案。 */
export const QA_QUERY_PAGE_PREV_TEXT: string = "‹ 上一页";

/** `/query_qa` 看板下一页按钮的文案。 */
export const QA_QUERY_PAGE_NEXT_TEXT: string = "下一页 ›";

/** 群问答三条命令的全部用户可见文案。 */
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
  full: `本群问答已经满 ${CHAT_QA_MAX_PER_CHAT} 条了，先 /remove_qa 掉一条再来，笨蛋♡`,
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
  removeUsage: "要删哪条？写成 /remove_qa <问题文本>，笨蛋♡",
  removed: (q: string): string => `「${q}」已经从本群问答里划掉了♡`,
  removeMissing: (q: string): string => `本群根本没有「${q}」这条问答，删什么呀杂鱼♡`,
};
