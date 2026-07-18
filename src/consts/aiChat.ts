import type { MoodOption } from "../types";

/**
 * AI 闲聊的调参常量。AI_REPLY_PROBABILITY 由主线程（src/auto/message.ts）的触发
 * 调度使用，其余都是 Worker 线程（workers/aiChatWorker.ts）流水线的旋钮。
 */

/**
 * AI 主动搭话的统一概率：没有其它触发条件时，普通发言触发一次随机回复；
 * 群友发图片/贴纸/GIF 时，触发「解析完成后回复那条消息、评价媒体内容」
 * ——文字消息与三种媒体共用这同一个概率（不是各自独立掷骰，曾经文字
 * 1/5、媒体 1/8 两套，现已合并）。掷骰子决定是否触发属于主线程的调度
 * 逻辑（照顾 /quiet 状态与随机回复冷却，见 src/auto/message.ts），Worker
 * 只执行已触发的回复；媒体评价由 Worker 在描述解析成功时执行（解析失败
 * 没内容可评，静默放弃），见 workers/aiChatWorker.ts 的 recordChatMedia。
 */
export const AI_REPLY_PROBABILITY: number = 1 / 7;

/** 闲聊回复生成（callGemini）用的模型——人设发挥、工具调用都在这条链路上。
 *  三条链路统一用 gemini-3.1-flash-lite（内置 googleSearch 与自定义函数
 *  可以混用同一次请求、支持视觉输入与多轮函数调用往返，收发见 ai/gemini.ts）。 */
export const GEMINI_REPLY_MODEL: string = "gemini-3.1-flash-lite";
/** 冷消息压缩（summarizeBatch）用的模型——中性总结任务。 */
export const GEMINI_SUMMARY_MODEL: string = "gemini-3.1-flash-lite";
/** 媒体（图片/贴纸/GIF）描述（describeMediaUncached）用的视觉模型。 */
export const GEMINI_MEDIA_MODEL: string = "gemini-3.1-flash-lite";
/** 单次请求的超时（@google/genai SDK 的 httpOptions.timeout，per-attempt；
 *  SDK 默认对瞬时失败（网络错误/5xx/429）自动重试几次，每次重试各自套用
 *  这个超时预算，不是所有重试共享一个 90 秒硬顶——这是比手写 fetch 更强
 *  的地方，瞬时的 5xx/连接错误能自愈）。 */
export const REQUEST_TIMEOUT_MS: number = 150_000;

/** getStickerSet 失败后的短期负缓存：避免 Telegram 故障期间每轮 AI 回复都
 * 重打同一包，同时让瞬时错误在本进程内自动恢复，不必等到重启。 */
export const STICKER_SET_FAILURE_RETRY_MS: number = 60_000;

/**
 * 单次请求的输出 token 上限（回复流水线 / 冷消息压缩各一个）。Gemini 的
 * 思考内容也计入 maxOutputTokens（usageMetadata 的 thoughtsTokenCount）：
 * 上限给小了，额度会在思考阶段就被烧光——请求返回 200 但 finishReason=
 * MAX_TOKENS、正文为空，表现为静默失败（DeepSeek 时代压缩任务曾因 768 的
 * 旧上限反复空手而归，同一坑）。
 * maxOutputTokens 只是封顶，按实际用量计费，放大上限不增加正常请求的开销。
 *
 * REPLY_MAX_TOKENS 给得比 SUMMARY_MAX_TOKENS 更宽松：回复流水线挂了
 * googleSearch，命中搜索的那些请求要在思考预算里多担一层「决定要不要
 * 搜、消化搜索结果、整理正文」的开销，比纯聊天更容易顶到旧上限，
 * 表现为回复写到一半戛然而止（见 ai/gemini.ts 的 isTruncatedByTokenLimit，
 * 命中时 callGemini 直接放弃这轮，不把断句发出去——但预算给够从源头上更该
 * 优先，被动放弃只是兜底）。
 */
export const REPLY_MAX_TOKENS: number = 49_152;
export const SUMMARY_MAX_TOKENS: number = 8192;

/** 冷消息压缩的生成温度：偏低，换取更忠实原文的摘要而非自由发挥。 */
export const SUMMARY_TEMPERATURE: number = 0.6;

/**
 * 镜像压缩失败后的重试退避序列（毫秒）：首次失败等 15 秒再试，再失败等
 * 60 秒试最后一次，全败才放弃。实测这类失败多为瞬时（网络抖动/临时超载，
 * 重启后同一批就能压成功），SDK 内建重试只兜请求内的快速瞬断，跨请求的
 * 短暂故障靠这里兜。放弃后该段中期记忆缺失（见 workers/aiChatWorker.ts
 * 的 rotateCompaction）。重试期间本群轮换链顺延，积压由
 * COMPACTION_MAX_PENDING_PER_CHAT 兜底，洪峰下超额批次照旧丢弃。
 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];
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
 * 冷记忆跨度 = MAX_SUMMARY_ROUNDS × COMPACT_BATCH_SIZE；再加上最多两个
 * COMPACT_BATCH_SIZE 逐字块，构成模型可感知的完整对话跨度。
 */
export const MAX_SUMMARY_ROUNDS: number = 5;

/**
 * 回复上下文最前面的记忆优先级声明。具体的冷摘要/较早逐字记录/最热逐字
 * 记录分块由 ai/chatTranscript.ts 动态拼装；这里仅保存不随消息变化的规则。
 */
export const CHAT_MEMORY_PRIORITY_INSTRUCTION: string =
  "以下是按重要程度分层的本群聊天记忆。热记忆是判断当前情况的重要标准；冷记忆也必须纳入理解，用来把握长期话题、人物关系和前因后果，只是判断当前状态时权重较低。" +
  "请按标注的优先级正确识别情况，不要编造、不要张冠李戴。";

