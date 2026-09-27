/**
 * 视觉转码单张图片允许解码的最大像素数（宽 × 高），按 8K UHD（7680 × 4320）取值；超出时
 * `Bun.Image` 在读完文件头、分配像素缓冲之前拒绝，这张图按「不解析」处理。单次解码的 RGBA
 * 缓冲因此不超过约 133 MB，挡住文件很小、头部声明超大画布的解压炸弹。
 * 所属模块：infra/image.ts。
 */
export const VISION_TRANSCODE_MAX_PIXELS: number = 7_680 * 4_320;

/** RIFF 容器首个四字符码 `RIFF`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_RIFF: number = 0x46_46_49_52;
/** WebP 文件的 RIFF 形式类型 `WEBP`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_WEBP: number = 0x50_42_45_57;
/** 扩展格式头块 `VP8X`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_VP8X: number = 0x58_38_50_56;
/** 动画帧块 `ANMF`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_ANMF: number = 0x46_4d_4e_41;
/** 有损帧的透明通道块 `ALPH`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_ALPH: number = 0x48_50_4c_41;
/** 有损图像码流块 `VP8 `（末位是空格），按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_VP8: number = 0x20_38_50_56;
/** 无损图像码流块 `VP8L`，按小端 uint32 读写。所属模块：infra/image.ts。 */
export const WEBP_FOURCC_VP8L: number = 0x4c_38_50_56;
/** 一帧里可以直接解码的图像码流块；首个命中者即该帧图像。所属模块：infra/image.ts。 */
export const WEBP_FRAME_IMAGE_FOURCCS: readonly number[] = [WEBP_FOURCC_VP8L, WEBP_FOURCC_VP8];

/**
 * 在一个区间内查找目标块时最多检查的块数。合法的动态 WebP 在首个 ANMF 之前只有 VP8X、ICCP、
 * ANIM 等少数几块，帧内只有 ALPH 与图像码流；超出即按容器不合法处理，使特制的海量零长度块
 * 不会让同步扫描随文件长度占用 Worker 线程。所属模块：infra/image.ts。
 */
export const WEBP_MAX_SCANNED_CHUNKS: number = 64;

/** RIFF 容器头 `RIFF` + 长度 + `WEBP` 的字节数，其后才是第一个块。所属模块：infra/image.ts。 */
export const WEBP_CONTAINER_HEADER_BYTES: number = 12;
/** RIFF 块头（四字符码 + 小端 uint32 载荷长度）的字节数。所属模块：infra/image.ts。 */
export const RIFF_CHUNK_HEADER_BYTES: number = 8;
/**
 * ANMF 载荷里帧头的字节数：X/Y 偏移、宽减一、高减一、帧时长各 24 位小端，再加一个标志字节；
 * 帧头之后才是该帧的 ALPH/VP8/VP8L 子块。所属模块：infra/image.ts。
 */
export const WEBP_ANMF_HEADER_BYTES: number = 16;
/** ANMF 帧头里「宽减一、高减一」共 6 字节的起始偏移，与 VP8X 画布尺寸字段同形。所属模块：infra/image.ts。 */
export const WEBP_ANMF_SIZE_OFFSET: number = 6;
/** VP8X 载荷的字节数：标志字节、3 字节保留、画布宽减一与高减一各 24 位小端。所属模块：infra/image.ts。 */
export const WEBP_VP8X_PAYLOAD_BYTES: number = 10;
/** VP8X 载荷中画布尺寸字段的起始偏移。所属模块：infra/image.ts。 */
export const WEBP_VP8X_SIZE_OFFSET: number = 4;
/** VP8X 标志字节中「含透明通道」位。所属模块：infra/image.ts。 */
export const WEBP_VP8X_ALPHA_FLAG: number = 0x10;
