import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { waitUntil } from "../helpers/waitUntil";
import type {
  AdSampleConfig,
  ConfigReadiness,
  HotDeploymentConfigChanges,
  MoodConfig,
  StickerConfig,
} from "../../packages/types/config";

const syncAiChatConfig = mock((_changes: HotDeploymentConfigChanges): void => {});
const resumeAiChat = mock((): void => {});
const syncAntiRaidAgentConfig = mock((): void => {});
const loggerLog = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const TEST_DEBOUNCE_MS: number = 100;

mock.module("../../packages/aiChat", () => ({ resumeAiChat, syncAiChatConfig }));
mock.module("../../packages/antiRaid", () => ({ syncAntiRaidAgentConfig }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ log: loggerLog, error: loggerError }),
}));
mock.module("../../packages/consts/configReload", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: TEST_DEBOUNCE_MS,
}));

const { quiesceConfigReload, startConfigReload } = await import("../../packages/app/configReload");
const { configReloadRuntime } = await import("../../packages/cache/main/configReload");
const {
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} = await import("../../packages/cache/perThread/config");
const { adDetectConfigReadinessCache, aiChatConfigReadinessCache } = await import("../../packages/cache/main/configReadiness");
const { AD_SAMPLES_CONFIG_PATH, MOOD_CONFIG_PATH, STICKERS_CONFIG_PATH } = await import("../../packages/consts/paths");

const originalMoodText: string = await Bun.file(MOOD_CONFIG_PATH).text();
const originalStickerText: string = await Bun.file(STICKERS_CONFIG_PATH).text();
const originalAdSampleText: string = await Bun.file(AD_SAMPLES_CONFIG_PATH).text();
const originalMood: MoodConfig | null = defaultMoodConfigCache.current;
const originalStickers: StickerConfig | null = defaultStickerConfigCache.current;
const originalAdSamples: AdSampleConfig | null = defaultAdSampleConfigCache.current;

/** 让一份合法心情表的档位名随编号变化，便于区分每一轮。 */
function moodDocument(label: string): string {
  return `${JSON.stringify({ moods: [{ name: label, weight: 100, instruction: `${label}。` }] })}\n`;
}

/** 留出防抖窗口加一轮读取的时间；只用于启动对账与「不该发生」的负向断言。 */
async function settle(): Promise<void> {
  await Bun.sleep(TEST_DEBOUNCE_MS * 3);
}

beforeEach((): void => {
  syncAiChatConfig.mockClear();
  resumeAiChat.mockClear();
  resumeAiChat.mockImplementation((): void => {});
  syncAntiRaidAgentConfig.mockClear();
  loggerLog.mockClear();
  loggerError.mockClear();
});

afterEach(async (): Promise<void> => {
  quiesceConfigReload();
  await Bun.write(MOOD_CONFIG_PATH, originalMoodText);
  await Bun.write(STICKERS_CONFIG_PATH, originalStickerText);
  await Bun.write(AD_SAMPLES_CONFIG_PATH, originalAdSampleText);
  defaultMoodConfigCache.current = originalMood;
  defaultStickerConfigCache.current = originalStickers;
  defaultAdSampleConfigCache.current = originalAdSamples;
  aiChatConfigReadinessCache.current = { ok: true };
  adDetectConfigReadinessCache.current = { ok: true };
});

/** 读取当前发布的结论；holder 为空视作测试前置被破坏。 */
function published(cache: { current: ConfigReadiness | null }): ConfigReadiness {
  if (cache.current === null) throw new Error("readiness was never published");
  return cache.current;
}

afterAll((): void => {
  quiesceConfigReload();
});