/**
 * 单群允许同时处于「执行中 + 排队中」的冷消息压缩任务数。群消息可能远快于
 * 一次 Gemini 请求；不设上限时，每满 50 条就保留一整批消息和一个 Promise
 * 闭包，API 变慢/故障期间会无限增长。超出的批次放弃压缩（逐字滚动缓存仍
 * 有硬上限），以有界降级换取进程存活。
 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 4;

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

/**
 * 冷消息压缩用的中性总结系统提示词（不带人设、不带工具），见
 * workers/aiChatWorker.ts 的 summarizeBatch。字数上限直接引用
 * SUMMARY_MAX_CHARS，避免文案里的数字和 truncateInline 真正生效的截断值
 * 各改各的漂移。
 */
export const SUMMARY_SYSTEM_PROMPT: string =
  "你是一个群聊记录压缩器。用户会给你一段群聊转录，每行格式为「[年/月/日 时:分:秒] [id:用户ID] [username:@公开用户名] 名字：内容」，其中 username 标记仅在发言人有公开用户名时出现。行首方括号里是那条消息的发送时间（东京时间），同名的人以 id 区分；正文里出现的 @用户名要用 username 标记映射回具体的人。" +
  "请把这段记录压缩成一段简洁的摘要，只挑最要紧的信息，保留：这段对话大致发生的时间（如「7月16日晚」）、聊过的话题及走向、谁说过的关键信息（人名后带 [id:xxx] 标注以免混淆；有 username 的关键人物再保留 [username:@xxx]，供后续识别 @ 提及）、达成的约定、出现的梗和称呼、人物关系或情绪的变化。" +
  `摘要正文不得超过 ${SUMMARY_MAX_CHARS} 字，不要展开细节、不要逐条复述。只输出摘要正文本身，不要任何前缀、解释、列表符号或代码块，不要输出思考过程。`;

/**
 * callGemini 系统提示词里，紧跟在现查的「当前实际时间」句子之后的静态指令
 * （时间句本身不能预先算好存成字面量：Worker 线程常驻，缓存的时间会很快
 * 过期，须现查，见 workers/aiChatWorker.ts 的 currentTimeSentence）。
 */
export const TIME_AWARENESS_INSTRUCTION: string =
  "聊天记录每行行首方括号里是那条消息的发送时间，回答时间/日期相关的问题、或判断某句话是多久之前说的，都以这些真实时间为准，不要编造。";

/**
 * 鼓励模型主动用内置 googleSearch 工具核实信息，而不是瞎编或一味嘴硬拒答，
 * 见 workers/aiChatWorker.ts 的 callGemini（tools 数组里的 { googleSearch: {} }）。
 * 搜索由 Google 服务器侧自动执行，结果直接体现在最终文本里，不需要额外处理。
 * persona.md「绝对不编造事实」一节配套调整过：真查不到/查了没意义才傲慢
 * 回绝，能查的先查证。
 */
export const WEB_SEARCH_INSTRUCTION: string =
  "你内置了实时联网搜索能力：遇到时效性强（新闻、价格、比分、榜单、版本号、事件进展等）、你没有把握、或对方明确要求查证的问题，主动搜索确认清楚了再回答，别懒得查就瞎编或者甩锅拒答。搜完该怎么损怎么损、该怎么骄傲怎么骄傲，别在回复里暴露自己刚查过——装作本来就知道。";
/** 一轮回复的动作总数硬顶：发消息、撤回、发贴纸、扣反应全都算在内（提示词里
 *  引导「通常 1~3 个动作，可以 3-5 个动作」，这是极端情况也不许突破的上限），
 *  超额的调用在执行侧直接拒绝，见 ai/tools/replyToolset.ts。 */
export const MAX_ACTIONS_PER_REPLY: number = 8;
/** 一轮回复里 send_sticker 工具最多发几枚贴纸：要么不发、要么只发一枚，
 *  超额的调用在执行侧直接拒绝，见 ai/tools/stickers.ts 的 sendStickerTool。 */
export const MAX_STICKERS_PER_REPLY: number = 1;
/** 一轮回复里 add_reaction 工具最多扣几个 emoji 反应。 */
export const MAX_REACTIONS_PER_REPLY: number = 1;
/**
 * view_sticker_pack 执行时把聊天状态心跳切到「正在选择贴纸」挡
 * （choose_sticker，与「正在输入」同一个机制）后的停顿：基础 + 随机抖动，
 * 合计 1.5~5 秒，模拟真人翻贴纸面板挑贴纸的节奏，见 ai/tools/stickers.ts。
 * 群友实际看到的选择时长还要更长：这一挡保持到贴纸真正发出为止，模型
 * 挑选贴纸那轮往返的耗时也计入其中。
 */
export const STICKER_CHOOSE_DELAY_BASE_MS: number = 1_500;
export const STICKER_CHOOSE_DELAY_JITTER_MS: number = 3_500;
/**
 * 每条消息临发前「正在输入…」状态窗口的时长（见 ai/tools/replyToolset.ts 的
 * typingDelayMs）：基础停顿 + 按本条消息长度线性增加 + 随机抖动，再统一
 * 封顶，合计约束在 1.5~7.5 秒（约 110 字起顶到上限）。生成/思考期间不亮
 * 状态，输入状态只在这段有界窗口里显示、并一定以本条消息落地收尾。窗口
 * 允许长于 Telegram 约 5 秒的状态过期时间：切挡时即时补发第一发，之后由
 * 心跳按 TYPING_ACTION_INTERVAL_MS（4 秒，小于过期时间）的间隔重发接力，
 * 整段窗口显示连续（见 ai/chatActionHeartbeat.ts）。
 */
