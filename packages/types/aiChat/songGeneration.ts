/**
 * 生歌（Lyria 系）这一项能力的领域类型。
 *
 * 与生图刻意保持两套：生图可选两种 provider，生歌目前只有 Google
 * （见 types/aiChat/provider.ts 的 AiChatProvider.generateSong 是可选
 * 成员），把两者塞进同一组类型会让「这次能不能生歌」变成一个要靠供应商名字去猜
 * 的问题。冷却与占位的形状则与生图同构——那套「先占位再发请求、失败按 token 撤销」
 * 的语义两边逐字相同，见 cache/workers/aiChat/songGeneration.ts。
 */

import type { Base64PayloadDecodeFailure } from "./payload";

/**
 * 已校验大小与 MIME 的聊天歌曲结果。
 *
 * **只有音频，没有歌词。** Lyria 会在 `output_text` 里连歌词一起回，本项目刻意
 * 不采：群里发出去的就是这首歌本身，歌词既不进 caption 也不另发一条。采回来
 * 存着不用等于在解码链上多带一份永远没有消费方的状态。
 */
export interface GeneratedChatSong {
  bytes: Uint8Array;
  /** 供应商声明的音频 mime（Lyria 默认 audio/mp3）。 */
  mimeType: string;
}

/**
 * 生歌载荷不可用的具体原因，只用于错误日志定位（英文，见 AGENTS.md 的日志约定）。
 * 口径同 GeneratedImageDecodeFailure：这几种失败对上层都是「没歌」，处置方式却
 * 完全不同，不点名就只能从「生歌失败」四个字里猜。
 */
export type GeneratedSongDecodeFailure =
  | Base64PayloadDecodeFailure
  | "missing audio mime type";

/** 按大小与 mime 解码生歌载荷的结果；失败一律带上可记日志的原因。 */
export type GeneratedSongDecodeResult =
  | { readonly ok: true; readonly song: GeneratedChatSong }
  | { readonly ok: false; readonly reason: GeneratedSongDecodeFailure };

/** 某群当前生歌资格及不可用时的剩余冷却。 */
export type SongGenerationAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 生歌原子占位结果；token 只供原占位者释放。 */
export type SongGenerationClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };
