import { describe, expect, test } from "bun:test";
import {
  ANIMATED_WEBP_FIRST_FRAME,
  animatedGifFixture,
  animatedLossyAlphaWebpFixture,
  animatedLossyOpaqueWebpFixture,
  animatedWebpFixture,
  decodePngRgba,
  gifClaimingBytes,
  imageFixture,
  le24,
  riffChunkBytes,
  vp8lHeaderBytes,
  webpContainerBytes,
} from "../helpers/image";
import { VISION_TRANSCODE_MAX_PIXELS, WEBP_MAX_SCANNED_CHUNKS } from "../../packages/consts/image";

const { firstAnimatedWebpFrame, prepareVisionImage, sniffImageFormat } = await import("../../packages/infra/image");

async function tinyPng(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).png().bytes();
}
async function tinyJpeg(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).jpeg().bytes();
}
async function tinyWebp(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).webp().bytes();
}
async function tinyGif(): Promise<Uint8Array> {
  return animatedGifFixture();
}

describe("infra/image sniffImageFormat", () => {
  test("识别 png/jpeg/webp/gif 的文件头魔数", async () => {
    expect(sniffImageFormat(await tinyPng())).toBe("png");
    expect(sniffImageFormat(await tinyJpeg())).toBe("jpeg");
    expect(sniffImageFormat(await tinyWebp())).toBe("webp");
    expect(sniffImageFormat(await tinyGif())).toBe("gif");
  });

  test("不认识的字节返回 unknown", () => {
    expect(sniffImageFormat(new TextEncoder().encode("not an image, just text"))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array([0x01, 0x02]))).toBe("unknown");
  });

  test("Uint8Array 子视图只读取可见区间", () => {
    const bytes: Uint8Array = new Uint8Array([
      0,
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
    ]);
    expect(sniffImageFormat(bytes.subarray(1, 9))).toBe("png");
    expect(sniffImageFormat(bytes)).toBe("unknown");
  });
});

