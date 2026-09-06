import { expect, test } from "bun:test";
import { Api } from "grammy";
import { sendEphemeralMessage } from "../../packages/infra/telegram/actions/messages";

test("真实 grammY 编码 Bot API 10.3 发送载荷并原生删除临时消息", async (): Promise<void> => {
  const api: Api = new Api("123456:mock-token");
  const calls: { method: string; payload: unknown; signal: unknown }[] = [];
  api.config.use(async (...args: [unknown, string, unknown, unknown?]): Promise<any> => {
    const [, method, payload, signal]: [unknown, string, unknown, unknown?] = args;
    calls.push({ method, payload, signal });
    return { ok: true, result: method === "deleteEphemeralMessage" ? true : {
      message_id: 0, chat: { id: -1001, type: "supergroup" }, receiver_user: { id: 7 }, ephemeral_message_id: 71, date: 1, text: "入口",
    } };
  });
  const signal: AbortSignal = new AbortController().signal;
  const keyboard = { inline_keyboard: [[{ text: "进入", callback_data: "entry" }]] };
  expect(await sendEphemeralMessage({ chatId: -1001, receiverUserId: 7, callbackQueryId: "callback-id", text: "入口", keyboard, api, signal })).toBe(71);
  expect(calls[0]).toEqual({ method: "sendMessage", signal, payload: {
    chat_id: -1001, text: "入口", ephemeral_message_parameters: { receiver_user_id: 7, callback_query_id: "callback-id" }, reply_markup: keyboard,
  } });
  expect(await api.raw.deleteEphemeralMessage({ chat_id: -1001, receiver_user_id: 7, ephemeral_message_id: 71 }, signal as never)).toBeTrue();
  expect(calls[1]).toEqual({ method: "deleteEphemeralMessage", signal, payload: { chat_id: -1001, receiver_user_id: 7, ephemeral_message_id: 71 } });
});
