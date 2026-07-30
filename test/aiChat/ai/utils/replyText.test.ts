import { describe, expect, test } from "bun:test";
import { cleanReply, isEmojiOnly } from "../../../../packages/aiChat/ai/utils/replyText";

describe("isEmojiOnly", () => {
  test("含数字/井号/星号的正常回复不是纯表情", () => {
    // \p{Emoji_Component} 按 Unicode 定义包含 ASCII 0-9、#、*，直接拿它当
    // 「允许出现的附属码点」会把这些全判成纯表情。后果有两级：send_message
    // 拒绝这类回复；更糟的是最终正文兜底走同一个执行器，模型的全部输出正好
    // 是这样一句时工具报错、actionsUsed() 停在 0，机器人对着一条 @ 提及完全沉默。
    for (const text of ["🎉2026", "🎂 30", "👍 #1", "😂233", "2026🎉年", "🎉abc"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });

  test("纯 emoji（含肤色、ZWJ 组合、变体选择符、keycap）仍判为纯表情", () => {
    for (const text of ["👍", "👍🏻", "👨‍👩‍👦", "❤️", "😂😂😂", "👍 👍", "1️⃣", "1️⃣2️⃣"]) {
      expect(isEmojiOnly(text)).toBeTrue();
    }
  });

  test("旗帜（区域指示符）也算 emoji 本体", () => {
    // 区域指示符既不是 Extended_Pictographic、也不在附属码点里，漏列时 send_message
    // 的拦截失效，机器人会直接把一条纯表情文本发进群里。
    for (const text of ["🇯🇵", "👍🇯🇵", "🇯🇵🇺🇸", "🇯🇵 👍"]) {
      expect(isEmojiOnly(text)).toBeTrue();
    }
    // 旗帜混在正文里仍然不是纯表情。
    for (const text of ["日本🇯🇵", "🇯🇵 加油"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });

  test("没有任何图形 emoji 的文本不是纯表情", () => {
    for (const text of ["", "   ", "abc", "1", "#", "233"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });
});

describe("cleanReply 的引号剥离", () => {
  test("首尾引号分属两对时不剥：那会把正文两头各啃掉一个字", () => {
    // 剥完的字符串就是最终发进群里的正文。
    expect(cleanReply("「早安」和「晚安」")).toBe("「早安」和「晚安」");
    expect(cleanReply('"A"和"B"')).toBe('"A"和"B"');
    expect(cleanReply("“是”还是“否”")).toBe("“是”还是“否”");
  });

  test("真被一对引号包住时照常剥掉", () => {
    expect(cleanReply("「只是一句话」")).toBe("只是一句话");
    expect(cleanReply('"quoted"')).toBe("quoted");
    expect(cleanReply("“整句都在里面”")).toBe("整句都在里面");
    // 嵌套的内层引号不影响外层判定。
    expect(cleanReply("「他说「你好」了」")).toBe("他说「你好」了");
  });

  test("引号只在一头时不动", () => {
    expect(cleanReply("他说「你好」")).toBe("他说「你好」");
    expect(cleanReply("「开头有")).toBe("「开头有");
  });
});
