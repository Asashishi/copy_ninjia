/**
 * 合成语音容器的固定布局：RIFF/WAVE（aiChat/ai/utils/wavPcm.ts 解析、aiChat/ai/voiceEncoding.ts
 * 识别），以及 Telegram sendVoice 直接接受的 OGG/Opus 与 MP3（aiChat/ai/utils/voiceContainer.ts
 * 校验并计算时长）。
 * 所属模块：packages/aiChat/ai/utils/wavPcm.ts、packages/aiChat/ai/utils/voiceContainer.ts 与
 * packages/aiChat/ai/voiceEncoding.ts。
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

/** OGG/Opus 容器的 MIME；OpenAI audio/speech 的 `opus` 响应按此声明。 */
export const OGG_OPUS_MIME_TYPE: string = "audio/ogg";

/** MP3 的 MIME；xAI `/tts` 的 `mp3` 响应按此声明。 */
export const MP3_MIME_TYPE: string = "audio/mpeg";

/** 每个 Ogg 页开头的捕获模式 `OggS`。 */
export const OGG_CAPTURE_PATTERN: string = "OggS";

/** Ogg 页头在段表之前的固定长度。 */
export const OGG_PAGE_HEADER_BYTES: number = 27;

/** Ogg 页头里「本页没有包在此结束」的 granule position（64 位全 1 的低 32 位与高 32 位）。 */
export const OGG_GRANULE_UNSET_WORD: number = 0xFFFF_FFFF;

/** Opus 首个头包的魔数。 */
export const OPUS_HEAD_MAGIC: string = "OpusHead";

/** OpusHead 里到 pre-skip 字段为止的最小长度（魔数 8 + 版本 1 + 声道 1 + pre-skip 2）。 */
export const OPUS_HEAD_MIN_BYTES: number = 12;

/** Opus granule position 的固定时钟（Hz），与输入采样率无关。 */
export const OPUS_GRANULE_RATE: number = 48_000;

/** 开头 ID3v2 标签的魔数。 */
export const ID3V2_MAGIC: string = "ID3";

/** 末尾 ID3v1 标签的魔数。 */
export const ID3V1_MAGIC: string = "TAG";

/** ID3v2 标签头长度（其后的 syncsafe 长度不含这 10 字节）。 */
export const ID3V2_HEADER_BYTES: number = 10;

/** ID3v2 标签头 flags 里「带 10 字节 footer」的位。 */
export const ID3V2_FOOTER_FLAG: number = 0x10;

/** ID3v1 尾标签的固定长度（以 `TAG` 开头）。 */
export const ID3V1_TAG_BYTES: number = 128;

/** MPEG 音频帧头长度。 */
export const MP3_FRAME_HEADER_BYTES: number = 4;

/** MPEG-1 Layer III 每帧样本数。 */
export const MP3_MPEG1_SAMPLES_PER_FRAME: number = 1_152;

/** MPEG-2 / MPEG-2.5 Layer III 每帧样本数。 */
export const MP3_MPEG2_SAMPLES_PER_FRAME: number = 576;

/** MPEG-1 Layer III 的码率表（kbps），按帧头 4 bit 码率索引取值；0 与 15 为非法索引。 */
export const MP3_MPEG1_BITRATES_KBPS: readonly number[] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** MPEG-2 / MPEG-2.5 Layer III 的码率表（kbps）；0 与 15 为非法索引。 */
export const MP3_MPEG2_BITRATES_KBPS: readonly number[] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** MPEG-1 的采样率表（Hz），按帧头 2 bit 采样率索引取值；索引 3 为保留值。 */
export const MP3_MPEG1_SAMPLE_RATES: readonly number[] = [44_100, 48_000, 32_000];

/** MPEG-2 的采样率表（Hz）。 */
export const MP3_MPEG2_SAMPLE_RATES: readonly number[] = [22_050, 24_000, 16_000];

/** MPEG-2.5 的采样率表（Hz）。 */
export const MP3_MPEG25_SAMPLE_RATES: readonly number[] = [11_025, 12_000, 8_000];