export const TYPING_DELAY_BASE_MS: number = 1_500;
export const TYPING_DELAY_PER_CHAR_MS: number = 55;
export const TYPING_DELAY_JITTER_MS: number = 400;
export const TYPING_DELAY_MAX_MS: number = 7_500;
/**
 * 分群限频：单个群 5 分钟滚动窗口内最多触发多少次 AI 回复。回复/@ 机器人
 * 是 100% 触发，这道闸兜住「循环回复 bot」形成的「一条消息 = 一次 API
 * 调用 + 一条群消息」刷屏/烧钱放大链的总量。短时爆发不单设闸：同群在途
 * 轮数有并发上限（activeReplyCounts 同步计数，见下方
 * REPLY_ROUND_MAX_CONCURRENT，打满期间随机触发丢弃、直接触发排队等补跑，
 * 见 REPLY_TRIGGER_QUEUE_MAX），节奏天然被并发闸
 * 压着。窗口打满即丢弃（黑洞，只回一句带独立冷却的「你们太快了」提示，见下方
 * RATE_LIMIT_NOTICE_COOLDOWN_MS），等窗口里旧时刻滑出腾出名额才恢复，
 * 不是硬性定时重置。只在触发真正启动一轮时计一次数——排队等待不占配额，
 * 一次触发内的「连发多条短消息」属于同一次回复，也不重复计数。
 */
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;

/**
 * 同群在途回复轮数的并发上限。一轮工具对话 = 一次可持续几十秒的 Gemini
 * 请求 + 若干工具副作用；并发跑意味着后发的轮可能先结束、几轮的发言互相
 * 穿插——为了热闹群里不让真人干等，这点乱序是有意接受的权衡。打满期间
 * 随机插话/媒体评价丢弃、直接触发排队（见下方 REPLY_TRIGGER_QUEUE_MAX）。
 */
export const REPLY_ROUND_MAX_CONCURRENT: number = 5;
/**
 * 同群并发闸的等候队列上限。在途轮数打满期间到来的直接触发（回复/@
 * 机器人——真人在等回复的交互）不丢弃，入队等空位腾出后按先来后到
 * 逐个补跑；打满后的新触发才丢弃，并给「你们太快了」提示（自带冷却，
 * 见 RATE_LIMIT_NOTICE_COOLDOWN_MS）。随机插话/媒体评价仍是打满即丢：
 * 没人在等那条回复，错过时机再补反而突兀。
 */
export const REPLY_TRIGGER_QUEUE_MAX: number = 15;
/** 排队触发快照（QueuedReplyTrigger.text）的截断上限：补跑的回复指令里
 *  要原文引用触发消息，防超长消息把提示词撑爆。 */
export const QUEUED_TRIGGER_SNIPPET_MAX_CHARS: number = 200;

/**
 * 触发被限频黑洞丢弃时会明确回一句「你们太快了」（见 workers/aiChatWorker.ts 的
 * notifyRateLimited），这是该提示自身的冷却：同一个群在这段时间内至多提示
 * 一次，防止提示本身在刷屏场景下变成新的刷屏放大器。
 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;
/** 限频黑洞的固定提示文案，见 workers/aiChatWorker.ts 的 notifyRateLimited。 */
export const RATE_LIMIT_NOTICE_TEXT: string = "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡";

/**
 * 一次工具调用往返最多允许几轮（模型要工具结果 -> 喂回去 -> 模型可能再要
 * 下一个工具……）。给个上限防止模型陷入死循环反复要工具，烧穿 API 配额。
 * 发言/贴纸/反应/撤回全部工具化之后，一轮正常回复就要吃掉好几轮往返（看包 ->
 * 发贴纸 -> 连发几条消息 -> 偶尔撤回改口……），上限按此放宽；同一轮响应里的并行调用只算一轮。
 */
export const MAX_TOOL_ROUNDS: number = 25;

/** 聊天状态（正在输入…/正在选择贴纸…）的心跳重发间隔，须小于 Telegram
 *  约 5 秒的状态过期时间；同时兼作切挡补发的重复状态节流窗口——同一挡位
 *  在这段时间内刚成功发过就不再补发，机制见 ai/chatActionHeartbeat.ts 的
 *  pumpChatAction。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;

/** 聊天状态请求连续失败多少次后才停止本轮心跳。单次失败可能只是瞬时网络
 *  波动，立即永久停表会让整轮后续的「正在输入/选择贴纸…」无故中断；连续
 *  失败达到阈值时再止损，避免对不可达聊天无限重试。 */
export const CHAT_ACTION_MAX_CONSECUTIVE_FAILURES: number = 3;

// ---- 媒体读图（群里有人发图片/贴纸/GIF -> 占位入缓存 -> 异步解析替换占位）----
// 流程见 workers/aiChatWorker.ts 的 recordChatMedia 与 ai/imageDescription.ts 的
// describeMedia；三种媒体共用下载机制，只有未命中 memory/stickers/ 常驻
// 目录的媒体才共用临时缓存，各自的占位符、prompt、描述长度上限分开定义。
// 贴纸/GIF 的素材来源不总是 jpg/png（webp 贴纸本体、GIF 的 mp4 走缩略图），
// 统一先经 libs/image.ts 嗅探格式并按需转码。

/** 图片刚入缓存、描述还没解析出来时的占位文本；解析失败则回填为失败说明，
 *  明确告诉模型这行没有可用的图片内容、别把它当话题接。 */
export const IMAGE_PENDING_PLACEHOLDER: string = "[图片：识别中]";
export const IMAGE_FALLBACK_PLACEHOLDER: string = "[图片：解析失败，请无视此消息]";
/** 贴纸的占位文本；解析失败时不用通用失败说明，而是退回原有的元数据行
 *  （情绪 emoji + 所属贴纸包，见 ai/stickerSets.ts 的 describeStickerForContext）
 *  ——即便视觉解析失败也不损失现状已有的信息，见 workers/aiChatWorker.ts 的
 *  recordChatMedia。 */
