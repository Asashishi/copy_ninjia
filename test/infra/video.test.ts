import { describe, expect, test } from "bun:test";
import {
  MP4_BRAND_BYTES,
  MP4_FTYP_HEADER_BYTES,
  MP4_FTYP_MAX_BOX_BYTES,
  MP4_MAX_SCANNED_BOXES,
} from "../../packages/consts/video";
import { readMp4VideoTracks } from "../../packages/infra/video";
import type { Mp4VideoTrack } from "../../packages/types/media";
import {
  MOOV_BOX,
  MP4_BYTES,
  ftypBox,
  hdlrBox,
  moovBox,
  mp4Box,
  mp4LargeBox,
  tkhdBox,
  trakBox,
} from "../helpers/mp4";

/** 主品牌 isom、不带兼容品牌的 ftyp。 */
const ISOM_FTYP: Uint8Array = ftypBox({ major: "isom" });
/** ftyp 固定部分之后最多容纳的兼容品牌个数。 */
const MAX_COMPATIBLE_BRANDS: number = (MP4_FTYP_MAX_BOX_BYTES - MP4_FTYP_HEADER_BYTES) / MP4_BRAND_BYTES;
/** MOOV_BOX 内唯一一条视频轨的尺寸。 */
const MOOV_TRACKS: readonly Mp4VideoTrack[] = [{ width: 800, height: 800 }];

/** 把各段 box 首尾拼接后解析。 */
function tracksOf(parts: readonly Uint8Array[]): readonly Mp4VideoTrack[] | null {
  return readMp4VideoTracks(Bun.concatArrayBuffers([...parts], Infinity, true));
}

/** 只含给定子 box 的 trak。 */
function rawTrak(...children: readonly Uint8Array[]): Uint8Array {
  return mp4Box("trak", Bun.concatArrayBuffers([...children], Infinity, true));
}

describe("infra/video readMp4VideoTracks 品牌", () => {
  test("主品牌属于 MP4 品牌、其后有 moov 时解析成功", () => {
    expect(readMp4VideoTracks(MP4_BYTES)).toEqual(MOOV_TRACKS);
    expect(tracksOf([ftypBox({ major: "mp42" }), MOOV_BOX])).toEqual(MOOV_TRACKS);
  });

  test("主品牌不认识、兼容品牌含 MP4 品牌时解析成功", () => {
    expect(tracksOf([ftypBox({ major: "dash", compatible: ["iso6", "mp41"] }), MOOV_BOX])).toEqual(MOOV_TRACKS);
  });

  test("QuickTime 与 HEIF/AVIF 静态图不算 MP4", () => {
    for (const ftyp of [
      ftypBox({ major: "qt  ", compatible: ["qt  "] }),
      ftypBox({ major: "avif", compatible: ["avif", "mif1", "miaf", "MA1B"] }),
      ftypBox({ major: "heic", compatible: ["mif1", "heic"] }),
    ]) {
      expect(tracksOf([ftyp, MOOV_BOX])).toBeNull();
    }
  });
});

describe("infra/video readMp4VideoTracks ftyp 长度", () => {
  test("首个 box 不是 ftyp 或输入短于 ftyp 固定部分时判否", () => {
    expect(tracksOf([mp4Box("free", new Uint8Array(8)), MOOV_BOX])).toBeNull();
    expect(readMp4VideoTracks(MP4_BYTES.subarray(0, MP4_FTYP_HEADER_BYTES - 1))).toBeNull();
    expect(readMp4VideoTracks(new Uint8Array(0))).toBeNull();
  });

  test("声明长度短于固定部分、长于上限、未按品牌宽度对齐或越过输入末尾时判否", () => {
    const tooMany: readonly string[] = Array.from({ length: MAX_COMPATIBLE_BRANDS + 1 }, (): string => "isom");
    for (const ftyp of [
      ftypBox({ major: "isom", declaredBytes: 0 }),
      ftypBox({ major: "isom", declaredBytes: 1 }),
      ftypBox({ major: "isom", declaredBytes: MP4_FTYP_HEADER_BYTES - 1 }),
      ftypBox({ major: "isom", compatible: tooMany }),
      ftypBox({ major: "isom", compatible: ["isom"], declaredBytes: MP4_FTYP_HEADER_BYTES + 2 }),
      ftypBox({ major: "isom", declaredBytes: 0xff_ff_ff_ff }),
    ]) {
      expect(tracksOf([ftyp, MOOV_BOX])).toBeNull();
    }
  });

  test("兼容品牌恰好排满上限时仍会全部检查", () => {
    const filler: readonly string[] = Array.from({ length: MAX_COMPATIBLE_BRANDS - 1 }, (): string => "zzzz");
    expect(tracksOf([ftypBox({ major: "dash", compatible: [...filler, "isom"] }), MOOV_BOX])).toEqual(MOOV_TRACKS);
  });

  test("只认声明范围内的兼容品牌", () => {
    // ftyp 只声明固定部分，后面的 iso6 落在下一个 box 的位置上，不算品牌。
    const ftyp: Uint8Array = ftypBox({ major: "dash", compatible: ["iso6"], declaredBytes: MP4_FTYP_HEADER_BYTES });
    expect(tracksOf([ftyp, MOOV_BOX])).toBeNull();
  });
});

