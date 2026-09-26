import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { ensureRandomImageDirectory } from "../../packages/infra/randomImage";
import { installLifecycleFixtureHooks, lifecycleFixture } from "../helpers/lifecycleFixture";

installLifecycleFixtureHooks();

test("专用图库非法时启动非零退出，外部连接与 Worker 均未发生", async () => {
  const root: string = mkdtempSync(join(TEST_DATA_ROOT, "invalid-h-library-"));
  const directory: string = join(root, "library");
  mkdirSync(directory);
  await Bun.write(join(directory, "ordinary.png"), "preserve");
  const { prepareRandomImageDirectory, ApplicationLifecycle, testDependencies, initDiskIO,
    initTelegramClients, botInit } = lifecycleFixture;
  prepareRandomImageDirectory.mockImplementationOnce((): Promise<void> => ensureRandomImageDirectory(directory));
  try {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.run("main");
    await lifecycle.dispose();
    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(botInit).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual(["ordinary.png"]);
    expect(await Bun.file(join(directory, "ordinary.png")).text()).toBe("preserve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
