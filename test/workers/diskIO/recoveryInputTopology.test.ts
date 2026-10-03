import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST_DATA_ROOT } from "../../preloadEnv";
import { InputValidationError } from "../../../packages/libs/inputValidation";
import { getDateKey } from "../../../packages/libs/time";

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
const { inspectStickerCatalogs, inspectLuckDay } = await import("../../../packages/workers/diskIO/snapshotFiles");
const { inspectJoinLogFiles } = await import("../../../packages/workers/diskIO/joinLogRecovery");
const { inspectWedMemberFiles } = await import("../../../packages/workers/diskIO/wedMemberFiles");
const { openAppendOnlyFile, openValidatedAppendOnlyFile } = await import("../../../packages/workers/diskIO/appendOnlyDayFile");
const today: string = getDateKey();
const yesterday: string = getDateKey(Date.now() - 86_400_000);
const domains: readonly Readonly<{ name: string; path: string; inspect: () => unknown }>[] = [
  { name: "verification today", path: join(paths.VERIFICATION_MEMORY_DIR, `${today}.json`), inspect: () => inspectVerificationDay(today) },
  { name: "verification prior", path: join(paths.VERIFICATION_MEMORY_DIR, `${yesterday}.json`), inspect: () => inspectVerificationDay(today) },
  { name: "logs", path: join(paths.LOGS_DIR, `${today}.json`), inspect: inspectLogFiles },
  { name: "luck", path: join(paths.LUCK_MEMORY_DIR, `${today}.json`), inspect: () => inspectLuckDay(today) },
  { name: "secret", path: paths.LUCK_RECEIPT_SECRET_PATH, inspect: () => inspectLuckReceiptSecret({ day: today, confirmedResultCount: 0 }) },
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
  const snapshots = await import("../../../packages/workers/diskIO/aiMemoryStorage");
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

test("SQLite 时区闸排在第一个 inspect：换时区先于未来日期的日文件报错", async () => {
  const { handleDiskIOStartupLoad } = await import("../../../packages/workers/diskIO/startup");
  const { getTimeZone } = await import("../../../packages/config/time");
  const { IDENTITY_DATABASE_TIME_ZONE_KEY } = await import("../../../packages/consts/identityStorage");
  const { DAY_MS } = await import("../../../packages/consts/diskIO/common");
  const { openStorageDatabase, closeStorageDatabase } = await import("../../../packages/database/interact/connection");
  const setMarker = (timeZone: string): void => {
    const database = openStorageDatabase({ path: realPaths.IDENTITY_DATABASE_PATH });
    try {
      database.$client.run(
        "UPDATE storage_metadata SET data = jsonb(?1) WHERE key = ?2;",
        [JSON.stringify({ timeZone }), IDENTITY_DATABASE_TIME_ZONE_KEY]
      );
    } finally { closeStorageDatabase(database); }
  };
  const report = spyOn(console, "error").mockImplementation((): void => {});
  const tomorrow: string = getDateKey(Date.now() + DAY_MS);
  const configured: string = getTimeZone();
  try {
    await Bun.write(join(paths.LUCK_MEMORY_DIR, `${tomorrow}.json`), "{}");
    const control: Parameters<Parameters<typeof handleDiskIOStartupLoad>[1]>[0][] = [];
    await handleDiskIOStartupLoad(null, (reply): void => { control.push(reply); });
    expect(control[0]).toMatchObject({ type: "loaded", error: expect.stringContaining(`${tomorrow}.json: $filename`) });

    setMarker(configured === "UTC" ? "Asia/Seoul" : "UTC");
    const replies: Parameters<Parameters<typeof handleDiskIOStartupLoad>[1]>[0][] = [];
    await handleDiskIOStartupLoad(null, (reply): void => { replies.push(reply); });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: "loaded",
      error: expect.stringContaining(`storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY} must be ${JSON.stringify({ timeZone: configured })}`),
    });
    expect(replies[0]).not.toMatchObject({ error: expect.stringContaining("$filename") });
  } finally {
    setMarker(configured);
    report.mockRestore();
  }
});