describe("infra/image prepareVisionImage", () => {
  test("jpeg/png 原样直通，不经过转码", async () => {
    const jpeg: Uint8Array = await tinyJpeg();
    const jpegResult = await prepareVisionImage(jpeg);
    expect(jpegResult?.mime).toBe("image/jpeg");
    expect(jpegResult?.bytes).toBe(jpeg); // 同一个引用，说明没有走转码分支

    const png: Uint8Array = await tinyPng();
    const pngResult = await prepareVisionImage(png);
    expect(pngResult?.mime).toBe("image/png");
    expect(pngResult?.bytes).toBe(png);
  });

  test("webp 转码为 png", async () => {
    const result = await prepareVisionImage(await tinyWebp());
    expect(result?.mime).toBe("image/png");
    expect(result && sniffImageFormatOfResult(result.bytes)).toBe("png");
  });

  test("gif 转码为 png（只取第一帧）", async () => {
    const result = await prepareVisionImage(await tinyGif());
    expect(result?.mime).toBe("image/png");
    expect(result && sniffImageFormatOfResult(result.bytes)).toBe("png");
    const firstFrame: Uint8Array = imageFixture(2, 2);
    for (const offset of [54, 57, 62, 65]) {
      firstFrame.set([0, 255, 255], offset);
    }
    const expected: Uint8Array = await new Bun.Image(firstFrame).png().bytes();
    expect(decodePngRgba(result!.bytes)).toEqual(decodePngRgba(expected));
  });

  test("动态 webp 读取第一帧并保留透明度", async () => {
    const result = await prepareVisionImage(animatedWebpFixture());
    expect(result?.mime).toBe("image/png");
    const frame = decodePngRgba(result!.bytes);
    expect([frame.width, frame.height]).toEqual([2, 1]);
    expect(frame.rgba).toEqual(new Uint8Array(ANIMATED_WEBP_FIRST_FRAME));
  });

  test("有损动态 webp 按首帧的 VP8 与 ALPH 解码，保留首帧尺寸与透明度", async () => {
    const withAlpha = decodePngRgba((await prepareVisionImage(animatedLossyAlphaWebpFixture()))!.bytes);
    expect([withAlpha.width, withAlpha.height]).toEqual([2, 1]);
    expect([withAlpha.rgba[3], withAlpha.rgba[7]]).toEqual([255, 128]);
    const opaque = decodePngRgba((await prepareVisionImage(animatedLossyOpaqueWebpFixture()))!.bytes);
    expect([opaque.width, opaque.height]).toEqual([2, 1]);
    expect([opaque.rgba[3], opaque.rgba[7]]).toEqual([255, 255]);
  });

  test("静态 webp 不经首帧抽取，结构损坏的动态 webp 返回 null", async () => {
    expect(firstAnimatedWebpFrame(await tinyWebp())).toBeNull();
    const animated: Uint8Array = animatedWebpFixture();
    const truncated: Uint8Array = animated.slice(0, 60);
    expect(firstAnimatedWebpFrame(truncated)).toBeNull();
    expect(await prepareVisionImage(truncated)).toBeNull();
  });

  test("转码只消费子视图的可见字节且保持输入不变", async () => {
    const webp: Uint8Array = await tinyWebp();
    const source: Uint8Array = new Uint8Array(webp.length + 8).fill(42);
    source.set(webp, 4);
    const snapshot: Uint8Array = source.slice();
    const result = await prepareVisionImage(source.subarray(4, 4 + webp.length));
    expect(result?.bytes).toEqual((await prepareVisionImage(webp))?.bytes);
    expect(source).toEqual(snapshot);
  });

  test("损坏的 webp/gif 在转码边界返回 null", async () => {
    expect(await prepareVisionImage((await tinyWebp()).subarray(0, 12))).toBeNull();
    expect(await prepareVisionImage((await tinyGif()).subarray(0, 6))).toBeNull();
  });

  test("不支持/无法识别的格式返回 null", async () => {
    expect(await prepareVisionImage(new TextEncoder().encode("garbage"))).toBeNull();
  });
});

/** 固定种子的线性同余序列，让变异用例可复现。 */
function seededRandom(seed: number): () => number {
  let state: number = seed;
  return (): number => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}

/** 对样图做字节翻转、截断或伪造块长度，产生一个畸形输入。 */
function mutate(input: Uint8Array, random: () => number): Uint8Array {
  const bytes: Uint8Array = input.slice(0, Math.max(1, Math.floor(input.length * (random() < 0.3 ? random() : 1))));
  for (let flips: number = 1 + Math.floor(random() * 6); flips > 0; flips--) {
    const index: number = Math.floor(random() * bytes.length);
    bytes[index] = bytes[index]! ^ (1 << Math.floor(random() * 8));
  }
  if (bytes.length > 20 && random() < 0.3) {
    const offset: number = 12 + Math.floor(random() * (bytes.length - 20));
    new DataView(bytes.buffer).setUint32(offset + 4, random() < 0.5 ? 0xffff_ffff : Math.floor(random() * 2 ** 20), true);
  }
  return bytes;
}

/** 首帧为 2×2 VP8L 的动态 WebP，ANMF 之前插入 junk 个零长度未知块。 */
function animatedWebpWithJunk(junk: number): Uint8Array {
  const chunks: number[][] = [riffChunkBytes("VP8X", [0x12, 0, 0, 0, ...le24(1), ...le24(1)])];
  for (let index: number = 0; index < junk; index++) chunks.push(riffChunkBytes("JUNK", []));
  chunks.push(riffChunkBytes("ANMF", [
    ...le24(0), ...le24(0), ...le24(1), ...le24(1), ...le24(100), 0, ...riffChunkBytes("VP8L", vp8lHeaderBytes(2, 2)),
  ]));
  return webpContainerBytes(chunks);
}

