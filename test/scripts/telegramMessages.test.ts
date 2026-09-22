import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTelegramMessageProblems } from "../../scripts/conventions/telegramMessages";

const temporaryRoots: string[] = [];

afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 门禁无条件读取的最小文件集：gag / qa 边界文件、头像队列与验证提醒；
 * 其余目录必须存在但可以为空。
 */
const BASELINE_FILES: Readonly<Record<string, string>> = {
  "commands/gag.ts": "",
  "commands/gag/notices.ts": "",
  "commands/qa/notices.ts": "",
  "copy/avatarQueue.ts": "",
  "workers/antiRaid/verificationReminders.ts": "",
};

/** 在临时仓库根下写入 packages/ 夹具（覆盖同名基线文件）后跑一遍门禁。 */
async function problemsFor(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-telegram-messages-"));
  temporaryRoots.push(root);
  const sourceRoot: string = join(root, "packages");
  const commandsRoot: string = join(sourceRoot, "commands");
  for (const directory of [
    join(commandsRoot, "luckChallenge"),
    join(sourceRoot, "antiRaid"),
    join(sourceRoot, "auto"),
    join(sourceRoot, "cron"),
  ]) mkdirSync(directory, { recursive: true });
  for (const [relativePath, text] of Object.entries({ ...BASELINE_FILES, ...files })) {
    await Bun.write(join(sourceRoot, relativePath), text);
  }
  return collectTelegramMessageProblems(root, sourceRoot, commandsRoot);
}

const COMMAND_TEXT_PROBLEM: string = "command text must use sendCommandMessage so group prompts are deleted";
const GAG_BYPASS_PROBLEM: string =
  "only the state-owned gag notices and the /qa set form boundary may bypass sendCommandMessage";

describe("Telegram 提示留存门禁的边界豁免", () => {
  test("最小合规夹具不报问题", async (): Promise<void> => {
    expect(await problemsFor({})).toEqual([]);
  });

  test("每个命名边界内的发送与带话题的长期保留内容都不报问题", async (): Promise<void> => {
    expect(await problemsFor({
      "commands/gag.ts": 'import { sendMessage } from "../infra/telegram";\n' +
        "export async function gag(): Promise<void> {\n" +
        '  const publicNoticeMessageId = await sendMessage({ chatId: 1, text: "notice" });\n' +
        "  void publicNoticeMessageId;\n}\n",
      "commands/gag/notices.ts": 'import { sendEphemeralMessage } from "../../infra/telegram";\n' +
        "export function sendGagSpeakNotice(): unknown { return sendEphemeralMessage({ chatId: 1 }); }\n",
      "commands/qa/notices.ts": 'import { sendMessage } from "../../infra/telegram";\n' +
        "export function sendQaForm(): unknown { return sendMessage({ chatId: 1 }); }\n",
      "commands/wed/messages.ts": "export function sendWedResult(): unknown { return bot.api.sendPhoto(1, image); }\n",
      "commands/hImage/draw.ts":
        "export function sendHImageResult(): unknown { return sendPhotoWithResult({ chatId: 1 }); }\n",
      "commands/pin.ts": 'import { sendCommandMessage } from "../infra/telegram";\n' +
        'sendCommandMessage({ chatId: 1, text: "kept", preserveInGroup: true, messageThreadId: 2 });\n' +
        'sendCommandMessage({ chatId: 1, text: "cleaned", preserveInGroup: false });\n',
      "copy/echo.ts": "export function sendEchoPayload(): unknown { return copyMessage({ chatId: 1, caption: text }); }\n",
      "cron/delivery.ts": "export function deliverCronAction(): unknown { return bot.api.sendMessage(1, \"hi\"); }\n",
      "antiRaid/adDetect.ts": 'import { sendMessage } from "../infra/telegram";\n' +
        "export function announceAdDisposal(): unknown { return sendMessage({ chatId: 1 }); }\n",
      "auto/message/qaDirectAnswer.ts": 'import { sendMessage } from "../../infra/telegram";\n' +
        "export function sendQaDirectAnswer(): unknown { return sendMessage({ chatId: 1 }); }\n",
      "workers/antiRaid/lockdownApi.ts": 'import { sendMessage } from "../../infra/telegram";\n' +
        "export function beginLockdownAnnouncement(): unknown { return sendMessage({ chatId: 1 }); }\n",
    })).toEqual([]);
  });

  test("gag 与 /qa 边界文件里边界之外的直接发送逐处报出，边界函数内的闭包不继承豁免", async (): Promise<void> => {
    expect(await problemsFor({
      "commands/gag.ts": 'import { sendMessage } from "../infra/telegram";\n' +
        "export async function gag(): Promise<void> {\n" +
        '  const receiptMessageId = await sendMessage({ chatId: 1, text: "receipt" });\n' +
        "  void receiptMessageId;\n}\n",
      "commands/gag/notices.ts": 'import { sendEphemeralMessage } from "../../infra/telegram";\n' +
        "export function sendGagReleaseNotice(): unknown {\n" +
        "  return sendEphemeralMessage({ chatId: 1 });\n}\n",
      "commands/qa/notices.ts": 'import { sendMessage } from "../../infra/telegram";\n' +
        "export function sendQaForm(): () => unknown {\n" +
        "  return (): unknown => sendMessage({ chatId: 1 });\n}\n",
    })).toEqual([
      `packages/commands/gag.ts:3 ${GAG_BYPASS_PROBLEM}`,
      `packages/commands/gag/notices.ts:3 ${GAG_BYPASS_PROBLEM}`,
      `packages/commands/qa/notices.ts:3 ${GAG_BYPASS_PROBLEM}`,
    ]);
  });

  test("gag 与 /qa 边界文件以别名导入发送函数时按普通命令文本报错", async (): Promise<void> => {
    // 命令目录按 readdir 顺序遍历，跨文件的报告顺序不固定。
    expect([...await problemsFor({
      "commands/gag.ts": 'import { sendMessage as send } from "../infra/telegram";\n',
      "commands/qa/notices.ts": '\nimport { sendEphemeralMessage as notify } from "../../infra/telegram";\n',
    })].sort()).toEqual([
      `packages/commands/gag.ts:1 ${COMMAND_TEXT_PROBLEM}`,
      `packages/commands/qa/notices.ts:2 ${COMMAND_TEXT_PROBLEM}`,
    ]);
  });

  test("头像队列与命令目录一样只能经 sendCommandMessage 发文本", async (): Promise<void> => {
    expect(await problemsFor({
      "copy/avatarQueue.ts": 'import { sendEphemeralMessage } from "../infra/telegram";\n',
    })).toEqual([`packages/copy/avatarQueue.ts:1 ${COMMAND_TEXT_PROBLEM}`]);
  });
});

