import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TranslateLanguage } from "../../packages/types/translate";

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
mock.module("../../packages/consts/paths", () => ({ GOOGLE_AUTH_FILE_PATH: "/tmp/test-g-auth.json" }));
mock.module("../../packages/infra/logger", () => ({
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
  translateText: requestTranslation,
} = await import("../../packages/translate/client");
const { translateParentCache } = await import("../../packages/cache/main/translate");

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
  test.each(["uk", "ru"] as const)("%s 使用对应语言代码和默认翻译模型", async (language: TranslateLanguage) => {
    await expect(requestTranslation("你好", language)).resolves.toBe("こんにちは");
    expect(translateText).toHaveBeenCalledTimes(1);
    expect(translateText.mock.calls[0]?.[0]).toMatchObject({
      contents: ["你好"],
      mimeType: "text/plain",
      targetLanguageCode: language,
      model: undefined,
    });
  });

  test("简体中文使用 zh-CN，美式英语显式使用 en-US 与地区变体模型", async () => {
    await requestTranslation("こんにちは", "cn");
    expect(translateText.mock.calls[0]?.[0]).toMatchObject({ targetLanguageCode: "zh-CN" });
    await requestTranslation("你好", "en");
    expect(translateText.mock.calls[1]?.[0]).toMatchObject({
      targetLanguageCode: "en-US",
      model: "projects/project-123/locations/global/models/general/translation-llm",
    });
  });
  test("缓存 project parent，并发送固定的日语纯文本请求", async () => {
    await expect(requestTranslation("你好", "ja")).resolves.toBe("こんにちは");
    await expect(requestTranslation("早上好", "ja")).resolves.toBe("こんにちは");

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
    await expect(requestTranslation("empty", "ja")).resolves.toBeNull();
    translateText.mockResolvedValueOnce([{ translations: [{ translatedText: "" }] }]);
    await expect(requestTranslation("blank", "ja")).resolves.toBeNull();

    translateText.mockRejectedValueOnce(new Error("quota"));
    await expect(requestTranslation("failed", "ja")).resolves.toBeNull();
    expect(loggerError).toHaveBeenLastCalledWith("Error translating text:", expect.any(Error));
  });

  test("project ID 获取失败不写缓存，下次调用仍可重试", async () => {
    getProjectId.mockRejectedValueOnce(new Error("auth failed"));
    await expect(requestTranslation("first", "ja")).resolves.toBeNull();
    expect(translateParentCache.parent).toBeNull();

    await expect(requestTranslation("second", "ja")).resolves.toBe("こんにちは");
    expect(getProjectId).toHaveBeenCalledTimes(2);
  });

  test("quiesce 后拒绝新翻译且不构造客户端", async () => {
    quiesceTranslate();
    await expect(requestTranslation("不应发出", "ja")).resolves.toBeNull();
    expect(constructedClients).toBe(0);
    expect(getProjectId).not.toHaveBeenCalled();
  });

  test("在途请求可排空，超时会报告但仍能关闭客户端", async () => {
    let release!: (value: { translations: { translatedText: string }[] }[]) => void;
    translateText.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const translating = requestTranslation("pending", "ja");
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
    const translating = requestTranslation("pending project", "ja");
    await Bun.sleep(0);

    await expect(drainTranslate(1)).resolves.toBe("timedOut");
    await expect(closeTranslate()).resolves.toBe("flushed");
    releaseProject("late-project");

    await expect(translating).resolves.toBeNull();
    expect(constructedClients).toBe(1);
    expect(translateText).not.toHaveBeenCalled();
    expect(translateParentCache.parent).toBeNull();
  });

  test("SDK 动态 import 期间发生 close：不给已失效的 owner 造客户端，避免泄漏永不关闭的 gRPC 通道", async () => {
    // `await import(...)` 形成一个交错窗口：closeTranslate 会在这期间把 client
    // 置空并推进 generation，
    // 而它已经拿着 null 走完了关闭流程。若此时照旧构造并写回，就留下一个谁也
    // 不会去 close 的 gRPC 客户端——每次停机泄漏一个通道。
    //
    // 时序靠 closeTranslate 的同步前缀成立：它一进函数就 `generation += 1`，
    // 发生在任何微任务排空之前，因此 import resolve 时看到的必然是新世代。
    const translating = requestTranslation("during dynamic import", "ja");
    await expect(closeTranslate()).resolves.toBe("flushed");

    await expect(translating).resolves.toBeNull();
    expect(constructedClients).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(getProjectId).not.toHaveBeenCalled();
    expect(translateParentCache.parent).toBeNull();
  });

  test("close 释放客户端和 parent，再次 init 创建全新客户端", async () => {
    await requestTranslation("first", "ja");
    await expect(closeTranslate()).resolves.toBe("flushed");
    expect(translateParentCache.parent).toBeNull();

    initTranslate();
    await requestTranslation("second", "ja");
    expect(constructedClients).toBe(2);
    expect(getProjectId).toHaveBeenCalledTimes(2);
  });

  test("close 失败返回非成功结果并仍释放客户端引用", async () => {
    await requestTranslation("create client", "ja");
    close.mockRejectedValueOnce(new Error("close failed"));

    await expect(closeTranslate(20)).resolves.toBe("failed");
    expect(loggerError).toHaveBeenLastCalledWith(
      "Error closing Google Translation client:",
      expect.any(Error)
    );

    initTranslate();
    await requestTranslation("new client", "ja");
    expect(constructedClients).toBe(2);
  });
});