describe("infra/image 不可信输入", () => {
  test("头部声明超过 VISION_TRANSCODE_MAX_PIXELS 的 webp/gif 在分配像素前被拒绝", async () => {
    const width: number = 16_383;
    const height: number = Math.ceil((VISION_TRANSCODE_MAX_PIXELS + 1) / width);
    expect(await prepareVisionImage(webpContainerBytes([riffChunkBytes("VP8L", vp8lHeaderBytes(width, height))]))).toBeNull();
    expect(await prepareVisionImage(gifClaimingBytes(65_535, 65_535))).toBeNull();
    // 逻辑屏幕超大而首帧只有 1×1 时按首帧尺寸解码，不为整块屏幕分配像素。
    const screenOnly = await prepareVisionImage(gifClaimingBytes(65_535, 1));
    expect(screenOnly === null ? null : [decodePngRgba(screenOnly.bytes).width, decodePngRgba(screenOnly.bytes).height])
      .toEqual([1, 1]);
    // 帧头声明 2×2、帧内码流声明超大尺寸：抽出的静态 WebP 仍按码流尺寸受像素上限约束。
    const hidden: Uint8Array = webpContainerBytes([
      riffChunkBytes("VP8X", [0x12, 0, 0, 0, ...le24(1), ...le24(1)]),
      riffChunkBytes("ANMF", [
        ...le24(0), ...le24(0), ...le24(1), ...le24(1), ...le24(100), 0,
        ...riffChunkBytes("VP8L", vp8lHeaderBytes(width, height)),
      ]),
    ]);
    expect(firstAnimatedWebpFrame(hidden)).not.toBeNull();
    expect(await prepareVisionImage(hidden)).toBeNull();
  });

  test("块长度越界或 ANMF 帧头不足时不抽帧", () => {
    expect(firstAnimatedWebpFrame(webpContainerBytes([riffChunkBytes("ANMF", [1, 2, 3, 4], 0xffff_ffff)]))).toBeNull();
    expect(firstAnimatedWebpFrame(webpContainerBytes([riffChunkBytes("ANMF", new Array<number>(15).fill(0))]))).toBeNull();
    expect(firstAnimatedWebpFrame(webpContainerBytes([
      riffChunkBytes("ANMF", [...new Array<number>(16).fill(0), ...riffChunkBytes("VP8L", [1, 2], 0xffff_ffff)]),
    ]))).toBeNull();
  });

  test("首个 ANMF 之前的块数达到扫描上限即放弃抽帧", () => {
    expect(firstAnimatedWebpFrame(animatedWebpWithJunk(WEBP_MAX_SCANNED_CHUNKS - 2))).not.toBeNull();
    expect(firstAnimatedWebpFrame(animatedWebpWithJunk(WEBP_MAX_SCANNED_CHUNKS - 1))).toBeNull();
  });

  test("变异输入下首帧抽取不抛错、输出不超过输入，完整转码只得到 null 或 png", async () => {
    const random: () => number = seededRandom(20_260_928);
    const seeds: readonly Uint8Array[] = [
      animatedWebpFixture(), animatedLossyAlphaWebpFixture(), animatedLossyOpaqueWebpFixture(),
      await tinyWebp(), animatedGifFixture(),
    ];
    for (let round: number = 0; round < 2_000; round++) {
      const input: Uint8Array = mutate(seeds[round % seeds.length]!, random);
      const frame: Uint8Array | null = firstAnimatedWebpFrame(input);
      if (frame !== null) expect(frame.length).toBeLessThanOrEqual(input.length + 64);
      if (round % 10 === 0) {
        const result = await prepareVisionImage(input);
        if (result !== null) expect(result.mime).toBe("image/png");
      }
    }
  });
});

function sniffImageFormatOfResult(bytes: Uint8Array): string {
  return sniffImageFormat(bytes);
}
