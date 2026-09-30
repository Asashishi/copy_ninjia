/**
 * 回复文本与手滑的纯函数：纯 emoji 判定、模型正文的引用标记与包裹清洗、单字错字构造，
 * 以及快速补字与「没发现」的概率分流。不经过工具集，也不需要 Telegram 替身。
 */
import { describe, expect, test } from "bun:test";
import { cleanReply, isEmojiOnly } from "../../../packages/aiChat/ai/utils/replyText";
import { buildCharacterTypo, pickTypoCorrectionMode } from "../../../packages/aiChat/ai/utils/typo";
import { TYPO_QUICK_CORRECTION_PROBABILITY } from "../../../packages/consts/aiChat/tools";

describe("isEmojiOnly", () => {
  test("纯 emoji（含多枚、空白、肤色/ZWJ 组合）判为 true", () => {
    expect(isEmojiOnly("😂")).toBe(true);
    expect(isEmojiOnly("😂😂 🤣")).toBe(true);
    expect(isEmojiOnly("👍🏻")).toBe(true);
    expect(isEmojiOnly("👨‍👩‍👧")).toBe(true);
  });

  test("带任何正文文字的消息判为 false", () => {
    expect(isEmojiOnly("笑死😂")).toBe(false);
    expect(isEmojiOnly("哈哈哈")).toBe(false);
    expect(isEmojiOnly("w😂w")).toBe(false);
  });

  test("纯数字/标点不含图形 emoji，判为 false（数字属于 emoji 组件，不能误伤）", () => {
    expect(isEmojiOnly("233")).toBe(false);
    expect(isEmojiOnly("？？？")).toBe(false);
  });
});

describe("cleanReply", () => {
  test("剥离行内引用标记，不吞掉标记之后无关括号包裹的正文（回归：过匹配曾把整段正文误删）", () => {
    const raw: string = "股价涨了[[1]](https://x.com/a)公司公告细节未知(具体后续待公布)大家再等等";
    expect(cleanReply(raw)).toBe("股价涨了公司公告细节未知(具体后续待公布)大家再等等");
  });

  test("URL 自身带一层平衡括号（维基百科消歧义链接式）时，整个链接连同引用标记一并剥离", () => {
    const raw: string = "参考[[2]](https://en.wikipedia.org/wiki/Foo_(bar))这个说法";
    expect(cleanReply(raw)).toBe("参考这个说法");
  });

  test("单条引用标记，标记前无空白、标记后紧跟空白分隔的正文", () => {
    const raw: string = "查了一下[[1]](https://example.com/path) 确实是这样";
    expect(cleanReply(raw)).toBe("查了一下 确实是这样");
  });

  test("多条引用标记全部剥离", () => {
    const raw: string = "一个说法[[1]](https://a.com)另一个说法[[2]](https://b.com)完了";
    expect(cleanReply(raw)).toBe("一个说法另一个说法完了");
  });

  test("没有引用标记时原样返回（去除首尾空白）", () => {
    expect(cleanReply("  普通回复，没有引用  ")).toBe("普通回复，没有引用");
  });

  test("全空白/清洗后为空返回 null", () => {
    expect(cleanReply("   ")).toBeNull();
  });

  test("剥掉包裹的代码块围栏与成对引号", () => {
    expect(cleanReply("```\n就这么点内容\n```")).toBe("就这么点内容");
    expect(cleanReply(`"带引号的话"`)).toBe("带引号的话");
  });
});

describe("buildCharacterTypo", () => {
  test("原字在 text 里存在时，替换出对应的错字版本", () => {
    expect(buildCharacterTypo("笨蛋", "蛋", "旦")).toEqual({ typoText: "笨旦", expected: "蛋", typo: "旦" });
    expect(buildCharacterTypo("看一下", "看", "砍")).toEqual({ typoText: "砍一下", expected: "看", typo: "砍" });
  });

  test("拒绝多字段、原字不在 text 里、或两字相同（模型主动选择不出错）", () => {
    expect(buildCharacterTypo("笨蛋", "笨蛋", "旦")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "旦丹")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "本", "旦")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "蛋")).toBeNull();
  });

  test("原字或错字是 emoji 时拒绝", () => {
    expect(buildCharacterTypo("笨蛋😂", "蛋", "旦")).toEqual({ typoText: "笨旦😂", expected: "蛋", typo: "旦" });
    expect(buildCharacterTypo("笨蛋😂", "😂", "😅")).toBeNull();
    expect(buildCharacterTypo("笨蛋", "蛋", "😅")).toBeNull();
  });
});

describe("pickTypoCorrectionMode", () => {
  test("低于 TYPO_QUICK_CORRECTION_PROBABILITY 补发正确单字，从该值起的其余部分当作没发现", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => TYPO_QUICK_CORRECTION_PROBABILITY - 1e-6;
      expect(pickTypoCorrectionMode()).toBe("quick");
      Math.random = () => TYPO_QUICK_CORRECTION_PROBABILITY;
      expect(pickTypoCorrectionMode()).toBe("ignore");
      Math.random = () => 0.999999;
      expect(pickTypoCorrectionMode()).toBe("ignore");
    } finally {
      Math.random = originalRandom;
    }
  });
});
