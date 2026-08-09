/**
 * MPEG audio（MP3）帧头的解码表。
 *
 * 单独成域而不是塞进 consts/aiChat/songGeneration.ts：这些是格式规范里的固定
 * 取值表，与「生歌」这件事无关——任何要读 MP3 时长/码率的调用方都用同一份。
 * 所属模块：packages/aiChat/ai/utils/audioMetadata.ts。
 *
 * 表里的 `0` 占位对应规范中的 free/reserved/bad 档，解析侧一律当作「这不是一个
 * 可用帧头」拒绝，不做猜测性放行。
 */

/** ID3v2 标签头固定长度：`ID3` + 版本 2 字节 + 标志 1 字节 + 同步安全长度 4 字节。 */
export const ID3V2_HEADER_BYTES: number = 10;

/**
 * ID3v2.4 可选尾部的固定长度，与标签头等长且**不计入**头里那个同步安全长度。
 * 漏加就会把这 10 字节尾部当成音频交给帧头扫描。
 */
export const ID3V2_FOOTER_BYTES: number = 10;

/** ID3v2 标志字节里的「带尾部」位；仅 2.4 定义，更早的主版本此位保留为 0。 */
export const ID3V2_FOOTER_FLAG: number = 0x10;

/** 首个定义了尾部的 ID3v2 主版本号（标签头第 4 字节）。 */
export const ID3V2_FOOTER_MIN_MAJOR_VERSION: number = 4;

/** MPEG1 Layer III 的码率表（kbps）；索引即帧头的 bitrate_index。 */
export const MP3_BITRATES_V1_L3: readonly number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

/** MPEG2 / MPEG2.5 Layer III 的码率表（kbps）。 */
export const MP3_BITRATES_V2_L3: readonly number[] = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/** MPEG1 的采样率表（Hz）；索引即帧头的 sampling_rate_index。 */
export const MP3_SAMPLE_RATES_V1: readonly number[] = [44_100, 48_000, 32_000, 0];
/** MPEG2 的采样率表（Hz）。 */
export const MP3_SAMPLE_RATES_V2: readonly number[] = [22_050, 24_000, 16_000, 0];
/** MPEG2.5 的采样率表（Hz）。 */
export const MP3_SAMPLE_RATES_V25: readonly number[] = [11_025, 12_000, 8_000, 0];

/** MPEG1 Layer III 每帧的采样点数。 */
export const MP3_SAMPLES_PER_FRAME_V1: number = 1_152;
/** MPEG2 / MPEG2.5 Layer III 每帧的采样点数（半帧）。 */
export const MP3_SAMPLES_PER_FRAME_V2: number = 576;

/**
 * Xing/Info（VBR）头相对**帧头起点**的偏移，按 MPEG 版本与是否单声道分四档。
 * 编码器把这段塞在第一帧的边信息之后，位置由这两个维度决定，不是固定值。
 */
export const XING_OFFSET_V1_STEREO: number = 36;
/** 同上，MPEG1 单声道。 */
export const XING_OFFSET_V1_MONO: number = 21;
/** 同上，MPEG2/2.5 立体声。 */
export const XING_OFFSET_V2_STEREO: number = 21;
/** 同上，MPEG2/2.5 单声道。 */
export const XING_OFFSET_V2_MONO: number = 13;

/**
 * 寻找第一个有效帧头时允许扫描的最大字节数。
 *
 * 有界扫描而不是扫全文件：一首歌有几 MB，遇到不是 MP3 的载荷时逐字节扫到底
 * 只是白烧 CPU；正常 MP3 在跳过 ID3v2 之后第一帧就在开头几个字节内。
 */
export const MP3_FRAME_SCAN_MAX_BYTES: number = 8_192;