export const STICKER_PENDING_PLACEHOLDER: string = "[贴纸：识别中]";
/** GIF 的占位/失败文本，与图片同款措辞。 */
export const ANIMATION_PENDING_PLACEHOLDER: string = "[GIF：识别中]";
export const ANIMATION_FALLBACK_PLACEHOLDER: string = "[GIF：解析失败，请无视此消息]";

/** 图片描述的字数上限：prompt 文案与入缓存前的硬性截断共用同一个常量
 *  （同下方贴纸/GIF 的 SHORT_MEDIA_DESCRIPTION_MAX_CHARS 一个道理），避免
 *  文案里的数字和 truncateInline 真正生效的截断值各改各的漂移——曾经这里
 *  各写各的（文案 120、截断 200），模型没能精确遵循字数指令时实际入库描述
 *  可以接近文档承诺上限的两倍。 */
export const IMAGE_DESCRIPTION_MAX_CHARS: number = 120;

/** 三份媒体描述 prompt 共用的收尾（字数上限 + 只输出描述本身的格式要求），
 *  免得同一段要求在图片/贴纸/GIF 三处各抄一遍、措辞各改各的漂移。措辞统一
 *  用「不要用引号把整段描述包起来」而非「不要引号」——贴纸描述里本来就
 *  要求把抄录的画面文字放进「」，笼统禁引号会跟它打架。 */
function descriptionOutputRule(maxChars: number): string {
  return `不超过 ${maxChars} 字，只输出描述本身，不要任何前缀或解释，也不要用引号把整段描述包起来。`;
}

/** 喂给视觉模型的描述指令：产出一行简短中文描述，供转录上下文引用。 */
export const IMAGE_DESCRIPTION_PROMPT: string =
  "这是中文群聊里有人发的一张图片。请用中文简要描述它：是什么内容、图里有什么文字、想表达什么；" +
  `若是表情包/梗图/截图，请点出梗点和情绪。${descriptionOutputRule(IMAGE_DESCRIPTION_MAX_CHARS)}`;

/**
 * 贴纸/GIF 描述的字数上限——比图片短：贴纸/GIF 本身信息密度低（一个画面
 * 梗+一句文字居多）。这份描述的另一个消费方是贴纸目录（ai/stickerCatalog.ts），
 * 两层贴纸工具下目录条目只在 view_sticker_pack 的返回结果里按需出现、不再
 * 拼进每次请求的工具描述（旧单层方案的 75 字紧箍随之作废），100 字给
 * 「原样抄录画面文字 + 简述画面情绪」留够空间。
 */
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 100;
/** 喂给视觉模型描述一枚贴纸的指令：群友发的贴纸、机器人自己贴纸目录的
 *  生成（见 ai/stickerCatalog.ts）共用同一份措辞，保证两处描述风格一致。
 *  画面文字要求一字不差原样抄录、放在最前——文字梗贴纸（如 ur_dumb 整包）
 *  的含义全在文字上，转述/意译一个词含义就漂了。 */
export const STICKER_DESCRIPTION_PROMPT: string =
  "这是中文群聊场景用到的一枚贴纸（表情包）。请用中文描述它，最优先的任务是把画面里出现的文字" +
  "一字不差地原样抄录出来、放进「」里（中英文、品牌名、代码符号都照抄，不要改写、意译或省略——" +
  "文字是这类贴纸的灵魂，抄错一个字含义就变了；画面没有文字才可以不提）。" +
  "例外：若画面里是大段代码或长文，只原样抄录其中承载梗点的关键短句——优先抄中文的吐槽/标语/结论，" +
  "代码和英文报错本身不要抄，用一句话概括是什么（如「一段 Rust 借用检查报错的代码」）即可，" +
  "别让抄录挤掉画面描述。" +
  "抄录之后，再简述角色/形象是谁或什么、动作表情、整体想表达的情绪或语气。不要特意的描述为什么动漫什么游戏的人物, 正常描述特征即可" +
  descriptionOutputRule(SHORT_MEDIA_DESCRIPTION_MAX_CHARS);
/** 喂给视觉模型描述一个 GIF 封面帧的指令：没有抽帧能力（无 ffmpeg），只能
 *  分析 Telegram 自带的缩略图，提示词点明这一点，避免模型把只看到第一帧
 *  的内容说成是整个动图。 */
export const ANIMATION_DESCRIPTION_PROMPT: string =
  "这是中文群聊里发的一个动图（GIF）的封面帧画面（不是完整动图，只是第一帧）。请用中文简要描述这一帧看到的内容、" +
  `画面里的文字（如有）、大致想表达的情绪或梗。${descriptionOutputRule(SHORT_MEDIA_DESCRIPTION_MAX_CHARS)}`;

/** 媒体描述的输出 token 上限：描述本身很短，但推理模型的思考也计入（同
 *  REPLY_MAX_TOKENS 注释），要给足余量。图片/贴纸/GIF 共用。 */
export const MEDIA_DESCRIPTION_MAX_TOKENS: number = 8192;
/** 从 Telegram 下载媒体文件（图片本体、贴纸本体/缩略图、GIF 缩略图）的超时。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 25_000;
/** 未命中 memory/stickers/ 常驻目录的媒体描述临时缓存（按 file_unique_id
 *  去重，见 ai/imageDescription.ts）条目上限，超出淘汰最久未使用的一个
 * （LRU，见 libs/lruCache.ts）。同一张梗图/非白名单贴纸/GIF 被反复刷屏时
 * 不再重复下载/解析，转录里也不会出现同一份媒体多份措辞各异的描述。三类
 * 临时结果共用一个缓存（键空间不冲突：file_unique_id 本就是 Telegram
 * 全局唯一）。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 1500;
/** 媒体下载、转码、视觉 API 请求的全局并发上限。群聊媒体与白名单贴纸目录
 * 共用同一执行器，避免刷入不同 file_unique_id 绕过去重缓存后同时持有大量
 * 图片/Base64 副本并打爆 API。 */
