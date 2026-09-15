import { expect, test } from "bun:test";
import {
  buildTieredVerbatimTranscript,
  formatBufferedMessageLine,
  formatSpeakerIdentity,
} from "../../../packages/aiChat/ai/utils/chatTranscript";
import { buildSelfRecordMessage } from "../../../packages/aiChat/ai/utils/selfRecord";
import { SELF_SPEAKER_NAME } from "../../../packages/consts/aiChat/prompts/transcript";
import { bufferedMessageFixture } from "../../helpers/aiMemoryFixtures";
import type { BufferedMessage, BufferedReplyReference } from "../../../packages/types/aiChat/memory";
import type { AiRecordMessage } from "../../../packages/types/aiChat/protocol";
import type { RenderedTranscript } from "../../../packages/aiChat/ai/utils/chatTranscript";

function ownMessage(): BufferedMessage {
  return bufferedMessageFixture({
    id: 99, messageId: 10, firstName: "BotFirst", lastName: "BotLast", username: "bot_username", text: "自己的原文",
  });
}

test("自录仅保留账号 ID 和代称，固定字段仍完整", (): void => {
  const record: AiRecordMessage = buildSelfRecordMessage({
    chatId: -1001, self: { id: 99, first_name: "BotFirst", username: "bot_username" }, messageId: 10, text: "自己的原文",
  });
  expect(record).toMatchObject({ senderId: 99, firstName: SELF_SPEAKER_NAME, lastName: "", username: undefined, text: "自己的原文" });
  expect(Object.hasOwn(record, "username")).toBeTrue();
});

test("格式化既有快照时按自身 ID 代称，不改写原始消息", (): void => {
  const own: BufferedMessage = ownMessage();
  expect(formatSpeakerIdentity(own, 99)).toBe(`[id:99] ${SELF_SPEAKER_NAME}`);
  const line: string = formatBufferedMessageLine(own, 99);
  expect(line).toContain(`[id:99] ${SELF_SPEAKER_NAME}：自己的原文`);
  for (const field of ["BotFirst", "BotLast", "bot_username"]) expect(line).not.toContain(field);
  expect(own.firstName).toBe("BotFirst");
  expect(own.lastName).toBe("BotLast");
  expect(own.username).toBe("bot_username");
});

test("窗口外的自身引用也使用代称，其他人的姓名及提及正文保持不变", (): void => {
  const reference: BufferedReplyReference = { ...ownMessage(), quote: "自己的" };
  const other: BufferedMessage = bufferedMessageFixture({
    id: 7, messageId: 11, firstName: "BotFirst", lastName: "BotLast", username: "other_bot",
    text: "@bot_username 这是群友的原文", replyTo: reference,
  });
  const compact: RenderedTranscript = buildTieredVerbatimTranscript([other], { selfId: 99, triggerMessageId: 11 });
  expect(compact.text).toContain("u1=[id:7] [username:@other_bot] BotFirst BotLast");
  expect(compact.text).toContain(`[id:99] ${SELF_SPEAKER_NAME}`);
  expect(compact.text).not.toContain("[username:@bot_username]");
  expect(compact.text).toContain(other.text);
  expect(compact.replyReference(reference)).toContain(`[id:99] ${SELF_SPEAKER_NAME}`);
  const full: string = formatBufferedMessageLine(other, 99);
  expect(full).toContain(`[message_id:10] [id:99] ${SELF_SPEAKER_NAME}`);
  expect(full).toContain("[id:7] [username:@other_bot] BotFirst BotLast");
});
