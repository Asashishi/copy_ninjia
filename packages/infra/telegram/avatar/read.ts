import type { ChatFullInfo, ChatPhoto, User, UserProfilePhotos } from "grammy/types";
import { USER_PROFILE_PHOTOS_LIMIT } from "../../../consts/telegram";
import { bot } from "../mainClient";
import { telegramErrorDetails } from "../errors";
import {
  runTelegramAction,
} from "../actions/core";
import { telegramSignal } from "../../../libs/telegramSignal";
import { downloadAvatarFile } from "./download";
import type { AvatarDownloadResult, AvatarIdentity, CurrentAvatarResult } from "../../../types/telegram";
import { fetchAvatarFromWebProfile } from "./webProfile";

/** 一轮头像查询的中间结果；没拿到发送源时 transient 说明这次还能不能重试。 */
interface CurrentAvatarProbe {
  readonly photo: string | Uint8Array | undefined;
  readonly transient: boolean;
  readonly chatNotFound?: boolean;
}

/** 确认没有可用头像：身份不符、当前没有 ChatPhoto，或下载确定性失败。 */
const AVATAR_PROBE_ABSENT: CurrentAvatarProbe = { photo: undefined, transient: false };
/** 这次没查成：请求抛错、中途取消，或下载偶发失败。 */
const AVATAR_PROBE_FAILED: CurrentAvatarProbe = { photo: undefined, transient: true };
/** 裸 ID 对应的私聊无法访问；/wed 可从所有已管理群的候选集合移除该 ID。 */
const AVATAR_PROBE_CHAT_NOT_FOUND: CurrentAvatarProbe = { photo: undefined, transient: false, chatNotFound: true };

/** 没拿到发送源时按本轮探测结论归一化对外结果。 */
function missingAvatar(probe: CurrentAvatarProbe): CurrentAvatarResult {
  if (probe.chatNotFound === true) return { status: "chat-not-found" };
  return { status: probe.transient ? "transient-failure" : "permanent-failure" };
}

/** 与 getChat 同时发出的用户头像列表查询。 */
interface ProfilePhotosRequest {
  readonly targetId: number;
  /** 查询本身；失败只在 readReusableUserAvatar 消费时记录。 */
  readonly response: Promise<UserProfilePhotos>;
  /** 同一查询挂好 rejection 监听后的结算点，不消费结果时只等它。 */
  readonly settled: Promise<unknown>;
}

/** 发出用户头像列表查询并立即挂上 rejection 监听，查询沿用调用方的请求信号。 */
function startProfilePhotosRequest(targetId: number, signal?: AbortSignal): ProfilePhotosRequest {
  const response: Promise<UserProfilePhotos> = bot.api.getUserProfilePhotos(
    targetId,
    { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT },
    telegramSignal(signal)
  );
  return { targetId, response, settled: response.catch((): undefined => undefined) };
}

/** 只复用与当前 ChatPhoto 匹配的用户头像；查询失败或历史未匹配时交回下载路径。 */
function readReusableUserAvatar(
  request: ProfilePhotosRequest,
  current: ChatPhoto,
  signal?: AbortSignal
): Promise<string | undefined> {
  return runTelegramAction({
    action: `read reusable avatar (identity ${request.targetId})`,
    execute: (): Promise<UserProfilePhotos> => request.response,
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
  });
}

/**
 * 读取当前头像。`target` 是调用方已持有的用户身份，或只有 ID 的频道/用户：只给 ID 时以同一次
 * getChat 核实身份，频道得到 ChannelChat，用户得到私聊资料 PrivateChat，不另发成员查询，
 * 因此不要求机器人是群管理员。
 * 用户优先复用匹配的 PhotoSize.file_id：用户头像列表查询只依赖 ID，与 getChat 同时发出，
 * getChat 确认当前头像后才消费；用不上（没有当前头像、身份不符或 getChat 失败）时不中止，
 * 等它结算后返回，失败也不记录。ChatPhoto ID 只用于下载，网页兜底复用抓取边界。
 * 结果区分「确认没有可用头像」「这次没查成」与裸 ID 的「私聊无法访问」，见
 * types/telegram.ts 的 CurrentAvatarResult。
 */
export async function readCurrentAvatar(target: User | number, signal: AbortSignal): Promise<CurrentAvatarResult> {
  if (signal.aborted) return missingAvatar(AVATAR_PROBE_FAILED);
  const targetId: number = typeof target === "number" ? target : target.id;
  let identity: AvatarIdentity | undefined = typeof target === "number" ? undefined : target;
  const probe: CurrentAvatarProbe = await runTelegramAction({
    action: `read current avatar (identity ${targetId})`,
    execute: async (requestSignal?: AbortSignal): Promise<CurrentAvatarProbe> => {
      const chatRequest: Promise<ChatFullInfo> = bot.api.getChat(targetId, telegramSignal(requestSignal));
      // 正数 ID 只能是用户：只有用户发头像列表查询，与 getChat 同时发出。
      const photos: ProfilePhotosRequest | undefined = targetId > 0
        ? startProfilePhotosRequest(targetId, requestSignal)
        : undefined;
      try {
        let chat: ChatFullInfo;
        try {
          chat = await chatRequest;
        } catch (error: unknown) {
          const details: Readonly<{ errorCode: number; description: string }> | undefined = telegramErrorDetails(error);
          if (typeof target === "number" && targetId > 0 && details?.errorCode === 400 &&
            /^Bad Request: chat not found$/i.test(details.description)) return AVATAR_PROBE_CHAT_NOT_FOUND;
          throw error;
        }
        if (typeof target === "number") {
          if (chat.id !== targetId || (chat.type !== "channel" && chat.type !== "private")) return AVATAR_PROBE_ABSENT;
          identity = chat;
        }
        if (requestSignal?.aborted) return AVATAR_PROBE_FAILED;
        if (chat.photo === undefined) return AVATAR_PROBE_ABSENT;
        if (photos !== undefined) {
          const fileId: string | undefined = await readReusableUserAvatar(photos, chat.photo, requestSignal);
          if (requestSignal?.aborted) return AVATAR_PROBE_FAILED;
          if (fileId !== undefined) return { photo: fileId, transient: false };
        }
        const result: AvatarDownloadResult = await downloadAvatarFile(chat.photo.big_file_id, targetId, requestSignal);
        if (result.status === "ok") return { photo: result.bytes, transient: false };
        return result.status === "transient-failure" ? AVATAR_PROBE_FAILED : AVATAR_PROBE_ABSENT;
      } finally {
        await photos?.settled;
      }
    },
    map: (result: CurrentAvatarProbe): CurrentAvatarProbe => result,
    fallback: AVATAR_PROBE_FAILED,
    signal,
  });
  if (signal.aborted) return missingAvatar(AVATAR_PROBE_FAILED);
  if (identity === undefined) return missingAvatar(probe);
  if (probe.photo !== undefined) return { status: "ok", identity, photo: probe.photo };
  if (identity.username === undefined) return missingAvatar(probe);
  const fallback: Uint8Array | null = await fetchAvatarFromWebProfile(identity.username, signal);
  if (fallback === null || signal.aborted) return missingAvatar(probe);
  return { status: "ok", identity, photo: fallback };
}