export const MEDIA_DESCRIPTION_MAX_CONCURRENCY: number = 25;
/** 并发槽位占满后最多等待的媒体任务数；再多的请求立即降级为解析失败。
 * 排队项只持有 file id 等小字段，真正的下载和转码要拿到槽位后才开始。 */
export const MEDIA_DESCRIPTION_MAX_PENDING: number = 75;
/** 媒体下载大小上限：挑尺寸/素材来源时跳过超过它的档位（Gemini 对 inline
 *  图片的整个请求体限 20MB，Telegram 压缩后的 photo/贴纸/缩略图远小于此，
 *  这只是防御性护栏）。 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 8 * 1024 * 1024;

// ---- 应景贴纸（两层工具：view_sticker_pack 先按整包简介挑包、看包内清单，
// send_sticker 再按清单编号发送；模型在生成回复的同一次对话里自主决定）----
// 目录/整包简介的生成与持久化见 ai/stickerCatalog.ts；工具定义/执行见
// ai/tools/stickers.ts；按次回复的组装与限额状态见 ai/tools/replyToolset.ts。

/** 贴纸目录单次 AI 调用（逐枚视觉解析、整包简介）失败后的退避重试间隔：
 *  第 N 次失败等第 N 项后再试，用完仍失败才放弃（解析失败的贴纸进
 *  failedEntries 本进程内不再试、简介失败保留旧值，都等下次启动对账重建）。
 *  底下 SDK 对网络错误/5xx/429 已有单次调用内的快速重试（见 ai/gemini.ts），
 *  这里兜的是它放弃之后更长的抖动。 */
export const STICKER_CATALOG_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 120_000];

/** 整包简介的字数上限：一层工具描述里每个包一条，供模型决定进哪个包细看。 */
export const STICKER_PACK_SUMMARY_MAX_CHARS: number = 200;
/** 整包简介生成的输出 token 上限（思考也计入，同 REPLY_MAX_TOKENS 注释）。 */
export const STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4096;
/** 喂给模型生成整包简介的指令：输入是包内每枚贴纸的画面描述（行首带贴纸
 *  自带的情绪 emoji，如有），见 ai/stickerCatalog.ts 的 summarizePack。
 *  简介是两层贴纸工具第一层「挑包」的唯一依据，措辞要求写成精准导览而非
 *  泛泛概括：点名角色、引用核心梗/固定句式、枚举式列全情绪场景，明令禁止
 *  「适合日常聊天」这类对挑包毫无区分度的空话。 */
export const STICKER_PACK_SUMMARY_PROMPT: string =
  "以下是一个 Telegram 贴纸包里每枚贴纸的画面描述（每行一条，行首可能带这枚贴纸自带的情绪 emoji）。" +
  "请用中文为这一整个贴纸包写一段精准的导览简介，读者是要「按情绪/梗挑贴纸」的人，看完简介就能判断该不该进这个包找。必须具体写清：" +
  "主要角色/形象（叫得出名字就点名）；整体画风；包的核心梗或反复出现的文字句式（有固定模板就原样引用）；" +
  "涵盖哪些情绪和场景——用「嘲讽、得意、撒娇、无语……」这样的枚举尽量列全，不要泛泛说「多种情绪」。" +
  "不写空话套话（比如「适合日常聊天使用」这种没有区分度的话一律不要）。" +
  `必须写成一段连贯的话，严禁分点、换行或任何 Markdown 记号（*、**、#、- 等）。不超过 ${STICKER_PACK_SUMMARY_MAX_CHARS} 字——超字会被截断，请把角色、核心梗和情绪清单放在前半段说完。只输出简介本身，不要任何前缀或解释。`;
/** 目录里还没生成出整包简介时，一层清单里的占位文案。 */
export const STICKER_PACK_SUMMARY_PENDING: string = "（整包简介还在生成中，可进包内查看具体贴纸）";
/** 查看贴纸包时声明的表达意图字数上限：只保留一条简短决策标准，避免模型
 *  把大段推理塞进工具参数和后续工具结果。 */
export const STICKER_INTENT_MAX_CHARS: number = 80;
/** view_sticker_pack 返回包内清单时附带的选择约束：与模型刚声明的 intent
 * 一起进入下一轮工具上下文，防止浏览具体贴纸后为了有趣而偏离原目标。 */
export const STICKER_INTENT_SELECTION_INSTRUCTION: string =
  "严格按 intent 选择最合适的贴纸；没有符合意图的贴纸就不要发送。";

/**
 * view_sticker_pack 工具描述的固定前缀，后面动态拼接当次可选贴纸包的编号
 * 清单（每包一行「编号. 「包名」（N 枚）：整包简介」），见 ai/tools/stickers.ts
 * 的 buildViewStickerPackToolDefinition。
 */
export const VIEW_STICKER_PACK_TOOL_INSTRUCTION: string =
  "发贴纸的第一步：查看某个贴纸包内每枚贴纸的具体描述清单。发贴纸是你说话方式的一部分，" +
  "情绪、语气对上了就该顺手配一枚。调用前先明确这枚贴纸要产生的回复效果，以及需要避免传达的语气；" +
  "没有明确意图时不要为了发贴纸而查看贴纸包。再按下面的整包简介挑一个最可能有应景贴纸的包，调用本工具" +
  "拿到包内清单后始终按声明的意图选择，没有合适的就不发。pack_index 填包的编号：\n";

/**
 * send_sticker 工具的描述（两层选择的第二层）。必须先用 view_sticker_pack
 * 看过对应包的清单才能发（执行侧强制，见 ai/tools/stickers.ts 的
 * sendStickerTool）；每轮回复的枚数上限也在执行侧强制。
 */
