import type { ChatFullInfo, ChatPhoto, User, UserProfilePhotos } from "grammy/types";
import { USER_PROFILE_PHOTOS_LIMIT } from "../../../consts/telegram";
import { bot } from "../mainClient";
import {
  logUnlessAborted,
  runTelegramAction,
} from "../actions/core";
import { signalArgs } from "../../../libs/telegramSignalArgs";
import { downloadAvatarFile } from "./download";
import type { AvatarDownloadResult, AvatarIdentity, CurrentAvatarResult } from "../../../types/telegram";
import { fetchAvatarFromWebProfile } from "./webProfile";

/** 一轮头像查询的中间结果；没拿到发送源时 transient 说明这次还能不能重试。 */
interface CurrentAvatarProbe {
  readonly photo: string | Uint8Array | undefined;
  readonly transient: boolean;
}

/** 确认没有可用头像：身份不符、当前没有 ChatPhoto，或下载确定性失败。 */
const AVATAR_PROBE_ABSENT: CurrentAvatarProbe = { photo: undefined, transient: false };
/** 这次没查成：请求抛错、中途取消，或下载偶发失败。 */
const AVATAR_PROBE_FAILED: CurrentAvatarProbe = { photo: undefined, transient: true };

/** 没拿到发送源时按本轮探测结论归一化对外结果。 */
function missingAvatar(probe: CurrentAvatarProbe): CurrentAvatarResult {
  return { status: probe.transient ? "transient-failure" : "permanent-failure" };
}

/** 只复用与当前 ChatPhoto 匹配的用户头像；查询失败或历史未匹配时交回下载路径。 */
function readReusableUserAvatar(targetId: number, current: ChatPhoto, signal?: AbortSignal): Promise<string | undefined> {
  return runTelegramAction({
    action: `read reusable avatar (identity ${targetId})`,
    execute: (requestSignal?: AbortSignal): Promise<UserProfilePhotos> => bot.api.getUserProfilePhotos(
      targetId,
      { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT },
      ...signalArgs(requestSignal)
    ),
    map: (photos: UserProfilePhotos): string | undefined => {
      for (const sizes of photos.photos) {
        for (const photo of sizes) {
          if (photo.file_unique_id === current.big_file_unique_id) return photo.file_id;
        }
      }
      return undefined;
    },
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

/**
 * 读取当前头像；用户必须来自本轮 getChatMember，频道只传 ID 并以 getChat 核实身份。
 * 用户优先复用匹配的 PhotoSize.file_id；ChatPhoto ID 只用于下载，网页兜底复用抓取边界。
 * 结果分三态：调用方据此区分「确认没有可用头像」与「这次没查成」，见
 * types/telegram.ts 的 CurrentAvatarResult。
 */
export async function readCurrentAvatar(target: User | number, signal: AbortSignal): Promise<CurrentAvatarResult> {
  if (signal.aborted) return missingAvatar(AVATAR_PROBE_FAILED);
  const targetId: number = typeof target === "number" ? target : target.id;
  let identity: AvatarIdentity | undefined = typeof target === "number" ? undefined : target;
  const probe: CurrentAvatarProbe = await runTelegramAction({
    action: `read current avatar (identity ${targetId})`,
    execute: async (requestSignal?: AbortSignal): Promise<CurrentAvatarProbe> => {
      const chat: ChatFullInfo = await bot.api.getChat(targetId, ...signalArgs(requestSignal));
      if (typeof target === "number") {
        if (chat.type !== "channel" || chat.id !== targetId) return AVATAR_PROBE_ABSENT;
        identity = chat;
      }
      if (requestSignal?.aborted) return AVATAR_PROBE_FAILED;
      if (chat.photo === undefined) return AVATAR_PROBE_ABSENT;
      if (typeof target !== "number") {
        const fileId: string | undefined = await readReusableUserAvatar(targetId, chat.photo, requestSignal);
        if (requestSignal?.aborted) return AVATAR_PROBE_FAILED;
        if (fileId !== undefined) return { photo: fileId, transient: false };
      }
      const result: AvatarDownloadResult = await downloadAvatarFile(chat.photo.big_file_id, targetId, requestSignal);
      if (result.status === "ok") return { photo: result.bytes, transient: false };
      return result.status === "transient-failure" ? AVATAR_PROBE_FAILED : AVATAR_PROBE_ABSENT;
    },
    map: (result: CurrentAvatarProbe): CurrentAvatarProbe => result,
    fallback: AVATAR_PROBE_FAILED,
    signal,
    shouldLogError: logUnlessAborted,
  });
  if (signal.aborted) return missingAvatar(AVATAR_PROBE_FAILED);
  if (identity === undefined) return missingAvatar(probe);
  if (probe.photo !== undefined) return { status: "ok", identity, photo: probe.photo };
  if (identity.username === undefined) return missingAvatar(probe);
  const fallback: Uint8Array | null = await fetchAvatarFromWebProfile(identity.username, signal);
  if (fallback === null || signal.aborted) return missingAvatar(probe);
  return { status: "ok", identity, photo: fallback };
}
