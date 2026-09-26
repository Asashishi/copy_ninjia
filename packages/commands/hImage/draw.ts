/**
 * `/h_image` 抽图：从随机图片目录（config/dynamic/assets.json 的 random_h_image_dir，见
 * config/assets.ts 的 getAssetConfig）均匀抽一张发到触发的群。
 * 在延迟命令执行器里运行（见 commands/deferredCommands.ts）。结果图片只经
 * sendHImageResult 发送；抽取失败的提示走 sendCommandMessage，30 秒后删除。
 */

import { chatAtmosphere } from "../../infra/atmosphere";
import { pickRandomImage } from "../../infra/randomImage";
import { getAssetConfig } from "../../config/assets";
import { recordBotImage } from "../../aiChat";
import { sendCommandMessage, sendPhotoWithResult } from "../../infra/telegram";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { HImageRequest } from "../../types/hImage";
import type { RandomImagePick } from "../../types/randomImage";
import type { TelegramPhotoSendResult } from "../../types/telegram";

/** sendHImageResult 的入参。 */
interface SendHImageResultParams extends HImageRequest {
  readonly pick: Extract<RandomImagePick, { status: "ok" }>;
}

/**
 * `/h_image` 结果图片的唯一发送边界。**长期保留**：这是用户授权的保留例外（见
 * docs/cn/04-invariants.md），不挂固定延迟删除；论坛群带触发消息所在话题并
 * 回复触发消息。图片固定以 Telegram 剧透遮罩发送，点开才显示。经共享的
 * sendPhotoWithResult 发送，自发登记、throttler 与 429 分类闸都在那一层；
 * 发送成功后写一条占位态自录（见 aiChat/botImages.ts）。
 */
async function sendHImageResult({ chatId, messageId, messageThreadId, pick }: SendHImageResultParams): Promise<void> {
  const sent: TelegramPhotoSendResult | undefined = await sendPhotoWithResult({
    chatId,
    bytes: pick.bytes,
    mimeType: pick.mimeType,
    replyToMessageId: messageId,
    messageThreadId,
    hasSpoiler: true,
  });
  if (sent !== undefined) recordBotImage({ chatId, messageId: sent.messageId, caption: "", edited: false });
}

/** 抽取并发送；抽取失败按结果回一句 30 秒提示。 */
export async function deliverRandomImage(request: HImageRequest): Promise<void> {
  const pick: RandomImagePick = await pickRandomImage(getAssetConfig().randomHImageDirectory);
  if (pick.status === "ok") {
    await sendHImageResult({ ...request, pick });
    return;
  }
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(request.chatId).H_IMAGE_TEXTS;
  const text: string = pick.status === "missingDirectory"
    ? texts.missingDirectory
    : pick.status === "empty" ? texts.empty : texts.tooLarge(pick.fileName);
  await sendCommandMessage({ chatId: request.chatId, text, replyToMessageId: request.messageId });
}
