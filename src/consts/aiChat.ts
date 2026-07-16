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
 * 群友发图片/贴纸/GIF 时，AI 在解析完成后主动回复那条消息、评价媒体内容的
 * 概率——三种媒体共用同一个概率预算（不是各自独立掷骰）。掷骰子在主线程
 * （照顾 /quiet 状态与随机回复冷却，见 src/auto/message.ts 的媒体分支）；
 * 命中后由 Worker 在描述解析成功时执行（解析失败没内容可评，静默放弃），
 * 见 workers/aiChatWorker.ts 的 recordChatMedia。
 */
export const AI_MEDIA_COMMENT_PROBABILITY: number = 1 / 8;

/**
 * xAI API 的 base URL，喂给 openai SDK 的 baseURL（见 ai/xai.ts）——用的是
 * xAI 的 responses 接口（chat completions 在 xAI 已是 legacy，内置
 * web_search 等服务端工具只在 responses 上提供；已用官方 openai SDK 的
 * client.responses.create 实测确认 web_search + 自定义函数可以混用同一次
 * 请求，行为与直接打原始 REST 接口一致）。
 */
export const XAI_BASE_URL: string = "https://api.x.ai/v1";
/** 闲聊回复生成（callGrok）用的模型——人设发挥、工具调用都在这条链路上，
 *  给最新旗舰版本。 */
export const XAI_REPLY_MODEL: string = "grok-4.5";
/** 冷消息压缩（summarizeBatch）用的模型——中性总结任务，不需要追新版本。 */
export const XAI_SUMMARY_MODEL: string = "grok-4.3";
/** 媒体（图片/贴纸/GIF）描述（describeMediaUncached）用的视觉模型。 */
export const XAI_MEDIA_MODEL: string = "grok-4.3";
/** 单次请求的超时（openai SDK 的 per-attempt timeout；SDK 默认对瞬时失败
 *  自动重试几次，每次重试各自套用这个超时预算，不是所有重试共享一个
 *  90 秒硬顶——这是比手写 fetch 更强的地方，瞬时的 5xx/连接错误能自愈）。 */
export const REQUEST_TIMEOUT_MS: number = 90_000;

/**
 * 单次请求的输出 token 上限（回复流水线 / 冷消息压缩各一个）。XAI_REPLY_MODEL
 * 与 XAI_SUMMARY_MODEL 都是推理模型，思考内容也计入 max_output_tokens（usage 的
 * output_tokens_details.reasoning_tokens，实测确认）：上限给小了，额度会在
 * 思考阶段就被烧光——请求返回 200 但 status=incomplete、正文为空，表现为
 * 静默失败（DeepSeek 时代压缩任务曾因 768 的旧上限反复空手而归，同一坑）。
 * max_output_tokens 只是封顶，按实际用量计费，放大上限不增加正常请求的开销。
 *
 * REPLY_MAX_TOKENS 给得比 SUMMARY_MAX_TOKENS 更宽松：回复流水线挂了
 * web_search，命中搜索的那些请求要在 reasoning 预算里多担一层「决定要不要
 * 搜、消化搜索结果、整理带引用的正文」的开销，比纯聊天更容易顶到旧上限，
 * 表现为回复写到一半戛然而止（见 ai/xai.ts 的 isTruncatedByTokenLimit，
 * 命中时 callGrok 直接放弃这轮，不把断句发出去——但预算给够从源头上更该
 * 优先，被动放弃只是兜底）。
 */
export const REPLY_MAX_TOKENS: number = 24_576;
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

/**
 * 冷消息压缩用的中性总结系统提示词（不带人设、不带工具），见
 * workers/aiChatWorker.ts 的 summarizeBatch。字数上限直接引用
 * SUMMARY_MAX_CHARS，避免文案里的数字和 truncateInline 真正生效的截断值
 * 各改各的漂移。
 */
