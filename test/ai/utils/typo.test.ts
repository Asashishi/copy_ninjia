import { describe, expect, test } from "bun:test";
import { buildCharacterTypo } from "../../../packages/ai/utils/typo";

/** 分解写法的 が = か(U+304B) + 浊点(U+3099)，两个码点、一个字素簇。 */
const DECOMPOSED_GA: string = "が";

describe("buildCharacterTypo", () => {
  test("按字素簇替换，不会拆开组合序列", () => {
    // 按码点切会命中「か」这个还挂着浊点的基字，替换后浊点留在原地：换出来的
    // 字跟模型说的「原字/错字」对不上，基字不搭配时更是直接发出一条乱码。
    const text: string = `${DECOMPOSED_GA}んばって`;

    expect(buildCharacterTypo(text, "か", "き")).toBeNull();

    const typo = buildCharacterTypo(text, DECOMPOSED_GA, "き");
    expect(typo).toEqual({ typoText: "きんばって", expected: DECOMPOSED_GA, typo: "き" });
  });

  test("普通单字照常替换第一个出现位置", () => {
    expect(buildCharacterTypo("今天天气不错", "天", "田")).toEqual({
      typoText: "今田天气不错",
      expected: "天",
      typo: "田",
    });
  });

  test("两个字长度不为 1、相同、含空白或含 emoji 时拒绝", () => {
    expect(buildCharacterTypo("今天天气不错", "今天", "昨天")).toBeNull();
    expect(buildCharacterTypo("今天天气不错", "天", "天")).toBeNull();
    expect(buildCharacterTypo("今天 天气", " ", "　")).toBeNull();
    expect(buildCharacterTypo("今天天气不错", "天", "😂")).toBeNull();
  });

  test("原字不在文本里时返回 null", () => {
    expect(buildCharacterTypo("今天天气不错", "雨", "雪")).toBeNull();
  });
});
