import type { ChatFullInfo, ChatPhoto, User, UserProfilePhotos } from "grammy/types";
import { USER_PROFILE_PHOTOS_LIMIT } from "../../../consts/telegram";
import { bot } from "../mainClient";
import { logUnlessAborted, runTelegramAction, signalArgs } from "../actions/core";
import { downloadAvatarFile } from "./download";
import type { AvatarDownloadResult, AvatarIdentity, CurrentAvatar } from "../../../types/telegram";
import { fetchAvatarFromWebProfile } from "./webProfile";

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
 */
export async function readCurrentAvatar(target: User | number, signal: AbortSignal): Promise<CurrentAvatar | undefined> {
  if (signal.aborted) return undefined;
  const targetId: number = typeof target === "number" ? target : target.id;
  let identity: AvatarIdentity | undefined = typeof target === "number" ? undefined : target;
  const photo: string | Uint8Array | undefined = await runTelegramAction({
    action: `read current avatar (identity ${targetId})`,
    execute: async (requestSignal?: AbortSignal): Promise<string | Uint8Array | undefined> => {
      const chat: ChatFullInfo = await bot.api.getChat(targetId, ...signalArgs(requestSignal));
      if (typeof target === "number") {
        if (chat.type !== "channel" || chat.id !== targetId) return undefined;
        identity = chat;
      }
      if (requestSignal?.aborted) return undefined;
      if (chat.photo === undefined) return undefined;
      if (typeof target !== "number") {
        const fileId: string | undefined = await readReusableUserAvatar(targetId, chat.photo, requestSignal);
        if (requestSignal?.aborted) return undefined;
        if (fileId !== undefined) return fileId;
      }
      const result: AvatarDownloadResult = await downloadAvatarFile(chat.photo.big_file_id, targetId, requestSignal);
      return result.status === "ok" ? result.bytes : undefined;
    },
    map: (result: string | Uint8Array | undefined): string | Uint8Array | undefined => result,
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
  if (signal.aborted || identity === undefined) return undefined;
  if (photo !== undefined) return { identity, photo };
  if (identity.username === undefined) return undefined;
  const fallback: Uint8Array | null = await fetchAvatarFromWebProfile(identity.username, signal);
  return fallback === null || signal.aborted ? undefined : { identity, photo: fallback };
}