export const SUMMARY_SYSTEM_PROMPT: string =
  "你是一个中文群聊记录压缩器。用户会给你一段群聊转录，每行格式为「[年/月/日 时:分:秒] [id:用户ID] 名字：内容」，行首方括号里是那条消息的发送时间（东京时间，个别旧记录没有时间前缀），同名的人可能是不同的人，请以 id 区分身份。" +
  "请把这段记录压缩成一段简洁的摘要，保留：这段对话大致发生的时间（如「7月16日晚」）、聊过的话题及走向、谁说过的关键信息（人名后带 [id:xxx] 标注以免混淆）、达成的约定、出现的梗和称呼、人物关系或情绪的变化。" +
  `严格控制篇幅：摘要正文不得超过 ${SUMMARY_MAX_CHARS} 字，不要展开细节、不要逐条复述，只挑最要紧的信息压缩成一段话。只输出摘要正文本身，不要任何前缀、解释、列表符号或代码块，不要输出思考过程。`;

/**
 * callGrok 系统提示词里，紧跟在现查的「当前实际时间」句子之后的静态指令
 * （时间句本身不能预先算好存成字面量：Worker 线程常驻，缓存的时间会很快
 * 过期，须现查，见 workers/aiChatWorker.ts 的 currentTimeSentence）。
 */
export const TIME_AWARENESS_INSTRUCTION: string =
  "聊天记录每行行首方括号里是那条消息的发送时间，回答时间/日期相关的问题、或判断某句话是多久之前说的，都以这些真实时间为准，不要编造。";

/**
 * 鼓励模型主动用内置 web_search 工具核实信息，而不是瞎编或一味嘴硬拒答，
 * 见 workers/aiChatWorker.ts 的 callGrok（tools 数组里的 { type: "web_search" }）。
 * 搜索由 xAI 服务器侧自动执行，结果直接体现在最终文本里，不需要额外处理。
 * persona.md「绝对不编造事实」一节配套调整过：真查不到/查了没意义才傲慢
 * 回绝，能查的先查证。
 */
export const WEB_SEARCH_INSTRUCTION: string =
  "你内置了实时联网搜索能力：遇到时效性强（新闻、价格、比分、榜单、版本号、事件进展等）、你没有把握、或对方明确要求查证的问题，主动搜索确认清楚了再回答，别懒得查就瞎编或者甩锅拒答。搜完该怎么损怎么损、该怎么骄傲怎么骄傲，别在回复里暴露自己刚查过——装作本来就知道。";
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
/** 限频黑洞的固定提示文案，见 workers/aiChatWorker.ts 的 notifyRateLimited。 */
export const RATE_LIMIT_NOTICE_TEXT: string = "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡";

/**
 * 一次工具调用往返最多允许几轮（模型要工具结果 -> 喂回去 -> 模型可能再要
 * 下一个工具……）。给个上限防止模型陷入死循环反复要工具，烧穿 API 配额。
 */
export const MAX_TOOL_ROUNDS: number = 5;

/** 「正在输入…」状态的重发间隔，机制见 workers/aiChatWorker.ts 的 startTypingHeartbeat。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;

// ---- 媒体读图（群里有人发图片/贴纸/GIF -> 占位入缓存 -> 异步解析替换占位）----
// 流程见 workers/aiChatWorker.ts 的 recordChatMedia 与 ai/imageDescription.ts 的
// describeMedia；三种媒体共用下载/缓存机制，各自的占位符、prompt、描述长度
// 上限分开定义。贴纸/GIF 的素材来源不总是 jpg/png（webp 贴纸本体、GIF 的
// mp4 走缩略图），统一先经 libs/image.ts 嗅探格式并按需转码。

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
/** 喂给视觉模型的描述指令：产出一行简短中文描述，供转录上下文引用。 */
export const IMAGE_DESCRIPTION_PROMPT: string =
  "这是中文群聊里有人发的一张图片。请用中文简要描述它：是什么内容、图里有什么文字、想表达什么；" +
  `若是表情包/梗图/截图，请点出其中的文字要点和情绪。不超过 ${IMAGE_DESCRIPTION_MAX_CHARS} 字，只输出描述本身，不要任何前缀、解释或引号。`;

/**
 * 贴纸/GIF 描述的字数上限——比图片短：贴纸/GIF 本身信息密度低（一个画面
 * 梗+一句文字居多），这份描述还要兼顾另一个消费方（ai/stickerCatalog.ts
 * 的目录：拼进 send_sticker 工具描述里的编号清单，条目太长会把每次请求的
 * 系统提示词撑得很臃肿），75 字足够说清画面角色/动作/文字/情绪。
 */
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 75;
/** 喂给视觉模型描述一枚贴纸的指令：群友发的贴纸、机器人自己贴纸目录的
 *  生成（见 ai/stickerCatalog.ts）共用同一份措辞，保证两处描述风格一致。 */
