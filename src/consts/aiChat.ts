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
 * 没内容可评，静默放弃），见 workers/aiChat/mediaIngest.ts 的 recordChatMedia。
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
 * 表现为回复写到一半戛然而止（见 ai/utils/geminiResponse.ts 的 isTruncatedByTokenLimit，
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
 * 短暂故障靠这里兜。放弃后该段中期记忆缺失（见 workers/aiChat/compaction.ts
 * 的 rotateCompaction）。重试期间本群轮换链顺延，积压由
 * COMPACTION_MAX_PENDING_PER_CHAT 兜底，洪峰下超额批次照旧丢弃。
 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];
/** 回复生成的生成温度：偏高，换取更贴合人设的活人感发挥。 */
export const REPLY_TEMPERATURE: number = 1.0;

/**
 * 压缩块大小 = 热窗口大小 = 镜像窗口大小。逐字缓存由两个块组成：「热」是
 * 正在累积的最新一块，「镜像」是上一轮攒满时已提交 AI 压缩的那一块——
 * 镜像在自己的摘要生成期间仍整块留在逐字上下文里，等下一块攒满轮换时才
 * 滑出、由（多半早已就绪的）摘要接棒。因此正常情况下不存在「已滑出逐字
 * 区但摘要未就绪」的失忆窗口；例外只有两种：50 条消息的洪峰比一次压缩
 * 调用还快，或压缩失败（刻意不回灌，该段记忆缺失，见
 * workers/aiChat/compaction.ts 的 rotateCompaction）。
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
 * 单群允许同时处于「执行中 + 排队中」的冷消息压缩任务数。群消息可能远快于
 * 一次 Gemini 请求；不设上限时，每满 50 条就保留一整批消息和一个 Promise
 * 闭包，API 变慢/故障期间会无限增长。超出的批次放弃压缩（逐字滚动缓存仍
 * 有硬上限），以有界降级换取进程存活。
 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 4;

/**
 * 各群 dirty 的 AI 记忆快照（滚动缓存 + 中期摘要）上报给主线程（进而落盘）
 * 的节奏，见 workers/aiChat/rollingMemory.ts 的 flushDirtyMemories。硬崩（kill -9/
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
/**
 * Worker 常驻的群记忆总上限。新群超过上限时按最后活动时间淘汰最旧群，
 * 同步删除主线程镜像与磁盘快照；该群之后再次发言会从空记忆重新建立。
 */
export const AI_MEMORY_MAX_CHATS: number = 100;
/** 单条摘要的硬性长度上限（字符），防摘要模型话痨撑爆回复上下文。 */
export const SUMMARY_MAX_CHARS: number = 500;

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
 * 触发被限频黑洞丢弃时会明确回一句「你们太快了」（见 workers/aiChat/replyPipeline.ts 的
 * notifyRateLimited），这是该提示自身的冷却：同一个群在这段时间内至多提示
 * 一次，防止提示本身在刷屏场景下变成新的刷屏放大器。
 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;
/** 限频黑洞的固定提示文案，见 workers/aiChat/replyPipeline.ts 的 notifyRateLimited。 */
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
// 流程见 workers/aiChat/mediaIngest.ts 的 recordChatMedia 与 ai/imageDescription.ts 的
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
 *  ——即便视觉解析失败也不损失现状已有的信息，见 workers/aiChat/mediaIngest.ts 的
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

/**
 * 贴纸/GIF 描述的字数上限——比图片短：贴纸/GIF 本身信息密度低（一个画面
 * 梗+一句文字居多）。这份描述的另一个消费方是贴纸目录（ai/stickerCatalog.ts），
 * 两层贴纸工具下目录条目只在 view_sticker_pack 的返回结果里按需出现、不再
 * 拼进每次请求的工具描述（旧单层方案的 75 字紧箍随之作废），100 字给
 * 「原样抄录画面文字 + 简述画面情绪」留够空间。
 */
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 100;
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
/** 目录里还没生成出整包简介时，一层清单里的占位文案。 */
export const STICKER_PACK_SUMMARY_PENDING: string = "（整包简介还在生成中，可进包内查看具体贴纸）";
/** 查看贴纸包时声明的表达意图字数上限：只保留一条简短决策标准，避免模型
 *  把大段推理塞进工具参数和后续工具结果。 */
export const STICKER_INTENT_MAX_CHARS: number = 80;
/**
 * 本轮是否走「出错」分支的概率：在 workers/aiChat/replyPipeline.ts 的 startReplyRound
 * 里，请求模型之前先掷一次骰子决定，结果只在出错分支时才会拼进
 * aiChatPrompts.ts 的 TYPO_REQUIRED_INSTRUCTION（不出错时这一轮的回复指令、send_message 工具
 * 描述里都不会出现任何跟错字有关的字样——两个分支的提示词严格分开，模型
 * 看不到「本来可能出错」这件事），并同步反映在 send_message 工具当轮的
 * 参数 schema 里：出错分支才会暴露 typo_original_char/typo_replacement_char
 * 字段（见 ai/tools/replyToolset.ts 的 buildSendMessageToolDefinition），
 * 模型不再自行判断「要不要主动提供候选」。旧版没有这道先掷骰子的关卡，
 * 实际出错频率取决于模型自己愿不愿意在文案里附带候选字段这个不可控变量，
 * 这个数字形同虚设；这版把出错与否完全收回代码侧决定，这个数值才等于
 * 实际出错概率。
 */
export const AI_TEXT_TYPO_PROBABILITY: number = 0.15;
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