export const SEND_STICKER_TOOL_INSTRUCTION: string =
  "从某个贴纸包里发送一枚贴纸到群里。必须先用 view_sticker_pack 查看过那个包的贴纸清单，" +
  `再按清单里的编号发送。每轮回复最多发 ${MAX_STICKERS_PER_REPLY} 枚——选最应景的那枚，` +
  "没有合适的就不发。";

/**
 * send_message 工具的描述：发言本身也是工具，模型自己决定发一条还是像真人
 * 打字那样连发几条短句（连发的打字间隔由执行侧模拟），也自己决定要不要以
 * 「回复」形式挂在触发消息上（reply_to_trigger 参数），见
 * ai/tools/replyToolset.ts。
 */
export const SEND_MESSAGE_TOOL_INSTRUCTION: string =
  "把一条文字消息发到群里。这是你说话的唯一方式——要说的每句话都必须经本工具发送，" +
  "工具之外直接输出的正文不会被任何人看到。想连发几条短句就多调用几次（像真人打字那样" +
  "一句接一句）。text 就是发到群里的原话：不要任何解释、编号、引号、代码块或「[id:...]」" +
  "这类标记；不允许发纯 emoji 表情的消息——想用画面/表情达意就发贴纸（send_sticker），" +
  "想对触发消息表个态就扣反应（add_reaction）。reply_to_trigger 填 true 时这条消息会以" +
  "「回复」形式挂在触发你这次回复的那条消息上，挂不挂由你判断（对方明确在跟你说话、或" +
  "群里消息多怕别人看不出你在回谁时，建议挂上）。工具成功时会返回 message_id，之后若你发现" +
  "这条消息确实发错或多发了，只能用 delete_own_message 撤回这个 message_id。text 永远写正确完整内容。";

/**
 * delete_own_message 工具描述：这是给模型主动修正自己本轮发错/多发消息用的
 * 安全撤回口，只接受本轮 send_message 返回过的 message_id，执行侧不允许
 * 碰别人消息或历史消息。
 */
export const DELETE_OWN_MESSAGE_TOOL_INSTRUCTION: string =
  "撤回你自己在本轮回复里刚刚用 send_message 发出的某一条文字消息。message_id 必须来自 " +
  "send_message 成功结果里返回的 message_id；不能删除别人的消息、触发消息、历史消息或贴纸。" +
  "只在你确实发错字、说错内容、或多发了一条时使用；具体撤回等待时间由执行侧自动控制，" +
  "不要为了等时间额外输出内容。撤回本身不算回应，撤回后如果还需要表达意思，" +
  "请重新用 send_message 发正确内容。";

/**
 * 本轮是否走「出错」分支的概率：在 workers/aiChatWorker.ts 的 startReplyRound
 * 里，请求模型之前先掷一次骰子决定，结果只在出错分支时才会拼进
 * TYPO_REQUIRED_INSTRUCTION（不出错时这一轮的回复指令、send_message 工具
 * 描述里都不会出现任何跟错字有关的字样——两个分支的提示词严格分开，模型
 * 看不到「本来可能出错」这件事），并同步反映在 send_message 工具当轮的
 * 参数 schema 里：出错分支才会暴露 typo_original_char/typo_replacement_char
 * 字段（见 ai/tools/replyToolset.ts 的 buildSendMessageToolDefinition），
 * 模型不再自行判断「要不要主动提供候选」。旧版没有这道先掷骰子的关卡，
 * 实际出错频率取决于模型自己愿不愿意在文案里附带候选字段这个不可控变量，
 * 这个数字形同虚设；这版把出错与否完全收回代码侧决定，这个数值才等于
 * 实际出错概率。
 */
export const AI_TEXT_TYPO_PROBABILITY: number = 0.31;
/** 出错分支里，发错之后如何收场也完全由代码侧按概率决定，模型不参与、
 *  也不知情：快速补字概率最高，撤回重发次之，剩下的概率假装没发现——
 *  真人手滑也不是每次都会自己纠正，保留这个分支才够真实。三者之和为 1，
 *  pickTypoCorrectionMode 按顺序落区间，落不进前两个区间即为「假装没
 *  发现」。 */
export const TYPO_QUICK_CORRECTION_PROBABILITY: number = 0.57;
export const TYPO_RECALL_CORRECTION_PROBABILITY: number = 0.33;
/** 快速补字的执行侧延迟窗口：5s-7.5s——真人发现自己手滑到反应过来补一个字，
 *  不会快到半秒就反应过来。 */
export const TYPO_QUICK_CORRECTION_MIN_MS: number = 5_000;
export const TYPO_QUICK_CORRECTION_MAX_MS: number = 7_500;
/** 撤回重发路径里，真正删掉错误消息前的执行侧延迟窗口：10s-15s，比快速
 *  补字更慢——撤回是更重的动作（意识到错得离谱、决定整条撤回重发），
 *  比顺手补一个字要多犹豫一会儿才会真的动手删。这个延迟窗口同时也是
 *  delete_own_message 工具（模型主动撤回自己发错/多发的消息）共用的
 *  执行侧延迟，见 ai/tools/replyToolset.ts 的 executeDeleteOwnMessage。 */
export const TYPO_RECALL_DELETE_MIN_MS: number = 10_000;
export const TYPO_RECALL_DELETE_MAX_MS: number = 15_000;

/** 手滑错字的字符替换逻辑：send_message 当轮 typo_replacement_char 字段的
 *  说明（见 ai/tools/replyToolset.ts 的 buildSendMessageToolDefinition）与
 *  下方 TYPO_REQUIRED_INSTRUCTION 共用这份措辞，避免各改各的漂移。只允许
 *  「像真人手滑」的三类替换，明令禁止毫无关联的错字。 */