describe("infra/video readMp4VideoTracks 顶层 box", () => {
  test("没有 moov 或不止一个 moov 时判否：文件头后接任意字节不算 MP4", () => {
    expect(readMp4VideoTracks(ISOM_FTYP)).toBeNull();
    expect(tracksOf([ISOM_FTYP, new TextEncoder().encode("<!DOCTYPE html><html></html>")])).toBeNull();
    expect(tracksOf([ISOM_FTYP, MOOV_BOX, MOOV_BOX])).toBeNull();
  });

  test("moov 在 mdat 之后、长度字段为 0 或 64 位长度时都能走到", () => {
    expect(tracksOf([ISOM_FTYP, mp4Box("free"), mp4Box("mdat", new Uint8Array(16)), MOOV_BOX])).toEqual(MOOV_TRACKS);
    expect(tracksOf([ISOM_FTYP, mp4LargeBox("mdat", new Uint8Array(16)), MOOV_BOX])).toEqual(MOOV_TRACKS);
    expect(tracksOf([ISOM_FTYP, mp4Box("moov", MOOV_BOX.subarray(8), 0)])).toEqual(MOOV_TRACKS);
  });

  test("延伸到末尾的 mdat 之后不会再有 moov", () => {
    expect(tracksOf([ISOM_FTYP, mp4Box("mdat", new Uint8Array(4), 0), MOOV_BOX])).toBeNull();
  });

  test("moov 之后的 box 被截断或末尾残留不足一个头部时判否", () => {
    const parts: readonly Uint8Array[] = [ISOM_FTYP, MOOV_BOX, mp4Box("mdat", new Uint8Array(32))];
    const moovFirst: Uint8Array = Bun.concatArrayBuffers([...parts], Infinity, true);
    expect(readMp4VideoTracks(moovFirst)).toEqual(MOOV_TRACKS);
    expect(readMp4VideoTracks(moovFirst.subarray(0, moovFirst.length - 1))).toBeNull();
    expect(tracksOf([MP4_BYTES, new Uint8Array(7)])).toBeNull();
  });

  test("box 长度短于头部、越过输入末尾或头部不完整时判否，不会原地打转", () => {
    for (const declared of [2, 7]) {
      expect(tracksOf([ISOM_FTYP, mp4Box("free", new Uint8Array(0), declared), MOOV_BOX])).toBeNull();
    }
    expect(tracksOf([ISOM_FTYP, mp4Box("moov", MOOV_BOX.subarray(8), MOOV_BOX.length + 4)])).toBeNull();
    expect(tracksOf([ISOM_FTYP, MOOV_BOX.subarray(0, 7)])).toBeNull();
  });

  test("64 位长度短于扩展头部、越过输入末尾或扩展头部不完整时判否", () => {
    for (const large of [0n, 15n, 1n << 40n]) {
      expect(tracksOf([ISOM_FTYP, mp4LargeBox("mdat", new Uint8Array(0), large), MOOV_BOX])).toBeNull();
    }
    expect(tracksOf([ISOM_FTYP, MOOV_BOX, mp4LargeBox("free").subarray(0, 12)])).toBeNull();
  });

  test("各层合计读取的 box 不超过 MP4_MAX_SCANNED_BOXES 个", () => {
    // MOOV_BOX 本身占 1 个顶层 box，内部 trak、tkhd、mdia、hdlr 再占 4 个。
    const frees: readonly Uint8Array[] = Array.from(
      { length: MP4_MAX_SCANNED_BOXES - 5 },
      (): Uint8Array => mp4Box("free")
    );
    expect(tracksOf([ISOM_FTYP, MOOV_BOX, ...frees])).toEqual(MOOV_TRACKS);
    expect(tracksOf([ISOM_FTYP, MOOV_BOX, ...frees, mp4Box("free")])).toBeNull();
  });

  test("非零 byteOffset 的视图按视图范围读取", () => {
    const backing: Uint8Array = Bun.concatArrayBuffers([new Uint8Array(3), MP4_BYTES, MOOV_BOX], Infinity, true);
    expect(readMp4VideoTracks(backing.subarray(3, 3 + MP4_BYTES.length))).toEqual(MOOV_TRACKS);
    // 视图之外紧跟的 moov 不算：截掉视图内的 moov 后应判否。
    expect(readMp4VideoTracks(backing.subarray(3, 3 + MP4_BYTES.length - MOOV_BOX.length))).toBeNull();
    // 视图之前的字节同样不读：视图从 ftyp 之后开始时判否。
    expect(readMp4VideoTracks(backing.subarray(3 + ISOM_FTYP.length))).toBeNull();
  });
});

