import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AVATAR_FETCH_MAX_ATTEMPTS } from "../../packages/consts/telegram";
import { downloadAvatarFile } from "../../packages/infra/telegram/avatar/download";
import { restoreDefaultProfilePhoto } from "../../packages/infra/telegram/avatar/restore";
import { fetchAvatarFromWebProfile } from "../../packages/infra/telegram/avatar/webProfile";
import { bot } from "../../packages/infra/telegram/mainClient";
import type { HydratedTelegramFile } from "../../packages/infra/telegram/mainClient";

const realFetch: typeof fetch = globalThis.fetch;
const responses: Response[] = [];
const avatarUrl: string = "https://cdn1.telesco.pe/avatar.jpg";
const profile: string = `<img class="tgme_page_photo_image" src="${avatarUrl}">`;
const image: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach((): void => {
  spyOn(bot.api, "getFile").mockResolvedValue({
    file_path: "avatar.jpg", getUrl: (): string => avatarUrl,
  } as HydratedTelegramFile);
  spyOn(bot.api, "setMyProfilePhoto").mockResolvedValue(true);
});

afterEach(async (): Promise<void> => {
  globalThis.fetch = realFetch;
  for (const response of responses) {
    if (!response.bodyUsed) await response.body?.cancel().catch((): undefined => undefined);
  }
  responses.length = 0;
  mock.restore();
});

for (const stage of ["api", "default", "page", "image"] as const) {
  test.each([false, true])(`${stage} HTTP 失败及时取消响应体，取消拒绝=%s`, async (rejectCancel: boolean): Promise<void> => {
    let calls: number = 0;
    let cancelled: number = 0;
    globalThis.fetch = mock(async (): Promise<Response> => {
      calls++;
      if (stage === "image" && calls === 1) return new Response(profile);
      const response: Response = new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelled++;
          if (rejectCancel) throw new Error("fixture cancellation rejected");
        },
      }), { status: 503 });
      responses.push(response);
      return response;
    }) as unknown as typeof fetch;
    if (stage === "api") {
      expect(await downloadAvatarFile("avatar", 42)).toEqual({ status: "transient-failure" });
    } else if (stage === "default") {
      expect(await restoreDefaultProfilePhoto(avatarUrl)).toBe(false);
    } else {
      expect(await fetchAvatarFromWebProfile("CopyNinjiaBot")).toBeNull();
    }
    expect(cancelled).toBe(stage === "default" ? AVATAR_FETCH_MAX_ATTEMPTS : 1);
    expect(calls).toBe(stage === "default" ? AVATAR_FETCH_MAX_ATTEMPTS : stage === "image" ? 2 : 1);
    expect(responses.every((response: Response): boolean => response.bodyUsed)).toBe(true);
  });
}

test("成功头像响应完整读取且不走失败取消", async (): Promise<void> => {
  let cancelled: number = 0;
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    if (String(input).startsWith("https://telegram.me/")) return new Response(profile);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(image.slice(0, 3));
        controller.enqueue(image.slice(3));
        controller.close();
      },
      cancel(): void { cancelled++; },
    }));
  }) as unknown as typeof fetch;
  expect(await downloadAvatarFile("avatar", 42)).toEqual({ status: "ok", bytes: image });
  expect(await restoreDefaultProfilePhoto(avatarUrl)).toBe(true);
  expect(await fetchAvatarFromWebProfile("CopyNinjiaBot")).toEqual(image);
  expect(cancelled).toBe(0);
});
