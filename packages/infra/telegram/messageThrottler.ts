/**
 * Telegram 发送类请求专用 grammY throttler 适配层。这里只组合项目特有的
 * 方法分类；实际全局、群聊和私聊桶仍完全交给官方插件。
 */

import {
  apiThrottler,
  BottleneckStrategy,
} from "@grammyjs/transformer-throttler";
import {
  TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX,
  TELEGRAM_MESSAGE_GROUP_PENDING_MAX,
  TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX,
} from "../../consts/telegram";
import type { RawApi, Transformer } from "grammy";

/**
 * 识别官方明确会由机器人向目标聊天产生消息、媒体或文件的 Bot API 方法。
 * chat action、inline query 应答、编辑、删除和管理请求都不属于此集合。
 */
export function isTelegramMessageRequest(method: keyof RawApi): boolean {
  switch (method) {
    case "copyMessage":
    case "copyMessages":
    case "forwardMessage":
    case "forwardMessages":
    case "sendAnimation":
    case "sendAudio":
    case "sendChecklist":
    case "sendContact":
    case "sendDice":
    case "sendDocument":
    case "sendGame":
    case "sendInvoice":
    case "sendLivePhoto":
    case "sendLocation":
    case "sendMediaGroup":
    case "sendMessage":
    case "sendMessageDraft":
    case "sendPaidMedia":
    case "sendPhoto":
    case "sendPoll":
    case "sendRichMessage":
    case "sendRichMessageDraft":
    case "sendSticker":
    case "sendVenue":
    case "sendVideo":
    case "sendVideoNote":
    case "sendVoice":
      return true;
    default:
      return false;
  }
}

/** 创建发送类选择器；插件根据 payload.chat_id 自行选择群聊或私聊桶。 */
export function telegramMessageThrottler(): Transformer<RawApi> {
  const throttler: Transformer<RawApi> = apiThrottler({
    // 全局速率保持插件 1.2.1 的默认值，只补 OVERFLOW 高水位。
    global: {
      reservoir: 30,
      reservoirRefreshAmount: 30,
      reservoirRefreshInterval: 1_000,
      highWater: TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX,
      strategy: BottleneckStrategy.OVERFLOW,
    },
    group: {
      // 单群只主动保证每秒至多发起一次发送；不配置 reservoir，
      // 故不叠加插件默认的 20/min 窗口。服务端 429 由后续统一出站闸处理。
      maxConcurrent: 1,
      minTime: 1_000,
      highWater: TELEGRAM_MESSAGE_GROUP_PENDING_MAX,
      strategy: BottleneckStrategy.OVERFLOW,
    },
    out: {
      maxConcurrent: 1,
      minTime: 1_000,
      highWater: TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX,
      strategy: BottleneckStrategy.OVERFLOW,
    },
  });
  // grammY transformer 的四参数签名由 Transformer 完整约束。
  // eslint-disable-next-line @typescript-eslint/typedef, @typescript-eslint/explicit-function-return-type, max-params
  const transformer: Transformer<RawApi> = (previous, method, payload, signal) =>
    isTelegramMessageRequest(method)
      ? throttler(previous, method, payload, signal)
      : previous(method, payload, signal);
  return transformer;
}
