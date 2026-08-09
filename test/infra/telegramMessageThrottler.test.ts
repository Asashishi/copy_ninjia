import { describe, expect, test } from "bun:test";
import { isTelegramMessageRequest } from "../../packages/infra/telegram/messageThrottler";

describe("Telegram 发送类 throttler 分类", () => {
  test("只有实际产生聊天消息、媒体、文件或转发的调用进入 grammY", () => {
    expect(isTelegramMessageRequest("sendMessage")).toBeTrue();
    expect(isTelegramMessageRequest("sendPhoto")).toBeTrue();
    expect(isTelegramMessageRequest("sendAudio")).toBeTrue();
    expect(isTelegramMessageRequest("sendDocument")).toBeTrue();
    expect(isTelegramMessageRequest("copyMessage")).toBeTrue();
    expect(isTelegramMessageRequest("forwardMessages")).toBeTrue();
    expect(isTelegramMessageRequest("sendMessageDraft")).toBeTrue();
  });

  test("inline、聊天状态、管理、查询、删除、反应和回调不进入 grammY", () => {
    expect(isTelegramMessageRequest("answerInlineQuery")).toBeFalse();
    expect(isTelegramMessageRequest("answerWebAppQuery")).toBeFalse();
    expect(isTelegramMessageRequest("sendChatAction")).toBeFalse();
    expect(isTelegramMessageRequest("getChat")).toBeFalse();
    expect(isTelegramMessageRequest("getFile")).toBeFalse();
    expect(isTelegramMessageRequest("banChatMember")).toBeFalse();
    expect(isTelegramMessageRequest("deleteMessage")).toBeFalse();
    expect(isTelegramMessageRequest("setMessageReaction")).toBeFalse();
    expect(isTelegramMessageRequest("answerCallbackQuery")).toBeFalse();
    expect(isTelegramMessageRequest("sendGift")).toBeFalse();
  });
});
