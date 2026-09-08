import { InputFile } from "grammy";
import { BOT_PROFILE_PHOTO_FILE_NAME } from "../../../consts/telegram";
import { signalArgs } from "../../../libs/telegramSignalArgs";
import { bot } from "../mainClient";

/** 单次头像操作的结果：区分可重试故障与确定性失败。 */
export type AvatarOperationAttemptResult = "ok" | "transient-failure" | "permanent-failure";

/**
 * 把一段图片字节换成机器人头像。三条头像路径（复制目标头像、t.me 页面兜底、
 * 复原默认头像）唯一的上传出口。
 *
 * 只负责这一次 Bot API 调用：**不 catch**。三个调用点对失败的归类各不相同
 * （可重试 / 确定性失败 / 直接放弃），异常一律原样上抛由它们自己判。
 * 文件名固定为 BOT_PROFILE_PHOTO_FILE_NAME，取消信号照常下传。
 */
export async function setBotProfilePhoto(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  await bot.api.setMyProfilePhoto(
    { type: "static", photo: new InputFile(bytes, BOT_PROFILE_PHOTO_FILE_NAME) },
    ...signalArgs(signal)
  );
}