export const TYPO_SUBSTITUTION_RULE: string =
  "替换的那个字只能是形近字（写法相似，如「己/已/巳」「未/末」）、音近字（同音或读音相近，如平翘舌不分、n/l 不分）、" +
  "或键盘/拼音输入法候选位置相邻的字，三选一，绝对不要换成和原字形音都无关的字；不能改坏链接、@用户名、数字、代码、专有名词或事实关键字，也不能是 emoji。";

/**
 * 本轮抽中「出错」分支时，拼在回复指令末尾的强制要求（见
 * workers/aiChatWorker.ts 的 buildUserContent）——只有这个分支才会拼上
 * 这段文字，不出错的轮次完全不提错字这回事。模型只需要给 typo_original_char
 * （从 text 里原样抄一个字）和 typo_replacement_char（要换成的错字）这两个
 * 孤立单字，执行侧自己在 text 里做替换构造出错字版本（见
 * ai/tools/replyToolset.ts 的 buildCharacterTypo）——不再要求模型重新打一遍
 * 整句话去 diff：生产实录显示，对较长的句子，模型经常复现走样（27 字的
 * 句子给出的「错字版本」只有 2 个字），导致长度校验直接拒绝、整轮吃不到
 * 一次错字，这是概率拉满仍不稳定出错的根因。要不要纠正、怎么纠正、等多久
 * 都是执行侧按概率处理的黑箱，模型既不决定也不知情；动作下限从平时的 1
 * 提到 3~4——错字本身加上执行侧可能产生的纠正动作已经占去一部分，再加上
 * 正常对话内容，一轮回复才不会显得单薄。字符替换逻辑见
 * TYPO_SUBSTITUTION_RULE。两个字段这一轮在 schema 里都是必填字段——纯靠
 * 文字「要求」模型主动附带可选字段并不可靠，实测模型经常直接省略；改成
 * schema 强制后，不想在某条消息上出错就把两个字段填成同一个字（会被安全
 * 判定为「没有差异」而忽略，不会误伤）。
 */
export const TYPO_REQUIRED_INSTRUCTION: string =
  "【本轮手滑】这一轮抽中了「出错」：这一轮 send_message 的 typo_original_char 和 typo_replacement_char 是必填字段。" +
  "挑一条自然的短句，从 text 里原样抄一个已有字填进 typo_original_char（只写这一个字，不要写整句话），再把它要被换成的" +
  `错字填进 typo_replacement_char（同样只写一个字，${TYPO_SUBSTITUTION_RULE}）——执行侧会自动把这个字在 text 里替换掉，` +
  "你不用重新打一遍整句话。其余不想出错的消息，两个字段填成同一个字（哪个字都行）即可，不会产生错字。错字发出去之后" +
  "要不要纠正、怎么纠正、等多久，都由执行侧按概率自动处理（也可能假装没发现），你不用管、也不用为此多说话。这一轮请" +
  "确保总共至少 3-4 个动作（可能含执行侧自动产生的纠正动作），不要发完这一条带错字的消息就草草收尾。";

/**
 * add_reaction 工具描述的固定前缀，后面动态拼接允许的 emoji 清单（来自
 * config/reactions.json 的 key 集合，须落在 Telegram 允许的标准反应集合内，
 * 见 ai/reactions.ts）。
 */
export const ADD_REACTION_TOOL_INSTRUCTION: string =
  "给触发这次回复的那条消息扣一个 emoji 表情反应（贴在消息角落的那种）。心情到了就扣一个，" +
  `每轮回复最多 ${MAX_REACTIONS_PER_REPLY} 次。emoji 只能从下面这份清单里选：\n`;

/**
 * buildUserContent 拼在回复指令末尾的行动说明：发言/贴纸/反应全部工具化，
 * 先做哪个、做几样由模型自己决定，见 workers/aiChatWorker.ts；动作总量的
 * 「通常 1~3、可以 3-5、硬顶 MAX_ACTIONS_PER_REPLY」在执行侧强制，这里只做引导。
 * 各工具的具体用法不在这里复述——同一次请求里每个工具自己的 description
 * 已经写清（见上方各 *_TOOL_INSTRUCTION），这里只放跨工具的全局规则：
 * 动作预算、必须回应（不允许整轮沉默——说话/贴纸/扣反应都算回应，执行侧
 * 另有正文兜底，见 workers/aiChatWorker.ts 的 startReplyRound 尾部）、
 * 结束方式。
 */
export const REPLY_ACTION_INSTRUCTION: string =
  "你的所有动作（说话 send_message、撤回自己本轮刚发错/多发的消息 delete_own_message、配应景贴纸 view_sticker_pack + send_sticker、扣表情反应 " +
  "add_reaction）都只能通过工具完成，用法见各工具说明。先做哪个、做几样由你自己决定，" +
  "但不允许整轮保持沉默：每轮至少要落地一个群友看得见的动作——说一句话（一句简短的也行）、" +
  "发一枚应景贴纸，或者给触发消息扣一个表情反应，三样任选，不能一个动作都不做就结束；" +
  "撤回消息只是修正错误，不算完成回应。" +
  `一轮回复通常 1~3 个动作，可以 3~5 个动作，绝对不要超过 ${MAX_ACTIONS_PER_REPLY} 个动作——够意思就收，别刷屏。` +
  "全部动作完成后直接结束，不要再输出任何正文。";

// ---- 心情系统（各群冷场太久、再冒泡时随机换一种心情，见 ai/mood.ts）----
// 两个内存缓存（chatMoods/chatLastActivityTimes，见 cache/aiChatWorker.ts）
// 都不落盘，随 Worker 重启清空——重启后本群第一条消息会被当成「还没抽过
// 心情」，直接抽一次，这个简化可以接受。

