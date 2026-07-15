/**
 * AI 闲聊的调参常量。AI_REPLY_PROBABILITY 由主线程（src/auto/message.ts）的触发
 * 调度使用，其余都是 Worker 线程（workers/aiChatWorker.ts）流水线的旋钮。
 */

/**
 * 没有其它触发条件时，普通发言触发一次 AI 回复的概率。掷骰子决定是否触发
 * 属于主线程的调度逻辑（见 src/auto/message.ts），Worker 只执行已触发的回复。
 */
export const AI_REPLY_PROBABILITY: number = 1 / 5;

/**
 * 群友发图时，AI 在图片解析完成后主动回复那条图片消息、评价图片内容的
 * 概率。掷骰子同样在主线程（照顾 /quiet 状态与随机回复冷却，见
 * src/auto/message.ts 的图片分支）；命中后由 Worker 在描述解析成功时执行
 * （解析失败没内容可评，静默放弃），见 workers/aiChatWorker.ts 的
 * recordChatImage。
 */
export const AI_IMAGE_COMMENT_PROBABILITY: number = 1 / 15;

/** xAI 的 responses 接口（chat completions 在 xAI 已是 legacy，内置
 *  web_search 等服务端工具只在 responses 上提供）。 */
export const XAI_RESPONSES_API_URL: string = "https://api.x.ai/v1/responses";
export const XAI_MODEL: string = "grok-4.5";
export const REQUEST_TIMEOUT_MS: number = 90_000;

/**
 * 单次请求的输出 token 上限（回复流水线 / 冷消息压缩各一个）。grok-4.5 是
 * 推理模型，思考内容也计入 max_output_tokens（usage 的
 * output_tokens_details.reasoning_tokens，实测确认）：上限给小了，额度会在
 * 思考阶段就被烧光——请求返回 200 但 status=incomplete、正文为空，表现为
 * 静默失败（DeepSeek 时代压缩任务曾因 768 的旧上限反复空手而归，同一坑）。
 * max_output_tokens 只是封顶，按实际用量计费，放大上限不增加正常请求的开销。
 */
export const REPLY_MAX_TOKENS: number = 8192;
export const SUMMARY_MAX_TOKENS: number = 8192;

/** 冷消息压缩的生成温度：偏低，换取更忠实原文的摘要而非自由发挥。 */
export const SUMMARY_TEMPERATURE: number = 0.6;
/** 回复生成的生成温度：偏高，换取更贴合人设的活人感发挥。 */
export const REPLY_TEMPERATURE: number = 1.2;

/**
 * 压缩块大小 = 热窗口大小 = 镜像窗口大小。逐字缓存由两个块组成：「热」是
 * 正在累积的最新一块，「镜像」是上一轮攒满时已提交 AI 压缩的那一块——
 * 镜像在自己的摘要生成期间仍整块留在逐字上下文里，等下一块攒满轮换时才
 * 滑出、由（多半早已就绪的）摘要接棒。因此正常情况下不存在「已滑出逐字
 * 区但摘要未就绪」的失忆窗口；例外只有两种：50 条消息的洪峰比一次压缩
 * 调用还快，或压缩失败（刻意不回灌，该段记忆缺失，见
 * workers/aiChatWorker.ts 的 rotateCompaction）。
 * （Bot API 无法拉历史，缓存只能边收边攒。）
 */
export const COMPACT_BATCH_SIZE: number = 50;
/** 逐字上下文的上限：镜像 50 + 热 50。实际在 50 ~ 100 条之间浮动。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/**
 * 每群最多保留几轮压缩摘要，新一轮晋升时超出就滑动移除最旧一轮。
 * 7 轮 × 每轮 50 条 = 相当于 350 条冷历史的中期记忆；加上逐字区的
 * 50 ~ 100 条，模型可感知的对话跨度约 400 ~ 450 条。
 */
export const MAX_SUMMARY_ROUNDS: number = 7;

/**
 * 各群 dirty 的 AI 记忆快照（滚动缓存 + 中期摘要）上报给主线程（进而落盘）
 * 的节奏，见 workers/aiChatWorker.ts 的 flushDirtyMemories。硬崩（kill -9/
 * OOM）时这段间隔即记忆丢失的上界。
 */
export const AI_SNAPSHOT_INTERVAL_MS: number = 30_000;

/**
 * hydrate（进程重启/本 Worker 崩溃重建后灌回持久化记忆）时，buffer 最多
 * 恢复这么多条（VERBATIM_CONTEXT_MAX - 1）。recordChatMessage 靠严格等值
 * `size === VERBATIM_CONTEXT_MAX` 触发轮换：若恰好灌回整 100 条，下一次
 * push 后 size 变 101，会永远错过这个判等，缓存无界增长。diskIOWorker 落盘前
 * 的结构性重建（workers/diskIO/snapshotFiles.ts）复用同一上限做同样的截断，
 * 两处双保险。
 */
export const AI_MEMORY_HYDRATE_BUFFER_MAX: number = VERBATIM_CONTEXT_MAX - 1;
/** 单条摘要的硬性长度上限（字符），防摘要模型话痨撑爆回复上下文。 */
export const SUMMARY_MAX_CHARS: number = 500;
/** 触发回复后，采用「连发多条短消息」形式（而非单条）的概率。 */
export const SPLIT_REPLY_PROBABILITY: number = 1 / 4;
/** 连发模式下最多发几条，防止模型话痨刷屏。 */
export const SPLIT_REPLY_MAX_PARTS: number = 5;
/**
 * 连发模式下模拟真人打字间隔（见 workers/aiChatWorker.ts 的 typingDelayMs）：
 * 基础停顿 + 按下一条消息长度线性增加 + 随机抖动，再统一封顶。
 */