describe("Telegram 提示留存门禁的命名边界函数", () => {
  test("/wed 结果图只能由 sendWedResult 发送，且消息文件不得引入固定延迟清理", async (): Promise<void> => {
    expect(await problemsFor({
      "commands/wed/messages.ts": 'import { sendCommandMessage as reply } from "../../infra/telegram";\n' +
        "export function sendWedResult(): unknown { return bot.api.sendPhoto(1, image); }\n" +
        "export function resendWedResult(): unknown { return bot.api.sendPhoto(1, image); }\n",
    })).toEqual([
      "packages/commands/wed/messages.ts: /wed state-owned photos must not use fixed-delay command cleanup",
      "packages/commands/wed/messages.ts: state-owned command photos must use sendWedResult",
    ]);
  });

  test("/h_image 结果图在 draw.ts 里也只能由 sendHImageResult 发送", async (): Promise<void> => {
    expect(await problemsFor({
      "commands/hImage/draw.ts":
        "export function sendHImageResult(): unknown { return sendPhotoWithResult({ chatId: 1 }); }\n" +
        "export function retryHImage(): unknown { return sendPhotoWithResult({ chatId: 1 }); }\n",
    })).toEqual([
      "packages/commands/hImage/draw.ts: long-lived command photos must use sendHImageResult",
    ]);
  });

  test("替换图注的复制在 echo.ts 里也只能由 sendEchoPayload 发出", async (): Promise<void> => {
    expect(await problemsFor({
      "copy/echo.ts":
        "export function sendEchoPayload(): unknown { return copyMessage({ chatId: 1, caption: text }); }\n" +
        "export function forwardWithCaption(): unknown { return copyMessage({ chatId: 1, caption: text }); }\n",
    })).toEqual([
      "packages/copy/echo.ts: copies with a replaced caption must go through sendEchoPayload",
    ]);
  });

  test("Worker/群提示直发边界文件里的其它函数仍须走主线程临时消息边界", async (): Promise<void> => {
    expect(await problemsFor({
      "auto/message/proactive.ts": 'import { sendMessage } from "../../infra/telegram";\n' +
        "export function replyToBathTrigger(): unknown { return sendMessage({ chatId: 1 }); }\n" +
        "export function replyToOtherTrigger(): unknown { return sendMessage({ chatId: 1 }); }\n",
      "antiRaid/notice.ts": 'import { sendMessage } from "../infra/telegram";\n' +
        "export function announce(): unknown { return sendMessage({ chatId: 1 }); }\n",
    })).toEqual([
      "packages/antiRaid/notice.ts: ordinary Worker/group notices must use the main-thread temporary-message boundary",
      "packages/auto/message/proactive.ts: ordinary Worker/group notices must use the main-thread temporary-message boundary",
    ]);
  });

  test("cron 目录里以裸函数调用发送同样要经 delivery.ts", async (): Promise<void> => {
    expect(await problemsFor({
      "cron/schedule.ts": 'export function remind(): unknown { return sendCommandMessage({ chatId: 1, text: "hi" }); }\n',
    })).toEqual(["packages/cron/schedule.ts: cron messages must be sent through cron/delivery.ts"]);
  });
});