export const STICKER_DESCRIPTION_PROMPT: string =
  "这是中文群聊场景用到的一枚贴纸（表情包）。请用中文简要描述画面：角色/形象是谁或什么、动作和表情、" +
  `画面里的文字（如有）、整体想表达的情绪或语气。不超过 ${SHORT_MEDIA_DESCRIPTION_MAX_CHARS} 字，只输出描述本身，不要任何前缀、解释或引号。`;
/** 喂给视觉模型描述一个 GIF 封面帧的指令：没有抽帧能力（无 ffmpeg），只能
 *  分析 Telegram 自带的缩略图，提示词点明这一点，避免模型把只看到第一帧
 *  的内容说成是整个动图。 */
export const ANIMATION_DESCRIPTION_PROMPT: string =
  "这是中文群聊里发的一个动图（GIF）的封面帧画面（不是完整动图，只是第一帧）。请用中文简要描述这一帧看到的内容、" +
  `画面里的文字（如有）、大致想表达的情绪或梗。不超过 ${SHORT_MEDIA_DESCRIPTION_MAX_CHARS} 字，只输出描述本身，不要任何前缀、解释或引号。`;

/** 媒体描述的输出 token 上限：描述本身很短，但推理模型的思考也计入（同
 *  REPLY_MAX_TOKENS 注释），要给足余量。图片/贴纸/GIF 共用。 */
export const MEDIA_DESCRIPTION_MAX_TOKENS: number = 4096;
/** 从 Telegram 下载媒体文件（图片本体、贴纸本体/缩略图、GIF 缩略图）的超时。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 20_000;
/** 媒体描述缓存（按 file_unique_id 去重，见 ai/imageDescription.ts）的条目
 *  上限，超出按插入顺序淘汰最旧的。同一张梗图/贴纸/GIF 被反复刷屏时不再
 *  重复下载/解析，转录里也不会出现同一份媒体多份措辞各异的描述。图片/
 *  贴纸/GIF 共用同一个缓存（键空间不冲突：file_unique_id 本就是 Telegram
 *  全局唯一）。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 500;
/** 媒体描述缓存条目的存活时间：超过上限个数靠插入序淘汰，超过这个时长则不管
 *  size 是否超限都主动清掉，双保险避免低流量长期运行下缓存无限期占内存。 */
export const MEDIA_DESCRIPTION_CACHE_TTL_MS: number = 60 * 60 * 1000;
/** 媒体下载大小上限：挑尺寸/素材来源时跳过超过它的档位（xAI 收 base64 后限
 *  20MiB，Telegram 压缩后的 photo/贴纸/缩略图远小于此，这只是防御性护栏）。 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 8 * 1024 * 1024;

// ---- 应景贴纸（send_sticker 工具：模型在生成回复的同一次对话里自己决定
// 要不要配一枚贴纸、配哪一枚）----
// 目录生成/持久化见 ai/stickerCatalog.ts；工具定义/执行见 ai/stickers.ts。

/**
 * send_sticker 工具描述的固定前缀，后面动态拼接当次可选贴纸的编号清单
 * （见 ai/stickers.ts 的 buildSendStickerToolDefinition）。措辞把默认答案
 * 直接定为「发」——每次回复都先扫一遍清单挑最搭的一枚，气氛沾边即可、
 * 不等绝配；只有清单里确实一枚都完全不沾边时才允许跳过。
 */
export const SEND_STICKER_TOOL_INSTRUCTION: string =
  "发贴纸是你说话方式的一部分，像标点一样常用。每次回复前先扫一眼下面的清单，默认就该配一枚：" +
  "挑跟这条回复的情绪、语气或内容最搭的那枚调用本工具发出来，气氛对上就行，不用等「绝配」，" +
  "宁可发一枚七分贴的也别因为挑剔而不发。只有清单里确实一枚都完全不沾边时，才允许这条回复" +
  "不带贴纸。只能从下面这份编号清单里选（每行「编号. emoji 画面描述」），index 参数填清单里的编号：\n";
