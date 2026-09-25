/**
 * RIFF/WAVE 容器的固定布局，供 aiChat/ai/utils/wavPcm.ts 解析合成语音、
 * aiChat/ai/voiceEncoding.ts 识别 WAV 容器。
 * 所属模块：packages/aiChat/ai/utils/wavPcm.ts 与 packages/aiChat/ai/voiceEncoding.ts。
 */

/** WAV 文件头固定长度：`RIFF` + 4 字节长度 + `WAVE`。 */
export const WAV_RIFF_HEADER_BYTES: number = 12;

/** 每个 RIFF 子块头的固定长度：4 字节标识 + 4 字节小端长度。 */
export const WAV_CHUNK_HEADER_BYTES: number = 8;

/** `fmt ` 子块里 PCM 所需字段的最小长度（到 bits_per_sample 为止）。 */
export const WAV_FMT_MIN_BYTES: number = 16;

/** `fmt ` 子块 audio_format 字段里的整数 PCM 取值。 */
export const WAV_FORMAT_PCM: number = 1;

/** 本项目只解析的单声道声道数。 */
export const WAV_MONO_CHANNELS: number = 1;

/** 本项目只解析的 16 bit 位深。 */
export const WAV_PCM16_BITS: number = 16;

/** 16 bit 有符号 PCM 归一到 [-1, 1) 的除数。 */
export const WAV_PCM16_SCALE: number = 32_768;

/** 视为 RIFF/WAVE 容器的 MIME 闭集。 */
export const WAV_MIME_TYPES: readonly string[] = ["audio/wav", "audio/x-wav", "audio/wave"];
