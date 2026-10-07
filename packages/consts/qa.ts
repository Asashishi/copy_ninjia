/** 群问答（`/qa set`、`/qa query`、`/qa remove`）的字面量常量。 */

/**
 * 每群可登记的问答条数上限。
 *
 * 直答命中判定是一次 Map 查表，与条数无关；`/qa query` 的全量渲染和 group_qa_query
 * 交给模型的问题清单都按本值封顶。
 *
 * 派生上界随本值变化：主线程热表与 Disk I/O 未提交缓冲各自的
 * `STATE_MANAGED_CHAT_LIMIT × 本数`，以及看板页数 `ceil(本数 / QA_QUERY_PAGE_MAX_ENTRIES)`。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_MAX_PER_CHAT: number = 15;

/**
 * 单条问题文本的最大长度（UTF-16 code unit）。
 *
 * 问题文本是直答 Map 的键，本值约束键的长度。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_QUESTION_MAX_CHARS: number = 256;

/**
 * 单条答案文本的最大长度（UTF-16 code unit），按**含 ``` 围栏的落盘文本**计。
 *
 * 取值低于 TELEGRAM_MESSAGE_MAX_CHARS，已登记的答案都能原样发出；余量留给围栏被拆回
 * `pre` 实体之外的正文。代码块在落盘时以字面围栏保存（见 libs/codeFence.ts），围栏本身也计入。
 * 所属模块：packages/commands/qa/。
 */
export const CHAT_QA_ANSWER_MAX_CHARS: number = 3_840;

/**
 * `/qa set` 表单接受的问题字段标签。
 *
 * 半角与全角冒号均接受。标签只在**行首**生效，
 * 且不认代码块内部的行（见 commands/qa/rendering.ts）。
 * 所属模块：packages/commands/qa/rendering.ts。
 */
export const QA_QUESTION_LABELS: readonly string[] = ["问题:", "问题："];

/**
 * `/qa set` 表单接受的答案字段标签，含「回答」与「答案」两个词；判定口径同 QA_QUESTION_LABELS。
 */
export const QA_ANSWER_LABELS: readonly string[] = ["回答:", "回答：", "答案:", "答案："];

/**
 * `/qa set` 表单会话的存活时长：超时仍未填齐两项即作废。
 *
 * 会话只握在主线程内存里（见 packages/cache/main/qa.ts），到点由状态机结算并删除表单，不持久化。
 * 所属模块：packages/commands/qa/。
 */
export const QA_FORM_SESSION_TTL_MS: number = 15 * 60 * 1000;

/**
 * 全局同时存在的 `/qa set` 表单会话上限。
 *
 * 会话按群唯一，同一个群重开表单替换旧会话；达到上限后新的 `/qa set` 被拒绝。
 * 所属模块：packages/cache/main/qa.ts。
 */
export const QA_FORM_SESSION_MAX: number = 50;

/**
 * `/qa query` 看板上单条答案的展示上限（UTF-16 code unit，含省略号）。
 *
 * 问题**不截断**：它是 `/qa remove` 的入参。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_ANSWER_PREVIEW_MAX_CHARS: number = 256;

/**
 * 群问答回显被截断时补的省略号，看板与表单共用一份。
 *
 * 两处都把它计入各自的预算，截断结果不超出上限。
 * 所属模块：packages/commands/qa/board.ts 与 packages/commands/qa/rendering.ts。
 */
export const QA_TRUNCATION_MARK: string = "…";

/**
 * `/qa query` 看板 JSON 代码块的语言标记，决定 Telegram 用哪套高亮渲染。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_JSON_LANGUAGE: string = "json";

/**
 * `/qa query` 看板 JSON 的缩进空格数。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_JSON_INDENT: number = 2;

/**
 * `/qa query` 看板单页装的问答条数；按条数分页，不按长度预算。
 *
 * 满页上界由 CHAT_QA_QUESTION_MAX_CHARS（database/codec/chatQa.ts 在落库与解码两侧强制）、
 * 看板上被截到 QA_QUERY_ANSWER_PREVIEW_MAX_CHARS 的答案与 JSON 缩进 QA_QUERY_JSON_INDENT
 * 共同约束，在 TELEGRAM_MESSAGE_MAX_CHARS 之内；改动这几个常量中的任何一个都要重算该乘积。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_PAGE_MAX_ENTRIES: number = 3;

/**
 * `/qa query` 翻页按钮的 callback_data 前缀，后面接目标页号（从 0 起）。
 *
 * 前缀与入群验证按钮的前缀互不为前缀。
 * 所属模块：packages/commands/qa/board.ts。
 */
export const QA_QUERY_PAGE_CALLBACK_PREFIX: string = "qa_page:";

/**
 * `/qa query` 看板翻页按钮 callback_data 里页号的严格形态：非负十进制整数，
 * 不带正号、前导零、空白、小数点与指数。
 *
 * 页号从 0 起，因此与 USER_ID_ARG_PATTERN 不同，这里显式放行单独的 `0`；
 * 越界由调用方按当前页数判定。
 */
export const QA_QUERY_PAGE_ARG_PATTERN: RegExp = /^(?:0|[1-9]\d*)$/;

/**
 * 页码指示按钮的 callback_data：占位按钮，分发处直接短路，不发编辑请求。
 */
export const QA_QUERY_PAGE_NOOP_DATA: string = "qa_page:-";

/**
 * /qa 子命令结构；query 和 remove 后保留完整问题文本，set 不接受额外参数。
 * 子命令词不区分大小写；捕获组保留原样大小写，调用方取值时自己 `toLowerCase()`；
 * 问题文本那一组是用户内容，不折叠大小写。
 */
export const QA_SUBCOMMAND_PATTERN: RegExp = /^(set|remove|query)(?:\s+([\s\S]+))?$/iu;
