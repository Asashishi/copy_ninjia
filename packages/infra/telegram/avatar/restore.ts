import { GrammyError, InputFile } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  BOT_PROFILE_PHOTO_FILE_NAME,
} from "../../../consts/telegram";
import { readBoundedResponseBytes, type BoundedResponseResult } from "../../../libs/boundedResponse";
import { sniffImageFormat, type SniffedImageFormat } from "../../../libs/image";
import { redactUrlForLog } from "../../../libs/redaction";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { bot } from "../mainClient";
import { avatarFetchSignal, telegramSignal } from "./shared";
import type { AvatarOperationAttemptResult } from "./shared";

/**
 * 把机器人头像复原成 `url` 指向的那张默认脸。
 *
 * URL 由调用方传入而不是在这里取：它来自 `state.global.assets.botDefaultAvatarUrl`，
 * 缺省回退到 consts/ui/assets.ts 的 BOT_DEFAULT_AVATAR_URL（见
 * infra/storage/stateStore.ts 的 getBotDefaultAvatarUrl）。头像入口只由主线程加载，
 * 但仍不反向读取 state 内存：取值留在同一 owner 的 copy/avatarQueue.ts，让本模块
 * 只负责一次有界下载与头像恢复动作（见 docs/cn/04-invariants.md 的缓存线程归属）。
 *
 * **对图床不做任何限定**：任意能直出图片字节的地址都成立，图床、对象存储、自建
 * 静态资源都行，代码里不认哪一家；这一项也是唯一允许明文 http 的素材直链——它由
 * 本进程自己抓取，走不走 TLS 是配置者的决定（见 libs/stateFileCodec.ts 的 assetUrl）。
 *
 * 这条下载**跟随重定向**：地址是部署配置的一部分，跳到哪儿由配置者选定的图床决定，
 * 而「直链先 302 到实际存储域名」正是图床与对象存储的常态（内置缺省那条 Google
 * Drive 链接就是如此）。逼配置者自己解析出终点地址只会把一个必然踩到的坑变成必须
 * 写进文档的注意事项。
 *
 * /copy、/steal_icon 那三条禁用 redirect 是另一条约束，不是这一条的强化版：那些
 * 地址来自 Bot API 的 file_path 与 t.me 主页的 HTML，归 Telegram 自有资产域
 * allowlist 管（见 docs/cn/04-invariants.md 的「出站请求与消息安全」），本函数不在其列。
 *
 * 有界读取（AVATAR_MAX_DOWNLOAD_BYTES）与上传前的字节签名校验照旧，但那两道防的
 * 是「拿回来的根本不是图片」，与跳不跳转无关。
 *
 * 与 copyUserProfilePhoto 一样按 AVATAR_FETCH_MAX_ATTEMPTS 重试，也与它一样
 * **区分永久与瞬时失败**：对端偶发 5xx 与限流值得重试，而「拿回来的根本不是
 * 图片」「Telegram 判定这张图不合规」重试多少次都是同一个结果，只会白烧头像
 * 接口的调用额度——那正是本函数的重试本想规避的 flood 限制。
 * @returns 复原成功为 true；下载失败、响应超限、载荷不是图片或
 *   setMyProfilePhoto 失败为 false（均已记日志）。
 */
export async function restoreDefaultProfilePhoto(url: string, signal?: AbortSignal): Promise<boolean> {
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return false;
    const result: AvatarOperationAttemptResult = await attemptRestoreDefaultProfilePhoto(url, attempt, signal);
    if (result === "ok") return true;
    if (result === "permanent-failure") break;
  }
  return false;
}

/** 单次「下载默认头像并换上」的尝试；失败按可否重试分类，日志已在各分支记过。 */
async function attemptRestoreDefaultProfilePhoto(
  url: string,
  attempt: number,
  signal?: AbortSignal
): Promise<AvatarOperationAttemptResult> {
  try {
    const response: Response = await fetch(url, {
      // 跟随重定向：地址是部署配置，而图床与对象存储的直链先跳一次到存储域名是
      // 常态（理由见 restoreDefaultProfilePhoto）。
      redirect: "follow",
      signal: avatarFetchSignal(signal),
    });
    if (!response.ok) {
      logger.error(`Failed to download the default avatar (${response.status}) from ${redactUrlForLog(url)} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`);
      return "transient-failure";
    }
    const download: BoundedResponseResult = await readBoundedResponseBytes(response, AVATAR_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      // 超限是确定性失败：同一个链接重试多少次都是这么大，点名字节数便于换图。
      logger.error(`The default avatar at ${redactUrlForLog(url)} exceeded the download limit (${download.observedBytes} bytes)`);
      return "permanent-failure";
    }
    // 上传前必须认一遍字节，与图床是哪一家无关：拿 **HTTP 200** 回一段 HTML 是
    // 这类链接的通病（Drive 的 uc?export=download 在配额超限/病毒扫描警告时如此，
    // 需要登录或已过期的分享链接同理）——response.ok 为真、有界读取成功，于是那段
    // HTML 被当作静态图片交给 Telegram，换来一次确定性拒绝。响应体为 null 时
    // readBoundedResponseBytes 会以零长 buffer 报 ok，同样在这里被挡下
    // （长度不足以匹配任何签名）。
    const format: SniffedImageFormat = sniffImageFormat(
      Buffer.from(download.bytes.buffer, download.bytes.byteOffset, download.bytes.byteLength)
    );
    if (format !== "jpeg" && format !== "png") {
      logger.error(
        `The default avatar link ${redactUrlForLog(url)} did not return a JPEG or PNG image ` +
        `(sniffed=${format}, bytes=${download.bytes.byteLength}); it must serve raw image bytes ` +
        "rather than an HTML page such as a login, quota or virus-scan interstitial"
      );
      return "permanent-failure";
    }
    await bot.api.setMyProfilePhoto(
      { type: "static", photo: new InputFile(download.bytes, BOT_PROFILE_PHOTO_FILE_NAME) },
      telegramSignal(signal)
    );
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError(`restore default profile photo from ${redactUrlForLog(url)} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`, error);
    // Telegram 的 400 是对这张图本身的判定（PHOTO_CROP_SIZE_SMALL 之类），换几次
    // 都一样；其余（429/5xx/网络抖动）才值得再试。
    return error instanceof GrammyError && error.error_code === 400 ? "permanent-failure" : "transient-failure";
  }
}