export const TYPING_DELAY_BASE_MS: number = 600;
export const TYPING_DELAY_PER_CHAR_MS: number = 55;
export const TYPING_DELAY_JITTER_MS: number = 400;
export const TYPING_DELAY_MAX_MS: number = 3_500;
/**
 * 同一群聊两次 AI 回复之间的最短间隔。回复机器人 / @ 机器人是 100% 触发且
 * 无上限的，没有这道闸的话，恶意用户循环回复 bot 就能形成「一条消息 = 一次
 * API 调用 + 一条群消息」的刷屏/烧钱放大链。冷却内命中的触发直接静默丢弃。
 */
export const AI_REPLY_COOLDOWN_MS: number = 500;

/**
 * 分群限频：单个群滚动窗口内最多触发多少次 AI 回复。每群冷却只限制相邻
 * 两次的间隔（0.5 秒冷却下一分钟仍可达 120 次），这两道滑动窗口给单群的
 * 总量再兜两层——1 分钟窗口挡住短时爆发，5 分钟窗口再挡住那种卡着 1 分钟
 * 窗口边界反复刷、绕开短窗口上限的持续刷屏。两道闸中任意一道打满，触发
 * 就直接丢弃（黑洞，只回一句带独立冷却的「你们太快了」提示，见下方
 * RATE_LIMIT_NOTICE_COOLDOWN_MS），等对应窗口里旧时刻滑出窗口腾出名额才
 * 恢复，不是硬性定时重置。只在入口计一次数——一次触发内的「连发多条
 * 短消息」属于同一次回复，不重复计数。
 */
export const RATE_LIMIT_WINDOW_MS: number = 60_000;
export const RATE_LIMIT_MAX_TRIGGERS: number = 45;
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;

/**
 * 触发被限频黑洞丢弃时会明确回一句「你们太快了」（见 workers/aiChatWorker.ts 的
 * notifyRateLimited），这是该提示自身的冷却：同一个群在这段时间内至多提示
 * 一次，防止提示本身在刷屏场景下变成新的刷屏放大器。
 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;

/**
 * 判断一条消息是否在问时间/日期。命中时会把真实当前时间直接注入 prompt
 * （见 workers/aiChatWorker.ts 的 UserContentOptions.timeContext），而不是交给模型
 * 自己判断要不要查——auto 模式下模型经常瞎编时间而不调用工具，命中率太低。
 */
export const TIME_INTENT_PATTERN: RegExp =
  /现在几点|几点了|几点钟|现在.{0,4}时间|当前时间|今天.{0,3}[几号日]|几月几[号日]|星期几|周几|报时|what\s*time|current\s*time/i;

/**
 * 一次工具调用往返最多允许几轮（模型要工具结果 -> 喂回去 -> 模型可能再要
 * 下一个工具……）。给个上限防止模型陷入死循环反复要工具，烧穿 API 配额。
 */
export const MAX_TOOL_ROUNDS: number = 5;

/** 「正在输入…」状态的重发间隔，机制见 workers/aiChatWorker.ts 的 startTypingHeartbeat。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;

// ---- 图片读图（群里有人发图 -> 占位入缓存 -> 异步解析替换占位）----
// 流程见 workers/aiChatWorker.ts 的 recordChatImage 与 ai/imageDescription.ts。

/** 图片刚入缓存、描述还没解析出来时的占位文本；解析失败则回填为失败说明，
 *  明确告诉模型这行没有可用的图片内容、别把它当话题接。 */
export const IMAGE_PENDING_PLACEHOLDER: string = "[图片：识别中]";
export const IMAGE_FALLBACK_PLACEHOLDER: string = "[图片：解析失败，请无视此消息]";

/** 喂给视觉模型的描述指令：产出一行简短中文描述，供转录上下文引用。 */
export const IMAGE_DESCRIPTION_PROMPT: string =
  "这是中文群聊里有人发的一张图片。请用中文简要描述它：是什么内容、图里有什么文字、想表达什么；" +
  "若是表情包/梗图/截图，请点出其中的文字要点和情绪。不超过 120 字，只输出描述本身，不要任何前缀、解释或引号。";

/** 图片描述的输出 token 上限：描述本身很短，但推理模型的思考也计入（同
 *  REPLY_MAX_TOKENS 注释），要给足余量。 */
export const IMAGE_DESCRIPTION_MAX_TOKENS: number = 4096;
/** 图片描述入缓存前的硬性长度上限（字符），防模型话痨撑爆转录行。 */
export const IMAGE_DESCRIPTION_MAX_CHARS: number = 200;
/** 从 Telegram 下载图片文件的超时。 */
export const IMAGE_DOWNLOAD_TIMEOUT_MS: number = 20_000;
/** 图片描述缓存（按 file_unique_id 去重，见 ai/imageDescription.ts）的条目
 *  上限，超出按插入顺序淘汰最旧的。同一张梗图被反复刷屏时不再重复下载/
 *  解析，转录里也不会出现同图多份措辞各异的描述。 */
export const IMAGE_DESCRIPTION_CACHE_MAX: number = 500;
/** 图片下载大小上限：挑尺寸时跳过超过它的档位（xAI 收 base64 后限 20MiB，
 *  Telegram photo 压缩后远小于此，这只是防御性护栏）。 */
export const IMAGE_MAX_DOWNLOAD_BYTES: number = 8 * 1024 * 1024;
