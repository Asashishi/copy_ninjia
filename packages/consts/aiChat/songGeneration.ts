/**
 * 生歌工具（packages/aiChat/ai/tools/replyToolset/songGeneration.ts）的领域预算。
 *
 * **模型名不在这里**：走 config/agent.json 的 `agent.song`，代码不持有任何模型
 * 默认值（见 config/agent.ts）。请求超时与错误标签属于供应商能力，
 * 在 consts/aiChat/gemini.ts。
 *
 * 这一份仍放在与供应商无关的目录下、而不是并进 consts/aiChat/gemini.ts：冷却
 * 时长、每轮上限、体积硬顶都是「换谁都成立」的领域策略，只是眼下恰好只有一家
 * 实现了这项能力（见 types/aiChat/provider.ts 的 AiChatProvider.generateSong）。
 */

/** 普通用户按群共享的生歌冷却时长：15 分钟。superAdmin 不受这项冷却限制。 */
export const SONG_GENERATION_COOLDOWN_MS: number = 900_000;

/** 当前生歌请求正文允许传给模型的最大字符数。 */
export const SONG_GENERATION_PROMPT_MAX_CHARS: number = 4_096;

/** 从生歌 prompt 拼进自录记忆的最大字符数，口径同生图。 */
export const SONG_GENERATION_MEMORY_PROMPT_MAX_CHARS: number = 275;

/**
 * 生歌结果解码后的最大字节数。
 *
 * 比生图宽一个量级：Lyria Pro 的整首歌是 44.1 kHz 立体声、时长以分钟计，MP3 也
 * 要几 MB，而 Telegram 的 sendAudio 本身允许到 50 MB。上限只用来挡住异常巨大的
 * 载荷把 Worker 的堆吃掉。
 */
export const SONG_GENERATION_MAX_BYTES: number = 24 * 1_024 * 1_024;

/** 标准 base64 对二进制上限的理论编码长度，用于在解码分配内存前拒绝超大响应。 */
export const SONG_GENERATION_MAX_ENCODED_CHARS: number = Math.ceil(SONG_GENERATION_MAX_BYTES / 3) * 4;

/** 生歌工具单轮最多接纳一首歌曲；接纳时同时预占一个共享可见动作。 */
export const MAX_GENERATED_SONGS_PER_REPLY: number = 1;

/** 发送到 Telegram 的音频文件名前缀；Bot API 靠扩展名判定容器。 */
export const SONG_FILE_BASENAME: string = "song";

/** 曲名的最大字符数；同时约束 Telegram 播放条上的显示与 caption 里的标题行。 */
export const SONG_TITLE_MAX_CHARS: number = 64;
/** 演唱者的最大字符数，口径同曲名。 */
export const SONG_PERFORMER_MAX_CHARS: number = 64;

/** 模型没给曲名时用的占位；不留空字符串——播放条上会退化成显示文件名。 */
export const SONG_DEFAULT_TITLE: string = "无题";
/**
 * 取不到机器人自己账号身份时的演唱者占位。
 *
 * 正常路径用 Worker 侧注入的账号显示名（见 cache/workers/aiChat/identity.ts）：
 * 这首歌确实是机器人「唱」的，署自己的名比署一个固定词准确。这个常量只兜住
 * Worker 重建后 init 尚未到达的极短窗口。
 */
export const SONG_FALLBACK_PERFORMER: string = "AI";

/**
 * 封面缩略图的长边上限（像素）。
 *
 * 取自 Bot API 对 `sendAudio.thumbnail` 的硬性要求：「width and height should not
 * exceed 320」。超了整条发送被拒，不是降级显示。
 */
export const SONG_COVER_MAX_EDGE: number = 320;

/**
 * 封面缩略图的体积上限（字节）。
 *
 * 同样来自 Bot API：「less than 200 kB」。这里取 192 KiB，按十进制 200 kB 解释
 * 时仍留有小幅余量；卡在边界上等于拿一首已经生成的歌去赌不确定的判定。
 */
export const SONG_COVER_MAX_BYTES: number = 192 * 1_024;

/**
 * 压缩封面时逐档尝试的 JPEG 质量。
 *
 * 从高到低试，第一个落进体积上限的就用。降质量而不是砍边长：320×320 这个尺寸上
 * 质量档还有很大余量，而边长一小缩略图就糊得看不出内容（见 infra/image.ts 的
 * prepareThumbnailJpeg）。只读数组防止调用方误改。
 */
export const SONG_COVER_JPEG_QUALITIES: readonly number[] = [88, 72, 55, 40];

/**
 * caption 末尾那行元信息的固定标签。
 *
 * 明写「AI 生成」是刻意的：Lyria 的 SynthID 水印听不出来，群里看到的又是一条
 * 和真人投稿完全一样的音乐消息，不标一句就等于默认冒充。
 */
export const SONG_METADATA_HASHTAG: string = "#AI音乐";

/**
 * 为 caption 末尾那段元信息预留的字符数。
 *
 * 模型的 caption 上限必须**扣掉**这一段：Bot API 对超长 caption 是整条拒绝而不是
 * 截断，把两段拼起来才发现超限时，丢掉的是一首已经生成、已经计过费的歌。
 * 预留值按最坏情况估：曲名与演唱者各顶到上限，加上书名号、连接符、换行与
 * 「#AI音乐 #mp3 99.99MB 9999.99kbps」那一行。
 */
export const SONG_CAPTION_METADATA_RESERVED_CHARS: number = 256;
