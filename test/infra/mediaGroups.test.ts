import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { mediaGroupImages } from "../../packages/cache/main/mediaGroups";
import { MEDIA_GROUP_CACHE_MAX, MEDIA_GROUP_ITEMS_MAX } from "../../packages/consts/hImage";
import { mediaGroupImagesIn, observeMediaGroupImage } from "../../packages/infra/mediaGroups";

function albumPhoto(chatId: number, group: string, uniqueId: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
    media_group_id: group,
    photo: [{ file_id: `f-${uniqueId}`, file_unique_id: uniqueId, width: 1, height: 1 }],
  } as unknown as Message;
}

beforeEach(() => {
  for (const key of [...mediaGroupImages.keys()]) mediaGroupImages.delete(key);
});

describe("相册缓存", () => {
  test("同一相册的图按到达顺序记下，重复到达只记一次", () => {
    observeMediaGroupImage(albumPhoto(-1, "g1", "a"));
    observeMediaGroupImage(albumPhoto(-1, "g1", "b"));
    observeMediaGroupImage(albumPhoto(-1, "g1", "a"));
    expect(mediaGroupImagesIn(-1, "g1").map((item) => item.fileUniqueId)).toEqual(["a", "b"]);
  });

  test("按群核对归属：别的群查不到，也写不进别的群的相册", () => {
    observeMediaGroupImage(albumPhoto(-1, "g1", "a"));
    observeMediaGroupImage(albumPhoto(-2, "g1", "b"));
    expect(mediaGroupImagesIn(-2, "g1")).toEqual([]);
    expect(mediaGroupImagesIn(-1, "g1").map((item) => item.fileUniqueId)).toEqual(["a"]);
  });

  test("私聊、不是图或没有相册 id 的消息不记", () => {
    observeMediaGroupImage(albumPhoto(7, "g-private", "a"));
    observeMediaGroupImage({ ...albumPhoto(-1, "g-text", "a"), photo: undefined, text: "hi" } as unknown as Message);
    observeMediaGroupImage({ ...albumPhoto(-1, "g-none", "a"), media_group_id: undefined } as unknown as Message);
    expect(mediaGroupImages.size).toBe(0);
  });

  test("每组至多 MEDIA_GROUP_ITEMS_MAX 张，相册数超过 MEDIA_GROUP_CACHE_MAX 时淘汰最旧的", () => {
    for (let index: number = 0; index <= MEDIA_GROUP_ITEMS_MAX; index++) observeMediaGroupImage(albumPhoto(-1, "full", `u${index}`));
    expect(mediaGroupImagesIn(-1, "full")).toHaveLength(MEDIA_GROUP_ITEMS_MAX);
    for (let index: number = 0; index < MEDIA_GROUP_CACHE_MAX; index++) observeMediaGroupImage(albumPhoto(-1, `g${index}`, "a"));
    expect(mediaGroupImagesIn(-1, "full")).toEqual([]);
    expect(mediaGroupImages.size).toBe(MEDIA_GROUP_CACHE_MAX);
  });
});
