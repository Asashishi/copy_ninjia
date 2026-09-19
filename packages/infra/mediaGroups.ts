/**
 * 相册缓存的读写边界（状态见 cache/main/mediaGroups.ts），供 `/h_image add` 收齐整个相册。
 *
 * 观察挂在消息流水线上（auto/message/index.ts），调用方只在消息带 media_group_id 时才
 * 调用：普通消息不进入这里，不分配任何对象。
 */

import type { Message } from "grammy/types";
import { mediaGroupImages } from "../cache/main/mediaGroups";
import { MEDIA_GROUP_ITEMS_MAX } from "../consts/hImage";
import { messageImageCandidate } from "../libs/telegramImage";
import type { MediaGroupImages, MessageImageCandidate } from "../types/hImage";

/** 记录一条相册消息里能收的图；私聊、不是图、组已满或同一张图重复到达时不记。 */
export function observeMediaGroupImage(message: Message): void {
  const mediaGroupId: string | undefined = message.media_group_id;
  if (mediaGroupId === undefined || message.chat.type === "private") return;
  const candidate: MessageImageCandidate | undefined = messageImageCandidate(message);
  if (candidate === undefined) return;
  const entry: MediaGroupImages | undefined = mediaGroupImages.get(mediaGroupId);
  if (entry === undefined) {
    mediaGroupImages.set(mediaGroupId, { chatId: message.chat.id, items: [candidate] });
    return;
  }
  if (entry.chatId !== message.chat.id || entry.items.length >= MEDIA_GROUP_ITEMS_MAX) return;
  for (const item of entry.items) {
    if (item.fileUniqueId === candidate.fileUniqueId) return;
  }
  entry.items.push(candidate);
}

/** 某群某个相册里已见过的图；不属于这个群或从没见过时为空。只读，不刷新 LRU 位置。 */
export function mediaGroupImagesIn(chatId: number, mediaGroupId: string): readonly MessageImageCandidate[] {
  const entry: MediaGroupImages | undefined = mediaGroupImages.peek(mediaGroupId);
  return entry?.chatId === chatId ? entry.items : [];
}
