import { expect, mock, test } from "bun:test";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import type * as Paths from "../../packages/consts/paths";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { lifecycleFixture as fixture, installLifecycleFixtureHooks } from "../helpers/lifecycleFixture";
import { emitSuccessfulDiskIOLoad, FakeDiskIOWorker, installFakeDiskIOWorker } from "../helpers/diskIOWorkerHarness";
import { validateExistingDeploymentInputs, aiChatConfigReadiness } from "../../packages/config/readiness";
import { defaultStickerConfigCache } from "../../packages/cache/perThread/config";
import { pendingLoad } from "../../packages/cache/main/diskIO";
import { initDiskIO, loadPersistedData, terminateDiskIO } from "../../packages/infra/diskIO";
import { STICKERS_CONFIG_PATH } from "../../packages/consts/paths";

const realPaths: typeof Paths = await import("../../packages/consts/paths");
mock.module("../../packages/consts/paths", (): typeof Paths => ({
  ...realPaths,
  GOOGLE_AUTH_FILE_PATH: join(TEST_DATA_ROOT, "g-auth.json"),
}));

installLifecycleFixtureHooks();

test("可选贴纸文件缺省时真实预检与恢复握手通过，生命周期正常完成并清理等待器", async (): Promise<void> => {
  expect(STICKERS_CONFIG_PATH.startsWith("/tmp/")).toBeTrue();
  const content: string = await Bun.file(STICKERS_CONFIG_PATH).text();
  const config: typeof defaultStickerConfigCache.current = defaultStickerConfigCache.current;
  const restoreWorker: () => void = installFakeDiskIOWorker();
  try {
    await Bun.file(STICKERS_CONFIG_PATH).delete();
    defaultStickerConfigCache.current = null;
    const application: InstanceType<typeof fixture.ApplicationLifecycle> = new fixture.ApplicationLifecycle({
      ...fixture.testDependencies,
      validateExistingDeploymentInputs,
      initDiskIO,
      loadPersistedData: async (): Promise<Awaited<ReturnType<typeof loadPersistedData>>> => {
        const loading: ReturnType<typeof loadPersistedData> = loadPersistedData();
        const worker: FakeDiskIOWorker = FakeDiskIOWorker.instances[0]!;
        expect(worker.messages[0]).toEqual({ type: "load", stickerPacks: null });
        emitSuccessfulDiskIOLoad(worker);
        return await loading;
      },
      terminateDiskIO,
    });
    await application.run("test");
    expect(aiChatConfigReadiness().ok).toBeFalse();
    expect(fixture.initTelegramClients).toHaveBeenCalledTimes(1);
    expect(fixture.runnerTask).toHaveBeenCalledTimes(1);
    expect(FakeDiskIOWorker.instances).toHaveLength(1);
    expect(FakeDiskIOWorker.instances[0]!.terminated).toBeTrue();
    expect(pendingLoad.timer).toBeNull();
    expect(pendingLoad.resolve).toBeNull();
    expect(pendingLoad.reject).toBeNull();
    expect(process.exitCode ?? 0).toBe(0);
  } finally {
    await terminateDiskIO();
    await Bun.write(STICKERS_CONFIG_PATH, content);
    defaultStickerConfigCache.current = config;
    restoreWorker();
  }
});

test("贴纸文件存在但格式非法时，生命周期在创建 Worker 和 Telegram 客户端前拒绝启动", async (): Promise<void> => {
  expect(STICKERS_CONFIG_PATH.startsWith("/tmp/")).toBeTrue();
  const content: string = await Bun.file(STICKERS_CONFIG_PATH).text();
  const config: typeof defaultStickerConfigCache.current = defaultStickerConfigCache.current;
  try {
    await Bun.write(STICKERS_CONFIG_PATH, JSON.stringify({ packs: [1] }));
    defaultStickerConfigCache.current = null;
    const application: InstanceType<typeof fixture.ApplicationLifecycle> = new fixture.ApplicationLifecycle({
      ...fixture.testDependencies,
      validateExistingDeploymentInputs,
    });
    await expect(application.run("test")).rejects.toThrow("stickers.json");
    expect(fixture.initDiskIO).not.toHaveBeenCalled();
    expect(fixture.initTelegramClients).not.toHaveBeenCalled();
    expect(pendingLoad.timer).toBeNull();
  } finally {
    await Bun.write(STICKERS_CONFIG_PATH, content);
    defaultStickerConfigCache.current = config;
  }
});

test("显式错误 Google 凭据类型在外部连接前拒绝，保留原文件", async (): Promise<void> => {
  const { GOOGLE_AUTH_FILE_PATH }: typeof Paths = await import("../../packages/consts/paths");
  expect(GOOGLE_AUTH_FILE_PATH.startsWith("/tmp/")).toBeTrue();
  const authFile: Bun.BunFile = Bun.file(GOOGLE_AUTH_FILE_PATH);
  const original: string | undefined = await authFile.exists() ? await authFile.text() : undefined;
  const privateKey: string = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const content: string = JSON.stringify({ type: "authorized_user", client_email: "bot@example.com", private_key: privateKey });
  try {
    await Bun.write(authFile, content);
    const application: InstanceType<typeof fixture.ApplicationLifecycle> = new fixture.ApplicationLifecycle({
      ...fixture.testDependencies, validateExistingDeploymentInputs,
    });
    await expect(application.run("test")).rejects.toThrow('g-auth.json: $.type must be "service_account".');
    expect(fixture.initDiskIO).not.toHaveBeenCalled();
    expect(fixture.initTelegramClients).not.toHaveBeenCalled();
    expect(await Bun.file(GOOGLE_AUTH_FILE_PATH).text()).toBe(content);
  } finally {
    if (original === undefined) await authFile.delete();
    else await Bun.write(authFile, original);
  }
});
