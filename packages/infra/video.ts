import {
  MP4_BOX_HEADER_BYTES,
  MP4_BRAND_BYTES,
  MP4_FIXED_16_16_ONE,
  MP4_FOURCC_FTYP,
  MP4_FOURCC_HDLR,
  MP4_FOURCC_MDIA,
  MP4_FOURCC_MOOV,
  MP4_FOURCC_TKHD,
  MP4_FOURCC_TRAK,
  MP4_FTYP_BRANDS,
  MP4_FTYP_HEADER_BYTES,
  MP4_FTYP_MAX_BOX_BYTES,
  MP4_HANDLER_VIDE,
  MP4_HDLR_HANDLER_TYPE_OFFSET,
  MP4_LARGE_BOX_HEADER_BYTES,
  MP4_MAX_SCANNED_BOXES,
  MP4_TKHD_SIZE_OFFSETS,
} from "../consts/video";
import type { Mp4VideoTrack } from "../types/media";

/** 一个 box 的类型与载荷区间 [start, end)。 */
interface Mp4Box {
  readonly type: number;
  readonly start: number;
  readonly end: number;
}

/** 一次结构遍历的输入视图与各层合计还能读取的 box 数。 */
interface Mp4Scan {
  readonly view: DataView;
  remaining: number;
}

/** 一条轨道的处理类型（hdlr 的 handler_type）与 tkhd 展示宽高。 */
interface Mp4Track extends Mp4VideoTrack {
  readonly handler: number;
}

/**
 * 读 offset 处、不越过 end 的 box 头：长度字段 0 表示延伸到 end，1 表示取紧随其后的 64 位长度。
 * 头部不完整、长度短于头部或越过 end 时返回 null；返回的 box 至少占一个头部，调用方据此前进不会原地打转。
 */
function readBox(view: DataView, offset: number, end: number): Mp4Box | null {
  const remaining: number = end - offset;
  if (remaining < MP4_BOX_HEADER_BYTES) return null;
  const declared: number = view.getUint32(offset);
  const type: number = view.getUint32(offset + 4);
  if (declared === 0) return { type, start: offset + MP4_BOX_HEADER_BYTES, end };
  if (declared !== 1) {
    if (declared < MP4_BOX_HEADER_BYTES || declared > remaining) return null;
    return { type, start: offset + MP4_BOX_HEADER_BYTES, end: offset + declared };
  }
  if (remaining < MP4_LARGE_BOX_HEADER_BYTES) return null;
  const large: bigint = view.getBigUint64(offset + MP4_BOX_HEADER_BYTES);
  if (large < BigInt(MP4_LARGE_BOX_HEADER_BYTES) || large > BigInt(remaining)) return null;
  return { type, start: offset + MP4_LARGE_BOX_HEADER_BYTES, end: offset + Number(large) };
}