describe("config/ 目录监听", () => {
  test("启动时对账一轮；内容未变时不分发也不记日志", async () => {
    startConfigReload();
    await settle();
    expect(syncAiChatConfig).not.toHaveBeenCalled();
    expect(syncAntiRaidAgentConfig).not.toHaveBeenCalled();
    expect(loggerLog).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
    expect(configReloadRuntime.watcher).not.toBeNull();
  });

  test("文件改动在防抖后替换主线程快照并只分发给持有副本的 Worker", async () => {
    startConfigReload();
    await settle();
    await Bun.write(MOOD_CONFIG_PATH, moodDocument("平静"));

    expect(await waitUntil((): boolean => syncAiChatConfig.mock.calls.length > 0)).toBe(true);
    const changes: HotDeploymentConfigChanges = syncAiChatConfig.mock.calls[0]![0];
    expect(changes.mood).toBe(true);
    expect(changes.stickers).toBe(false);
    expect(changes.aiAgent).toBe(false);
    expect(defaultMoodConfigCache.current?.moods[0]?.name).toBe("平静");
    expect(syncAntiRaidAgentConfig).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith(`Reloaded deployment config ${MOOD_CONFIG_PATH}.`);
  });

  test("连续写入合并到防抖窗口之后，只应用最后一份内容", async () => {
    startConfigReload();
    await settle();
    for (let index: number = 0; index < 5; index++) {
      await Bun.write(MOOD_CONFIG_PATH, moodDocument(`档位${index}`));
    }

    expect(await waitUntil((): boolean => defaultMoodConfigCache.current?.moods[0]?.name === "档位4")).toBe(true);
    await settle();
    expect(syncAiChatConfig).toHaveBeenCalledTimes(1);
  });

  test("非法内容被拒绝并记错误日志，修好之后照常生效", async () => {
    startConfigReload();
    await settle();
    await Bun.write(STICKERS_CONFIG_PATH, "{\"packs\": [\"bad name\"]}\n");

    expect(await waitUntil((): boolean => loggerError.mock.calls.length > 0)).toBe(true);
    expect(loggerError.mock.calls[0]![0]).toBe(
      "Rejected a runtime deployment config change; keeping the last validated snapshot: " +
      `${STICKERS_CONFIG_PATH}: $.packs[0] must be a valid Telegram sticker pack short name.`
    );
    expect(syncAiChatConfig).not.toHaveBeenCalled();

    await Bun.write(STICKERS_CONFIG_PATH, "{\"packs\": [\"NewPack_1\"]}\n");
    expect(await waitUntil((): boolean => syncAiChatConfig.mock.calls.length > 0)).toBe(true);
    expect(syncAiChatConfig.mock.calls[0]![0].stickers).toBe(true);
  });

  test("删除 AI 前提文件立即关闭 AI 闲聊，Worker 闲置；恢复文件后先恢复 Worker 再发布可用", async () => {
    startConfigReload();
    await settle();
    await Bun.file(MOOD_CONFIG_PATH).delete();

    expect(await waitUntil((): boolean => !published(aiChatConfigReadinessCache).ok)).toBe(true);
    expect(published(aiChatConfigReadinessCache)).toEqual({
      ok: false,
      failure: {
        file: "config/mood.json",
        reason: `${MOOD_CONFIG_PATH}: $ must be a readable valid JSON document.`,
      },
    });
    expect(defaultMoodConfigCache.current).toBeNull();
    expect(syncAiChatConfig).not.toHaveBeenCalled();
    expect(resumeAiChat).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith(`Deployment config ${MOOD_CONFIG_PATH} was removed.`);

    let readyWhileResuming: boolean | undefined;
    resumeAiChat.mockImplementation((): void => {
      readyWhileResuming = published(aiChatConfigReadinessCache).ok;
    });
    await Bun.write(MOOD_CONFIG_PATH, moodDocument("回来了"));

    expect(await waitUntil((): boolean => published(aiChatConfigReadinessCache).ok)).toBe(true);
    expect(resumeAiChat).toHaveBeenCalledTimes(1);
    expect(readyWhileResuming).toBe(false);
    expect(syncAiChatConfig).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith("AI chat became available after a deployment config reload.");
  });

  test("恢复 Worker 失败时保持不可用并记错误日志，下一次事件重试", async () => {
    startConfigReload();
    await settle();
    await Bun.file(MOOD_CONFIG_PATH).delete();
    expect(await waitUntil((): boolean => !published(aiChatConfigReadinessCache).ok)).toBe(true);

    resumeAiChat.mockImplementation((): void => {
      throw new Error("worker refused");
    });
    await Bun.write(MOOD_CONFIG_PATH, moodDocument("第一次"));
    expect(await waitUntil((): boolean => loggerError.mock.calls.length > 0)).toBe(true);
    expect(loggerError.mock.calls[0]![0]).toBe(
      "AI chat could not resume after a deployment config reload; it stays unavailable until the next config change:"
    );
    expect(published(aiChatConfigReadinessCache).ok).toBe(false);

    resumeAiChat.mockImplementation((): void => {});
    await Bun.write(STICKERS_CONFIG_PATH, "{\"packs\": [\"NewPack_1\"]}\n");
    expect(await waitUntil((): boolean => published(aiChatConfigReadinessCache).ok)).toBe(true);
    expect(resumeAiChat).toHaveBeenCalledTimes(2);
  });

  test("删除与恢复广告示例都会切换广告检测可用性并重投 Anti-Raid", async () => {
    startConfigReload();
    await settle();
    await Bun.file(AD_SAMPLES_CONFIG_PATH).delete();

    expect(await waitUntil((): boolean => !published(adDetectConfigReadinessCache).ok)).toBe(true);
    expect(published(adDetectConfigReadinessCache)).toMatchObject({ ok: false, failure: { file: "config/ad_samples.json" } });
    expect(syncAntiRaidAgentConfig).toHaveBeenCalledTimes(1);
    expect(published(aiChatConfigReadinessCache).ok).toBe(true);

    await Bun.write(AD_SAMPLES_CONFIG_PATH, originalAdSampleText);
    expect(await waitUntil((): boolean => published(adDetectConfigReadinessCache).ok)).toBe(true);
    expect(syncAntiRaidAgentConfig).toHaveBeenCalledTimes(2);
    expect(loggerLog).toHaveBeenCalledWith("Ad detection became available after a deployment config reload.");
  });

  test("停止后不再接纳事件，watcher 与 timer 均已释放", async () => {
    startConfigReload();
    await settle();
    quiesceConfigReload();
    expect(configReloadRuntime.watcher).toBeNull();
    expect(configReloadRuntime.debounceTimer).toBeNull();

    await Bun.write(MOOD_CONFIG_PATH, moodDocument("停机后"));
    await settle();
    expect(syncAiChatConfig).not.toHaveBeenCalled();
    expect(defaultMoodConfigCache.current).toBe(originalMood);
  });
});