describe("infra/video readMp4VideoTracks 轨道", () => {
  test("只返回 hdlr 为 vide 的轨道；没有视频轨时返回空数组", () => {
    const audio: Uint8Array = trakBox({ width: 0, height: 0, handler: "soun" });
    expect(tracksOf([ISOM_FTYP, moovBox(trakBox({ width: 640, height: 640 }), audio)])).toEqual([
      { width: 640, height: 640 },
    ]);
    expect(tracksOf([ISOM_FTYP, moovBox(audio)])).toEqual([]);
    expect(tracksOf([ISOM_FTYP, moovBox()])).toEqual([]);
  });

  test("按 16.16 定点读取 tkhd 版本 0 与版本 1 的宽高", () => {
    expect(tracksOf([ISOM_FTYP, moovBox(trakBox({ width: 1_920, height: 1_080, tkhdVersion: 1 }))])).toEqual([
      { width: 1_920, height: 1_080 },
    ]);
    expect(tracksOf([ISOM_FTYP, moovBox(trakBox({ width: 800.5, height: 600.25 }))])).toEqual([
      { width: 800.5, height: 600.25 },
    ]);
  });

  test("tkhd 版本未知、为空或载荷容不下宽高时判否", () => {
    const mdia: Uint8Array = mp4Box("mdia", hdlrBox("vide"));
    const tkhdV1: Uint8Array = tkhdBox(800, 800, 1);
    const truncatedV1: Uint8Array = mp4Box("tkhd", tkhdV1.subarray(8, tkhdV1.length - 1));
    for (const tkhd of [tkhdBox(800, 800, 2), mp4Box("tkhd"), truncatedV1]) {
      expect(tracksOf([ISOM_FTYP, moovBox(rawTrak(tkhd, mdia))])).toBeNull();
    }
  });

  test("trak 缺少或重复 tkhd、mdia，mdia 缺少 hdlr 或 hdlr 过短时判否", () => {
    const tkhd: Uint8Array = tkhdBox(800, 800);
    const mdia: Uint8Array = mp4Box("mdia", hdlrBox("vide"));
    for (const trak of [
      rawTrak(mdia),
      rawTrak(tkhd),
      rawTrak(tkhd, tkhd, mdia),
      rawTrak(tkhd, mdia, mdia),
      rawTrak(tkhd, mp4Box("mdia")),
      rawTrak(tkhd, mp4Box("mdia", mp4Box("hdlr", new Uint8Array(11)))),
    ]) {
      expect(tracksOf([ISOM_FTYP, moovBox(trak)])).toBeNull();
    }
  });

  test("moov 与 trak 的子 box 未恰好铺满载荷时判否", () => {
    const trak: Uint8Array = trakBox({ width: 800, height: 800 });
    expect(tracksOf([ISOM_FTYP, mp4Box("moov", Bun.concatArrayBuffers([trak, new Uint8Array(4)], Infinity, true))]))
      .toBeNull();
    expect(tracksOf([ISOM_FTYP, moovBox(rawTrak(trak.subarray(8), new Uint8Array(4)))])).toBeNull();
  });
});
