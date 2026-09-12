import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST_DATA_ROOT } from "../../preloadEnv";
import { InputValidationError } from "../../../packages/libs/inputValidation";
import { getTokyoDateKey } from "../../../packages/libs/time";

const root: string = mkdtempSync(join(TEST_DATA_ROOT, "recovery-topology-"));
const realPaths = await import("../../../packages/consts/paths");
const paths = {
  ...realPaths,
  LOGS_DIR: join(root, "logs"), AI_MEMORY_DIR: join(root, "memory", "ai"),
  STICKER_MEMORY_DIR: join(root, "memory", "stickers"), LUCK_MEMORY_DIR: join(root, "memory", "luck"),
  LUCK_RECEIPT_SECRET_PATH: join(root, "memory", "luck", "receipt-secret.json"),
  VERIFICATION_MEMORY_DIR: join(root, "memory", "verification"),
  JOIN_LOG_MEMORY_DIR: join(root, "memory", "join-log"), WED_MEMORY_DIR: join(root, "memory", "wed"),
};
mock.module("../../../packages/consts/paths", () => paths);
const { inspectVerificationDay } = await import("../../../packages/workers/diskIO/verificationRecovery");
const { inspectLogFiles } = await import("../../../packages/workers/diskIO/logFiles");
const { inspectLuckReceiptSecret } = await import("../../../packages/workers/diskIO/luckSecretFile");
const { inspectAiMemories, inspectStickerCatalogs, inspectLuckDay } = await import("../../../packages/workers/diskIO/snapshotFiles");
const { inspectJoinLogFiles } = await import("../../../packages/workers/diskIO/joinLogRecovery");
const { inspectWedMemberFiles } = await import("../../../packages/workers/diskIO/wedMemberFiles");
const { openAppendOnlyFile, openValidatedAppendOnlyFile } = await import("../../../packages/workers/diskIO/appendOnlyDayFile");
const today: string = getTokyoDateKey();
const yesterday: string = getTokyoDateKey(new Date(Date.now() - 86_400_000));
const domains: readonly Readonly<{ name: string; path: string; inspect: () => unknown }>[] = [
  { name: "verification today", path: join(paths.VERIFICATION_MEMORY_DIR, `${today}.json`), inspect: () => inspectVerificationDay(today) },
  { name: "verification prior", path: join(paths.VERIFICATION_MEMORY_DIR, `${yesterday}.json`), inspect: () => inspectVerificationDay(today) },
  { name: "logs", path: join(paths.LOGS_DIR, `${today}.json`), inspect: inspectLogFiles },
  { name: "luck", path: join(paths.LUCK_MEMORY_DIR, `${today}.json`), inspect: () => inspectLuckDay(today) },
  { name: "secret", path: paths.LUCK_RECEIPT_SECRET_PATH, inspect: () => inspectLuckReceiptSecret({ day: today, confirmedResultCount: 0 }) },
  { name: "AI", path: join(paths.AI_MEMORY_DIR, "-1001.json"), inspect: inspectAiMemories },
  { name: "stickers", path: join(paths.STICKER_MEMORY_DIR, "pack_a.json"), inspect: () => inspectStickerCatalogs(null) },
  { name: "join log", path: join(paths.JOIN_LOG_MEMORY_DIR, `-1001.${today}.json`), inspect: () => inspectJoinLogFiles(today) },
  { name: "wed", path: join(paths.WED_MEMORY_DIR, "-1001.json"), inspect: inspectWedMemberFiles },
  { name: "append async", path: join(root, "append", "day.json"), inspect: () => openAppendOnlyFile(join(root, "append", "day.json")) },
  { name: "append sync", path: join(root, "append", "day.json"), inspect: () => openValidatedAppendOnlyFile({ path: join(root, "append", "day.json"), content: "{}", empty: true }) },
];

beforeEach((): void => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
});
afterAll((): void => { rmSync(root, { recursive: true, force: true }); });

for (const domain of domains) {
  test.each(["directory", "dangling", "loop", "ancestor-file", "ancestor-dangling", "ancestor-loop"])(`${domain.name} 的 %s 输入不能视为缺省`, async (kind) => {
    const parent: string = dirname(domain.path);
    if (kind.startsWith("ancestor-")) {
      mkdirSync(dirname(parent), { recursive: true });
      if (kind === "ancestor-file") await Bun.write(parent, "private_marker");
      else symlinkSync(kind === "ancestor-loop" ? parent : join(root, "missing"), parent);
    } else {
      mkdirSync(parent, { recursive: true });
      if (kind === "directory") mkdirSync(domain.path);
      else symlinkSync(kind === "loop" ? domain.path : join(root, "missing"), domain.path);
    }
    await expect(Promise.resolve().then(domain.inspect)).rejects.toBeInstanceOf(InputValidationError);
  });
}

test("跨域恢复遇到路径异常时不发布 owner、不生成密钥也不清理已检查领域", async () => {
  const snapshots = await import("../../../packages/workers/diskIO/aiMemoryFiles");
  const logs = await import("../../../packages/workers/diskIO/logFiles");
  const secrets = await import("../../../packages/workers/diskIO/luckSecretFile");
  const { handleDiskIOStartupLoad } = await import("../../../packages/workers/diskIO/startup");
  const adoptAi = spyOn(snapshots, "adoptAiMemorySnapshots");
  const adoptLogs = spyOn(logs, "adoptLogFiles");
  const adoptSecret = spyOn(secrets, "adoptLuckReceiptSecret");
  const report = spyOn(console, "error").mockImplementation((): void => {});
  const aiPath: string = join(paths.AI_MEMORY_DIR, "-1001.json");
  const stale: string = join(paths.VERIFICATION_MEMORY_DIR, `${yesterday}.json`);
  const temporary: string = join(paths.AI_MEMORY_DIR, "orphan.tmp");
  const json: string = JSON.stringify({ version: 1, buffer: [], summaries: [], pendingSummary: null, savedAt: 1 });
  try {
    await Bun.write(aiPath, json);
    await Bun.write(temporary, "keep temporary bytes");
    await Bun.write(stale, "{}");
    mkdirSync(join(paths.VERIFICATION_MEMORY_DIR, `${today}.json`));
    const replies: Parameters<Parameters<typeof handleDiskIOStartupLoad>[1]>[0][] = [];
    await handleDiskIOStartupLoad(null, (reply): void => { replies.push(reply); });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: "loaded", error: expect.stringContaining(`${today}.json: $type`) });
    expect(adoptAi).not.toHaveBeenCalled();
    expect(adoptLogs).not.toHaveBeenCalled();
    expect(adoptSecret).not.toHaveBeenCalled();
    expect(await Bun.file(paths.LUCK_RECEIPT_SECRET_PATH).exists()).toBe(false);
    expect(await Bun.file(aiPath).text()).toBe(json);
    expect(await Bun.file(stale).text()).toBe("{}");
    expect(await Bun.file(temporary).text()).toBe("keep temporary bytes");
  } finally {
    adoptAi.mockRestore(); adoptLogs.mockRestore(); adoptSecret.mockRestore(); report.mockRestore();
  }
});
