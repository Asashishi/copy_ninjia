import { beforeEach, describe, expect, mock, test } from "bun:test";

const getProjectId = mock(async (): Promise<string> => "project-123");
const translateText = mock(async (..._args: unknown[]) => [{ translations: [{ translatedText: "こんにちは" }] }]);
const close = mock(async (): Promise<void> => {});
const loggerError = mock((..._args: unknown[]): void => {});
let constructedClients: number = 0;

class TranslationServiceClient {
  getProjectId = getProjectId;
  translateText = translateText;
  close = close;
  constructor(_options: unknown) { constructedClients++; }
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

const {
  closeTranslate,
  drainTranslate,
  initTranslate,
  quiesceTranslate,
  translateToJapanese,
} = await import("../../src/copy/translate");
const { translateParentCache } = await import("../../src/cache/translate");

beforeEach(async () => {
  await closeTranslate();
  translateParentCache.parent = null;
  constructedClients = 0;
  getProjectId.mockClear();
  translateText.mockClear();
  close.mockClear();
  loggerError.mockClear();
  getProjectId.mockImplementation(async (): Promise<string> => "project-123");
  translateText.mockImplementation(async () => [{ translations: [{ translatedText: "こんにちは" }] }]);
  close.mockImplementation(async (): Promise<void> => {});
  initTranslate();
});

describe("Google Translation 适配层", () => {
  test("缓存 project parent，并发送固定的日语纯文本请求", async () => {
    await expect(translateToJapanese("你好")).resolves.toBe("こんにちは");
    await expect(translateToJapanese("早上好")).resolves.toBe("こんにちは");

    expect(getProjectId).toHaveBeenCalledTimes(1);
    expect(translateText).toHaveBeenNthCalledWith(
      1,
      {
        parent: "projects/project-123/locations/global",
        contents: ["你好"],
        mimeType: "text/plain",
        targetLanguageCode: "ja",
      },
      { timeout: 2_500 }
    );
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

  test("quiesce 后拒绝新翻译且不构造客户端", async () => {
    quiesceTranslate();
    await expect(translateToJapanese("不应发出")).resolves.toBeNull();
    expect(constructedClients).toBe(0);
    expect(getProjectId).not.toHaveBeenCalled();
  });

  test("在途请求可排空，超时会报告但仍能关闭客户端", async () => {
    let release!: (value: { translations: { translatedText: string }[] }[]) => void;
    translateText.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const translating = translateToJapanese("pending");
    await Bun.sleep(0);

    await expect(drainTranslate(1)).resolves.toBe("timedOut");
    await expect(closeTranslate()).resolves.toBe("flushed");
    expect(close).toHaveBeenCalledTimes(1);

    release([{ translations: [{ translatedText: "完了" }] }]);
    await expect(translating).resolves.toBe("完了");
    await expect(drainTranslate(20)).resolves.toBe("flushed");
  });

  test("getProjectId 在 close 后迟到不会回填 parent 或重建客户端", async () => {
    let releaseProject!: (projectId: string) => void;
    getProjectId.mockImplementationOnce(() => new Promise((resolve) => { releaseProject = resolve; }));
    const translating = translateToJapanese("pending project");
    await Bun.sleep(0);

    await expect(drainTranslate(1)).resolves.toBe("timedOut");
    await expect(closeTranslate()).resolves.toBe("flushed");
    releaseProject("late-project");

    await expect(translating).resolves.toBeNull();
    expect(constructedClients).toBe(1);
    expect(translateText).not.toHaveBeenCalled();
    expect(translateParentCache.parent).toBeNull();
  });

  test("close 释放客户端和 parent，再次 init 创建全新客户端", async () => {
    await translateToJapanese("first");
    await expect(closeTranslate()).resolves.toBe("flushed");
    expect(translateParentCache.parent).toBeNull();

    initTranslate();
    await translateToJapanese("second");
    expect(constructedClients).toBe(2);
    expect(getProjectId).toHaveBeenCalledTimes(2);
  });

  test("close 失败返回非成功结果并仍释放客户端引用", async () => {
    await translateToJapanese("create client");
    close.mockRejectedValueOnce(new Error("close failed"));

    await expect(closeTranslate(20)).resolves.toBe("failed");
    expect(loggerError).toHaveBeenLastCalledWith(
      "Error closing Google Translation client:",
      expect.any(Error)
    );

    initTranslate();
    await translateToJapanese("new client");
    expect(constructedClients).toBe(2);
  });
});
