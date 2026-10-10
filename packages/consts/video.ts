/** ISO BMFF 文件类型 box 的四字符码 `ftyp`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_FTYP: number = 0x66_74_79_70;
/** 影片元数据 box 的四字符码 `moov`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_MOOV: number = 0x6d_6f_6f_76;
/** 轨道 box 的四字符码 `trak`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_TRAK: number = 0x74_72_61_6b;
/** 轨道头 box 的四字符码 `tkhd`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_TKHD: number = 0x74_6b_68_64;
/** 媒体 box 的四字符码 `mdia`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_MDIA: number = 0x6d_64_69_61;
/** 处理类型 box 的四字符码 `hdlr`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_FOURCC_HDLR: number = 0x68_64_6c_72;
/** hdlr 中视频轨的处理类型 `vide`，按大端 uint32 读取。所属模块：infra/video.ts。 */
export const MP4_HANDLER_VIDE: number = 0x76_69_64_65;

/** 一个品牌（四字符码）的字节数；ftyp 的主品牌与兼容品牌都按这个宽度排列。所属模块：infra/video.ts。 */
export const MP4_BRAND_BYTES: number = 4;
/** box 的紧凑头部字节数：4 字节长度与 4 字节类型。所属模块：infra/video.ts。 */
export const MP4_BOX_HEADER_BYTES: number = 8;
/** 长度字段为 1 时的扩展头部字节数：紧凑头部之后再跟 8 字节的 64 位长度。所属模块：infra/video.ts。 */
export const MP4_LARGE_BOX_HEADER_BYTES: number = 16;

/**
 * ftyp box 的固定部分字节数：紧凑头部、主品牌与 4 字节次版本号；兼容品牌从这个偏移开始排到 box 末尾。
 * 所属模块：infra/video.ts。
 */
export const MP4_FTYP_HEADER_BYTES: number = 16;
/**
 * ftyp box 允许的最大字节数：固定部分加 64 个兼容品牌。超出即按文件头不合法处理，品牌扫描的耗时
 * 因此有界。所属模块：infra/video.ts。
 */
export const MP4_FTYP_MAX_BOX_BYTES: number = MP4_FTYP_HEADER_BYTES + 64 * MP4_BRAND_BYTES;

/**
 * 结构遍历在 ftyp 之后各层（顶层、moov、trak、mdia）合计最多读取的 box 数；超出即按不是 MP4 处理，
 * 遍历次数因此有界。所属模块：infra/video.ts。
 */
export const MP4_MAX_SCANNED_BOXES: number = 4_096;

/** hdlr 载荷内 handler_type 的偏移：版本与标志 4 字节、pre_defined 4 字节之后。所属模块：infra/video.ts。 */
export const MP4_HDLR_HANDLER_TYPE_OFFSET: number = 8;
/**
 * 按 tkhd 版本号（0、1）索引的载荷内宽度字段偏移，高度紧随其后：版本与标志、时间与时长字段（版本 0 为
 * 32 位、版本 1 为 64 位）、保留字段、layer 等 4 个 16 位字段与 36 字节矩阵之后。其余版本不在表内。
 * 所属模块：infra/video.ts。
 */
export const MP4_TKHD_SIZE_OFFSETS: readonly number[] = [76, 88];
/** tkhd 宽高采用 16.16 定点数，原值除以此数得到像素。所属模块：infra/video.ts。 */
export const MP4_FIXED_16_16_ONE: number = 0x1_00_00;

/**
 * ftyp 里声明 MPEG-4 容器的品牌，按大端 uint32 存放（主品牌或兼容品牌命中其一即可）。
 * QuickTime（`qt  `）与 HEIF/AVIF 静态图片的品牌不在其中。所属模块：infra/video.ts。
 */
export const MP4_FTYP_BRANDS: ReadonlySet<number> = new Set([
  0x69_73_6f_6d, // isom
  0x69_73_6f_32, // iso2
  0x69_73_6f_33, // iso3
  0x69_73_6f_34, // iso4
  0x69_73_6f_35, // iso5
  0x69_73_6f_36, // iso6
  0x6d_70_34_31, // mp41
  0x6d_70_34_32, // mp42
  0x61_76_63_31, // avc1
  0x4d_34_56_20, // M4V
]);
