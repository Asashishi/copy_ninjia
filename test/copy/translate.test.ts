import { beforeEach, describe, expect, mock, test } from "bun:test";

const getProjectId = mock(async (): Promise<string> => "project-123");
const translateText = mock(async (..._args: unknown[]) => [{ translations: [{ translatedText: "こんにちは" }] }]);
const loggerError = mock((..._args: unknown[]): void => {});

class TranslationServiceClient {
  getProjectId = getProjectId;
  translateText = translateText;
  constructor(_options: unknown) {}
}

mock.module("@google-cloud/translate", () => ({
  v3: { TranslationServiceClient },
}));
mock.module("../../src/consts/paths", () => ({ GOOGLE_AUTH_FILE_PATH: "/tmp/test-g-auth.json" }));
mock.module("../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const { translateToJapanese } = await import("../../src/copy/translate");
const { translateParentCache } = await import("../../src/cache/translate");

beforeEach(() => {
  translateParentCache.parent = null;
  getProjectId.mockClear();
  translateText.mockClear();
  loggerError.mockClear();
  getProjectId.mockImplementation(async (): Promise<string> => "project-123");
  translateText.mockImplementation(async () => [{ translations: [{ translatedText: "こんにちは" }] }]);
});

describe("Google Translation 适配层", () => {
  test("缓存 project parent，并发送固定的日语纯文本请求", async () => {
    await expect(translateToJapanese("你好")).resolves.toBe("こんにちは");
    await expect(translateToJapanese("早上好")).resolves.toBe("こんにちは");

    expect(getProjectId).toHaveBeenCalledTimes(1);
    expect(translateText).toHaveBeenNthCalledWith(1, {
      parent: "projects/project-123/locations/global",
      contents: ["你好"],
      mimeType: "text/plain",
      targetLanguageCode: "ja",
    });
  });

  test("空 translations、空字符串和 API 异常均返回 null", async () => {
    translateText.mockResolvedValueOnce([{}] as never);
    await expect(translateToJapanese("empty")).resolves.toBeNull();
    translateText.mockResolvedValueOnce([{ translations: [{ translatedText: "" }] }]);
    await expect(translateToJapanese("blank")).resolves.toBeNull();

    translateText.mockRejectedValueOnce(new Error("quota"));
    await expect(translateToJapanese("failed")).resolves.toBeNull();
    expect(loggerError).toHaveBeenLastCalledWith("Error translating text to Japanese:", expect.any(Error));
  });

  test("project ID 获取失败不写缓存，下次调用仍可重试", async () => {
    getProjectId.mockRejectedValueOnce(new Error("auth failed"));
    await expect(translateToJapanese("first")).resolves.toBeNull();
    expect(translateParentCache.parent).toBeNull();

    await expect(translateToJapanese("second")).resolves.toBe("こんにちは");
    expect(getProjectId).toHaveBeenCalledTimes(2);
  });
});