/** 读 [start, end) 内首尾相接、恰好铺满区间的 box，每读一个消耗一份预算；长度不合法或预算耗尽时返回 null。 */
function readBoxes(scan: Mp4Scan, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let offset: number = start;
  while (offset < end) {
    if (scan.remaining === 0) return null;
    scan.remaining--;
    const box: Mp4Box | null = readBox(scan.view, offset, end);
    if (box === null) return null;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

/** boxes 中类型为 type 的唯一一个；boxes 为 null、没有或不止一个时返回 null。 */
function onlyBox(boxes: readonly Mp4Box[] | null, type: number): Mp4Box | null {
  let found: Mp4Box | null = null;
  for (const box of boxes ?? []) {
    if (box.type !== type) continue;
    if (found !== null) return null;
    found = box;
  }
  return found;
}

/** ftyp 的主品牌或任一兼容品牌属于 MP4_FTYP_BRANDS；调用方已核对 ftypBytes 对齐且整段在输入范围内。 */
function declaresMp4Brand(view: DataView, ftypBytes: number): boolean {
  if (MP4_FTYP_BRANDS.has(view.getUint32(MP4_BOX_HEADER_BYTES))) return true;
  for (let offset: number = MP4_FTYP_HEADER_BYTES; offset < ftypBytes; offset += MP4_BRAND_BYTES) {
    if (MP4_FTYP_BRANDS.has(view.getUint32(offset))) return true;
  }
  return false;
}

/**
 * 读一条 trak：子 box 恰有一个 tkhd 与 mdia，mdia 的子 box 恰有一个 hdlr；tkhd 版本须在
 * MP4_TKHD_SIZE_OFFSETS 内且载荷容得下宽高，hdlr 载荷须容得下 handler_type。任一不满足返回 null。
 */
function readTrack(scan: Mp4Scan, trak: Mp4Box): Mp4Track | null {
  const view: DataView = scan.view;
  const children: Mp4Box[] | null = readBoxes(scan, trak.start, trak.end);
  const tkhd: Mp4Box | null = onlyBox(children, MP4_FOURCC_TKHD);
  const mdia: Mp4Box | null = onlyBox(children, MP4_FOURCC_MDIA);
  if (tkhd === null || mdia === null || tkhd.end === tkhd.start) return null;
  const hdlr: Mp4Box | null = onlyBox(readBoxes(scan, mdia.start, mdia.end), MP4_FOURCC_HDLR);
  if (hdlr === null || hdlr.end - hdlr.start < MP4_HDLR_HANDLER_TYPE_OFFSET + 4) return null;
  const sizeOffset: number | undefined = MP4_TKHD_SIZE_OFFSETS[view.getUint8(tkhd.start)];
  if (sizeOffset === undefined || tkhd.end - tkhd.start < sizeOffset + 8) return null;
  return {
    handler: view.getUint32(hdlr.start + MP4_HDLR_HANDLER_TYPE_OFFSET),
    width: view.getUint32(tkhd.start + sizeOffset) / MP4_FIXED_16_16_ONE,
    height: view.getUint32(tkhd.start + sizeOffset + 4) / MP4_FIXED_16_16_ONE,
  };
}

/**
 * 按容器结构解析 MP4，返回各视频轨（hdlr 为 `vide`）的展示宽高；不是合法 MP4 时返回 null，没有视频轨的
 * 合法 MP4 返回空数组。文件里的长度字段一律先核对再使用：
 * 1. 首个 box 是紧凑头部的 `ftyp`，长度在 [MP4_FTYP_HEADER_BYTES, MP4_FTYP_MAX_BOX_BYTES] 内、按品牌宽度
 *    对齐且整段在输入范围内，主品牌或兼容品牌之一属于 MP4_FTYP_BRANDS；
 * 2. 其后的顶层 box 恰好铺满输入，其中恰有一个 `moov`；moov、trak、mdia 的子 box 同样恰好铺满各自的
 *    载荷，每条 trak 的结构见 readTrack；
 * 3. ftyp 之后各层合计读取的 box 不超过 MP4_MAX_SCANNED_BOXES。
 * 任一长度不合法即判为否，不截断、不跳过，截断的下载因此也判否。不解析编码，素材能否作为头像由
 * Telegram 最终判定。
 */
export function readMp4VideoTracks(bytes: Uint8Array): readonly Mp4VideoTrack[] | null {
  if (bytes.byteLength < MP4_FTYP_HEADER_BYTES) return null;
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4) !== MP4_FOURCC_FTYP) return null;
  const ftypBytes: number = view.getUint32(0);
  if (ftypBytes < MP4_FTYP_HEADER_BYTES || ftypBytes > Math.min(MP4_FTYP_MAX_BOX_BYTES, view.byteLength)) return null;
  if ((ftypBytes - MP4_FTYP_HEADER_BYTES) % MP4_BRAND_BYTES !== 0 || !declaresMp4Brand(view, ftypBytes)) return null;
  const scan: Mp4Scan = { view, remaining: MP4_MAX_SCANNED_BOXES };
  const moov: Mp4Box | null = onlyBox(readBoxes(scan, ftypBytes, view.byteLength), MP4_FOURCC_MOOV);
  const movie: Mp4Box[] | null = moov === null ? null : readBoxes(scan, moov.start, moov.end);
  if (movie === null) return null;
  const videoTracks: Mp4VideoTrack[] = [];
  for (const box of movie) {
    if (box.type !== MP4_FOURCC_TRAK) continue;
    const track: Mp4Track | null = readTrack(scan, box);
    if (track === null) return null;
    if (track.handler === MP4_HANDLER_VIDE) videoTracks.push({ width: track.width, height: track.height });
  }
  return videoTracks;
}
