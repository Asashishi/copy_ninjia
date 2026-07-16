import { describe, expect, mock, test } from "bun:test";

/**
 * ai/replyTools.ts 经 infra/telegram -> infra/logger -> infra/diskIO，后者在
 * 模块顶层就会 `new Worker(...)`：单测里绝不能让它真的跑起来（理由同
 * test/commands/luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 * 本文件只测 cleanReply 纯函数；工具集的贴纸分支逻辑在 test/ai/stickers.test.ts，
 * 发送/反应分支依赖真实 Telegram 调用，由手动验证覆盖。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { cleanReply, isEmojiOnly } = await import("../../src/ai/tools/replyToolset");

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
