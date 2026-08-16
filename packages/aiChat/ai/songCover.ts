/**
 * 生歌消息的封面缩略图：拿曲目信息调一次图片模型，压成 Telegram 能收的 JPEG。
 *
 * **为什么要自己画：** Lyria 只产出音频与歌词文本，响应里没有任何图像
 * （模型卡的 Supported outputs 就是 "Audio (MP3), Text (Lyrics)"）。群里那些
 * 带专辑封面的音乐消息，封面来自源文件里嵌的 ID3 APIC 帧——搬运真实曲目才有，
 * 生成的裸 MP3 没有。想让播放条上不是一个通用音符图标，只能自己补一张。
 *
 * **这是消息装帧，不是群友要的图。** 因此刻意与 generate_image 那条路完全分开：
 * 不占每群生图冷却、不计入本轮动作预算、不进自录记忆。占用户的生图额度去画一张
 * 他们没要过、也不会单独看到的缩略图，说不通。
 *
 * **失败一律静默，包括抛出来的那种。** 返回 null 时调用方按「这次没有缩略图」
 * 发歌——歌本身是这次调用的主体，为一张装帧图把一首已经生成、已经计过费的歌
 * 整条丢掉是不可接受的取舍。
 *
 * 两家实现包的 generateImage 都自己兜住异常只返回 null，但**选取那一步会抛**：
 * imageAiProvider() 在「选过的那一家缺配置」时按设计抛错（见 aiChat/provider.ts 的
 * resolveCapability / capabilityConfig）。这个 reject 若逃出去，展开的不是这一次封面，而是
 * `toolset.execute()` 外面整个工具循环（口径同 aiChat/ai/utils/toolPause.ts 的
 * 模块头注）——歌已经生成、账已经出，群里却什么都收不到。因此这里必须整段
 * try/catch，而不是依赖下层的契约。
 *
 * 正常失败的日志由底层各自记（生图在实现包里，压缩在 libs/image.ts）；只有上面
 * 那种抛出来的失败在这里补记一行。
 *
 * 跑在 AI 闲聊 Worker 线程上（调用方就是生歌工具）。
 */

import {
  SONG_COVER_JPEG_QUALITIES,
  SONG_COVER_MAX_BYTES,
  SONG_COVER_MAX_EDGE,
} from "../../consts/aiChat/songGeneration";
import { DEFAULT_IMAGE_GENERATION_ASPECT_RATIO } from "../../consts/aiChat/imageGeneration";
import { songCoverPrompt } from "../../consts/aiChat/prompts/song";
import { logger } from "../../infra/logger";
import { prepareThumbnailJpeg } from "../../libs/image";
import { generateChatImage } from "./imageGeneration";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";

/** generateSongCover 的入参；三项都只作为封面画面的气氛线索。 */
export interface SongCoverParams {
  /** 曲名。 */
  title: string;
  /** 演唱者。 */
  performer: string;
  /** 交给音乐模型的创作说明。 */
  songPrompt: string;
  /** 本轮生成的取消信号；与生歌请求同一个。 */
  signal?: AbortSignal;
}

/**
 * 画一张封面并压成缩略图；任一步失败返回 null。
 *
 * 画幅固定正方形：封面本来就是方的，而缩略图还会被客户端按方形裁一次，交一张
 * 宽幅图过去只是先白画一遍再被裁掉两边。
 */
export async function generateSongCover({
  title,
  performer,
  songPrompt,
  signal,
}: SongCoverParams): Promise<Buffer | null> {
  try {
    const image: GeneratedChatImage | null = await generateChatImage({
      prompt: songCoverPrompt(title, performer, songPrompt),
      aspectRatio: DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
      ...(signal ? { signal } : {}),
    });
    if (!image) return null;
    // 字节按引用交给压缩，不 Buffer.from 复制一份：一张 1K 生图有几 MB，而
    // sharp 本来就接收 Uint8Array（见 libs/image.ts 的入参类型）。
    return await prepareThumbnailJpeg({
      bytes: image.bytes,
      maxEdge: SONG_COVER_MAX_EDGE,
      maxBytes: SONG_COVER_MAX_BYTES,
      qualities: SONG_COVER_JPEG_QUALITIES,
    });
  } catch (error: unknown) {
    // 本轮被作废时 signal 已 abort，那不是故障，不记日志。
    if (signal?.aborted !== true) logger.error("Error generating a song cover:", error);
    return null;
  }
}
