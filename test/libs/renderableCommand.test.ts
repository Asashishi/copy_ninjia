import { describe, expect, test } from "bun:test";
import {
  containsRenderableCommand,
  neutralizeRenderableCommands,
} from "../../packages/libs/renderableCommand";

describe("libs/renderableCommand containsRenderableCommand", () => {
  test("行首与空白后的命令照常命中", () => {
    expect(containsRenderableCommand("/batch_kick 1d")).toBe(true);
    expect(containsRenderableCommand("x /batch_kick 1d")).toBe(true);
    expect(containsRenderableCommand("换行\n/batch_kick 1d")).toBe(true);
    // U+0085 (NEL) 不属于 JS 的 \s，但同样是非 word 字符
    expect(containsRenderableCommand("A/batch_kick 1d")).toBe(true);
  });

  test("回归：标点、引号、中文前缀同样会被 Telegram 渲染成命令，必须命中", () => {
    // 左界改宽之前这四种全部漏判，让 AI「原样复述」即可绕过整套守卫。
    expect(containsRenderableCommand("「/batch_kick 1d」")).toBe(true);
    expect(containsRenderableCommand("（/batch_kick 1d）")).toBe(true);
    expect(containsRenderableCommand("喵，/batch_kick 1d")).toBe(true);
    expect(containsRenderableCommand("\"/batch_kick 1d\"")).toBe(true);
  });

  test("前一个字符是 word 字符时不成实体，不命中", () => {
    expect(containsRenderableCommand("a/batch_kick")).toBe(false);
    expect(containsRenderableCommand("1/batch_kick")).toBe(false);
    expect(containsRenderableCommand("_/batch_kick")).toBe(false);
  });

  test("斜杠后不是命令名首字符时不命中", () => {
    expect(containsRenderableCommand("和/或")).toBe(false);
    expect(containsRenderableCommand("a / b")).toBe(false);
  });

  test("回归：链接里的 `//` 不是命令，否则复读与 AI 会拒发一切带链接的消息", () => {
    expect(containsRenderableCommand("https://example.com")).toBe(false);
    expect(containsRenderableCommand("看这个 https://t.me/thebot")).toBe(false);
    expect(containsRenderableCommand("//batch_kick")).toBe(false);
  });

  test("连续判定同一个串结果稳定（正则不带 g 标志）", () => {
    expect(containsRenderableCommand("/x")).toBe(true);
    expect(containsRenderableCommand("/x")).toBe(true);
    expect(containsRenderableCommand("/x")).toBe(true);
  });
});

describe("libs/renderableCommand neutralizeRenderableCommands", () => {
  test("中和后不再含可渲染命令，且原文仍可读", () => {
    const neutralized: string = neutralizeRenderableCommands("喵，/batch_kick 1d");
    expect(neutralized).toBe("喵，／batch_kick 1d");
    expect(containsRenderableCommand(neutralized)).toBe(false);
  });

  test("一段里的多个命令逐个中和", () => {
    expect(neutralizeRenderableCommands("/a /b")).toBe("／a ／b");
    expect(containsRenderableCommand(neutralizeRenderableCommands("「/block」（/gag）"))).toBe(false);
  });

  test("不成实体的斜杠原样保留，且不含斜杠时返回同一个字符串对象", () => {
    expect(neutralizeRenderableCommands("a/batch_kick")).toBe("a/batch_kick");
    expect(neutralizeRenderableCommands("https://example.com/path")).toBe("https://example.com/path");
    const plain: string = "普通昵称";
    expect(neutralizeRenderableCommands(plain)).toBe(plain);
  });

  test("中和是幂等的：已中和过的串再走一次不变", () => {
    const once: string = neutralizeRenderableCommands("/batch_kick");
    expect(neutralizeRenderableCommands(once)).toBe(once);
  });
});