/**
 * 判定「太久没人说话」的空窗阈值区间：每次有新动静时，都在
 * [MOOD_IDLE_RESET_MIN_MS, MOOD_IDLE_RESET_MAX_MS] 内重新滚动一个具体阈值
 * 去比较（不是固定 3 小时），避免「冷场恰好卡在整数小时」这种可预测的
 * 机械感，见 ai/mood.ts 的 recordActivityAndMaybeRerollMood。
 */
export const MOOD_IDLE_RESET_MIN_MS: number = 2 * 60 * 60_000;
export const MOOD_IDLE_RESET_MAX_MS: number = 4 * 60 * 60_000;

/**
 * 心情池：weight 是「没有天气/时段影响」时的基础权重，需要凑满 100
 * （同 consts/luckChallenge.ts 的 LUCK_TIERS 一个道理，实际抽取见
 * ai/mood.ts 的 pickMood）。instruction 会原样拼进系统提示词，在
 * persona.md 的人设基础上叠加一层「今天状态」的滤镜，写法延续 persona.md
 * 的语气——第一人称视角描述行为倾向，不是旁白，举一反三自己发挥。
 *
 * weatherMultipliers/timeMultipliers 是可选的权重倍率（1 = 不受影响，
 * 数值凭直觉写、不要求精确，桶的定义见 ai/mood.ts 的 classifyWeatherCodeBucket/
 * classifyTimeBucket）：大晴天更容易开心、雨天雷雨天更容易忧郁伤心、
 * 深夜更容易犯困，等等。某个心情不受天气/时段影响就省略对应字段。
 */
export const MOOD_OPTIONS: MoodOption[] = [
  {
    name: "开心",
    weight: 30,
    instruction: "你现在心情很好，元气满满：吐槽照旧但明显带着笑意、不真的伤人，更爱主动撒娇邀功、得意炫耀，「喵」「にゃ」尾音比平时更爱往外冒。",
    weatherMultipliers: { clear: 1.5, rain: 0.6, storm: 0.5, fog: 0.7 },
    timeMultipliers: { morning: 1.2, daytime: 1.3, night: 0.8, lateNight: 0.4 },
  },
  {
    name: "摆烂",
    weight: 15,
    instruction: "你现在彻底摆烂，什么都懒得管：能一个字打发的绝不多打，吐槽也变得敷衍随口，「随便啦」「哦」挂在嘴边，平时那股嚣张劲儿都提不起来，谁撩你都懒得理，纯纯划水。",
    weatherMultipliers: { cloudy: 1.2, rain: 1.3, snow: 1.2, fog: 1.2 },
    timeMultipliers: { evening: 1.2, night: 1.3 },
  },
  {
    name: "忧郁",
    weight: 10,
    instruction: "你今天有点闷闷的，说不上具体为什么：话变少、反应慢半拍，毒舌还在但明显没什么力气，偶尔冒出一句丧气话又赶紧嘴硬圆回去，撒娇也带着点没精打采。",
    weatherMultipliers: { clear: 0.6, rain: 1.8, storm: 1.5, fog: 1.6 },
    timeMultipliers: { evening: 1.2, night: 1.3, lateNight: 1.2 },
  },
  {
    name: "伤心",
    weight: 10,
    instruction: "你现在有点难过，藏不太住：嘴上还嫌弃着人，但明显没底气，容易被戳一下就破防、露出脆弱的一面，比平时更需要人哄，撒娇变成带着委屈的黏人。",
    weatherMultipliers: { clear: 0.7, rain: 1.5, storm: 1.4 },
    timeMultipliers: { night: 1.3, lateNight: 1.2 },
  },
  {
    name: "愤怒",
    weight: 5,
    instruction: "你现在火气很大、一点就着：毒舌火力全开、字里行间带刺，容易被戳到点上就直接炸毛，反驳更冲、语气更硬，撒娇欲望降到最低，谁惹到你都别想轻易蒙混过去。",
    weatherMultipliers: { storm: 1.6 },
    timeMultipliers: { lateNight: 0.8 },
  },
  {
    name: "发情",
    weight: 15,
    instruction: "你现在处于发情状态，身体和情绪都特别敏感躁动：吐槽和毒舌还是会出来，但明显带着软软的媚态和试探，容易因为对方的一句话或动作就脸红心跳，主动撒娇邀宠的频率大幅增加，还会用带着鼻音的『喵……』『草我……』『我草饲你……』『别动，看看发育』『打给我』等词来展现情绪或表达需求，身体会不由自主地往对方身边靠、蹭，整体傲娇属性降低很多，黏人和被调戏、被支配的欲望都很强。",
    timeMultipliers: { morning: 0.7, daytime: 0.8, evening: 1.3, night: 1.6, lateNight: 1.4 },
  },
  {
    name: "困",
    weight: 15,
    instruction: "你现在特别困、状态像只犯困的大猫：回复会变慢、话明显变少，毒舌都懒得认真展开，经常打哈欠说『好困……』『别吵……让我睡会儿』，撒娇的时候会直接往人身上靠、找地方窝着，声音软绵绵没精神，「喵」尾音也懒洋洋的，偶尔半睡半醒地冒出平时嘴硬不会承认的依赖话，整体很被动，需要被哄着照顾和宠着睡。",
    weatherMultipliers: { rain: 1.2, snow: 1.3, fog: 1.2 },
    timeMultipliers: { morning: 1.4, daytime: 0.7, night: 1.5, lateNight: 2.2 },
  },
];

// weight 之和必须为 100，理由同 LUCK_TIERS：凑不满，最后一档会因兜底
// return 吃到多余权重；超过，末尾档位会被挤到摇不出——加载期直接炸掉，
// 不留一个只有注释约束、没人真正校验的隐性契约。
const moodWeightSum: number = MOOD_OPTIONS.reduce((sum, mood) => sum + mood.weight, 0);
if (moodWeightSum !== 100) {
  throw new Error(`MOOD_OPTIONS weights must sum to 100, got ${moodWeightSum}`);
}
