import { expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/consts/whitelist";
import type { CommandTargetMessages } from "../../packages/types/commands";
import { renderQaFormPrompt } from "../../packages/commands/qa/rendering";

/** 只检查固定字符串，用户提供的动态文本不参与语气校验。 */
function assertPlainStrings(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(/本天才|杂鱼|笨蛋|♡|哼|小本本|猫娘大脑/);
  else if (value !== null && typeof value === "object") {
    for (const field of Object.values(value)) assertPlainStrings(field);
  }
}

test("两套文案覆盖同一组键和菜单命令，普通版固定文本不含默认人设口吻", () => {
  expect(Object.keys(ATMOSPHERE_TEXTS.plain).sort()).toEqual(Object.keys(ATMOSPHERE_TEXTS.teasing).sort());
  expect(Object.keys(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS).sort()).toEqual(Object.keys(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS).sort());
  expect(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS.map((entry) => entry.command))
    .toEqual(ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS.map((entry) => entry.command));
  assertPlainStrings(ATMOSPHERE_TEXTS.plain);
  for (const entry of ATMOSPHERE_TEXTS.plain.BOT_COMMANDS) {
    expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(entry.description.length).toBeGreaterThan(0);
    expect(entry.description.length).toBeLessThanOrEqual(256);
  }
});

test("两份权限 help JSON 已覆盖所有权限键，代码块前缀保留换行", () => {
  for (const texts of Object.values(ATMOSPHERE_TEXTS)) {
    expect(Object.keys(JSON.parse(texts.WHITELIST_PERMISSION_HELP_JSON)).sort()).toEqual([...WHITELIST_PERMISSION_KEYS].sort());
    expect(JSON.parse(texts.WHITELIST_PERMISSION_HELP_JSON)).toEqual(texts.WHITELIST_PERMISSION_HELP);
    expect(texts.PERMISSION_COMMAND_TEXTS.helpPrefix).toEndWith("\n");
    expect(texts.PERMISSION_COMMAND_TEXTS.queryPrefix("用户😀")).toEndWith("\n");
  }
});

test("普通版通过显式插值保留昵称、动作和问题内容，不替换动态文本", () => {
  const content: string = "😀本天才♡杂鱼\n保持原文";
  expect(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.copyAlreadyRunning(content)).toBe(`已经在复读 ${content}。`);
  expect(ATMOSPHERE_TEXTS.plain.QA_COMMAND_TEXTS.queryMissing(content)).toBe(`未找到问题「${content}」。`);
  expect(renderQaFormPrompt(content, content, ATMOSPHERE_TEXTS.plain)).toContain(`已收到的问题：${content}\n已收到的回答：${content}`);
});

test("普通版 gag 与 translate 的动态文案函数保留参数，且与默认人设文案不同", () => {
  const argument: string = "@alice_小明😀";
  const { plain, teasing } = ATMOSPHERE_TEXTS;
  const targetTables: readonly (readonly [Readonly<CommandTargetMessages>, Readonly<CommandTargetMessages>])[] = [
    [plain.GAG_TARGET_TEXTS, teasing.GAG_TARGET_TEXTS],
    [plain.UNGAG_TARGET_TEXTS, teasing.UNGAG_TARGET_TEXTS],
    [plain.TRANSLATE_TARGET_TEXTS, teasing.TRANSLATE_TARGET_TEXTS],
  ];
  for (const [plainTexts, teasingTexts] of targetTables) {
    const rendered: readonly (readonly [string, string])[] = [
      [plainTexts.invalidUsername(argument), teasingTexts.invalidUsername(argument)],
      [plainTexts.unknownUsername(argument), teasingTexts.unknownUsername(argument)],
      [plainTexts.conflictingTarget(argument), teasingTexts.conflictingTarget(argument)],
    ];
    for (const [plainText, teasingText] of rendered) {
      expect(plainText).toContain(argument);
      expect(plainText).not.toBe(teasingText);
      assertPlainStrings(plainText.replaceAll(argument, ""));
    }
  }
  expect(plain.TRANSLATE_TOGGLE_TEXTS.rejection(argument)).toBe(`${argument} 没有管理本群翻译功能的权限。`);
  expect(plain.TRANSLATE_TOGGLE_TEXTS.rejection(argument)).not.toBe(teasing.TRANSLATE_TOGGLE_TEXTS.rejection(argument));
});
