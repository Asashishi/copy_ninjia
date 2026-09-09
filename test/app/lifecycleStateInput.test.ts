import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../packages/infra/storage/statePersistence";
import {
  installLifecycleFixtureHooks,
  lifecycleFixture as sharedFixture,
} from "../helpers/lifecycleFixture";

const {
  ApplicationLifecycle,
  botInit,
  initAiChat,
  initDiskIO,
  initTelegramClients,
  loadState,
  registerCommandMenu,
  releaseSingleInstanceLock,
  seedMissingAssetState,
  testDependencies,
} = sharedFixture;

installLifecycleFixtureHooks();

/**
 * 启动总闸对 state 副本的真实字节判定。
 *
 * 只有 `loadState` 接到真实临时 `StateStore.load()`，其余出站依旧是 fixture 的
 * mock：这条链路要验证的是「磁盘上确有一份非法副本时进程拒绝启动」，不是
 * Telegram 或 Worker 行为。写盘同样注入 mock，用来断言被拒绝的启动一个字节都
 * 没有回写。
 */
describe("启动总闸的 state 输入判定", () => {
  const legal: string = '{"global":{"copy":{"copiedUser":{"id":1,"first_name":"X"},"copyChatId":-1}}}';

  let dir: string;
  let statePath: string;
  let backupPath: string;
  let writes: string[];

  /** 把 fixture 的 loadState 换成真实 StateStore；写入仍走 mock 计数。 */
  function useRealStateLoad(): void {
    writes = [];
    loadState.mockImplementation(async (): Promise<void> => {
      const store = new StateStore({
        stateFilePath: statePath,
        writeText: async (path: string): Promise<void> => { writes.push(path); },
      });
      try {
        await store.load();
      } finally {
        store.dispose();
      }
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lifecycle-state-input-"));
    statePath = join(dir, "state.json");
    backupPath = `${statePath}.bak`;
    useRealStateLoad();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("主副本含非法 UTF-8 时以非零码退出，且不建立任何对外连接", async () => {
    const bytes: Uint8Array = new TextEncoder().encode(legal);
    bytes[legal.indexOf('"X"') + 1] = 0xff;
    await Bun.write(statePath, bytes);
    await Bun.write(backupPath, legal);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(registerCommandMenu).not.toHaveBeenCalled();
    expect(botInit).not.toHaveBeenCalled();
    expect(initAiChat).not.toHaveBeenCalled();
    expect(seedMissingAssetState).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    // 运维接着要排查的就是这两份文件：字节保持原样，也不产生隔离件。
    expect(Array.from(await Bun.file(statePath).bytes())).toEqual(Array.from(bytes));
    expect(await Bun.file(backupPath).text()).toBe(legal);
    expect(readdirSync(dir)).toEqual(["state.json", "state.json.bak"]);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("备份路径被占成目录时同样拒绝启动，不因主副本合法而放行", async () => {
    await Bun.write(statePath, legal);
    // 备份路径被占成目录：exists() 对目录返回 false，只有 stat 能识别。
    mkdirSync(backupPath);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(seedMissingAssetState).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(await Bun.file(statePath).text()).toBe(legal);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, {}, { "-1": [
    { translatedUser: { id: 2 }, language: "en" },
    { translatedUser: { id: 3 }, language: "uk" },
    { translatedUser: { id: 4 }, language: "ru" },
  ] }])("可选翻译状态 %j 合法时启动继续推进到 Worker 初始化", async (translate: unknown) => {
    const content: string = JSON.stringify({ ...JSON.parse(legal), translate });
    await Bun.write(statePath, content);
    await Bun.write(backupPath, content);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(0);
    expect(initDiskIO).toHaveBeenCalledTimes(1);
    expect(initTelegramClients).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  test.each(["primary", "backup"])("%s 翻译状态非法时联网前拒绝启动，主备字节不变", async (copy: string) => {
    const invalid: string = JSON.stringify({ ...JSON.parse(legal), translate: { "-1": [{ translatedUser: { id: 2 }, language: "invalid" }] } });
    const primary: string = copy === "primary" ? invalid : legal;
    const backup: string = copy === "backup" ? invalid : legal;
    await Bun.write(statePath, primary);
    await Bun.write(backupPath, backup);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.run("main");
    await lifecycle.dispose();
    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(seedMissingAssetState).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(await Bun.file(statePath).text()).toBe(primary);
    expect(await Bun.file(backupPath).text()).toBe(backup);
  });
});
