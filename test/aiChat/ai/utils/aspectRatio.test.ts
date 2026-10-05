/** 生图宽高比归一的供应商中立行为；请求映射与载荷提取见 test/aiChat/{gemini,openai}/image.test.ts。 */

import { describe, expect, test } from "bun:test";
import { normalizeImageAspectRatio } from "../../../../packages/aiChat/ai/utils/aspectRatio";
import { IMAGE_GENERATION_ASPECT_RATIOS } from "../../../../packages/consts/aiChat/imageGeneration";

describe("图片比例归一化", () => {
  test("官方比例原样保留", () => {
    for (const ratio of IMAGE_GENERATION_ASPECT_RATIOS) {
      expect(normalizeImageAspectRatio(ratio)).toBe(ratio);
    }
  });

  test("接受常见比例写法，并把非官方比例换成最接近的官方比例", () => {
    expect(normalizeImageAspectRatio("7:5")).toBe("4:3");
    expect(normalizeImageAspectRatio("10/7")).toBe("3:2");
    expect(normalizeImageAspectRatio("1920x1080")).toBe("16:9");
    expect(normalizeImageAspectRatio("1200×1500")).toBe("4:5");
  });

  test("拒绝缺边、非数字与非正数比例", () => {
    expect(normalizeImageAspectRatio("16")).toBeNull();
    expect(normalizeImageAspectRatio("wide:tall")).toBeNull();
    expect(normalizeImageAspectRatio("0:1")).toBeNull();
    expect(normalizeImageAspectRatio("-1:1")).toBeNull();
  });
});
