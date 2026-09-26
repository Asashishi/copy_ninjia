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
  testDependencies,
} = sharedFixture;

installLifecycleFixtureHooks();

/**
 * 启动总闸对 memory/global/state.json 的真实字节判定。
 *
 * 只有 `loadState` 接到真实临时 `StateStore.load()`，其余出站依旧是 fixture 的
 * mock：这条链路要验证的是「磁盘上确有一份非法状态文件时进程拒绝启动」，不是
 * Telegram 或 Worker 行为。写盘同样注入 mock，用来断言被拒绝的启动一个字节都
 * 没有回写。
 */
describe("启动总闸的全局状态输入判定", () => {
  const legal: string = '{"copy":{"copiedUser":{"id":1,"first_name":"X"},"copyChatId":-1}}';

  let dir: string;
  let statePath: string;
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
    useRealStateLoad();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("状态文件含非法 UTF-8 时以非零码退出，且不建立任何对外连接", async () => {
    const bytes: Uint8Array = new TextEncoder().encode(legal);
    bytes[legal.indexOf('"X"') + 1] = 0xff;
    await Bun.write(statePath, bytes);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(registerCommandMenu).not.toHaveBeenCalled();
    expect(botInit).not.toHaveBeenCalled();
    expect(initAiChat).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    // 运维接着要排查的就是这份文件：字节保持原样，也不产生隔离件。
    expect(Array.from(await Bun.file(statePath).bytes())).toEqual(Array.from(bytes));
    expect(readdirSync(dir)).toEqual(["state.json"]);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("状态路径被占成目录时拒绝启动", async () => {
    mkdirSync(statePath);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("合法状态文件让启动继续推进到 Worker 初始化", async () => {
    await Bun.write(statePath, legal);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(0);
    expect(initDiskIO).toHaveBeenCalledTimes(1);
    expect(initTelegramClients).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  test("仍是 14.x 的 global 包装时联网前拒绝启动，字节不变", async () => {
    const legacy: string = JSON.stringify({ global: JSON.parse(legal) });
    await Bun.write(statePath, legacy);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run("main");
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(await Bun.file(statePath).text()).toBe(legacy);
  });
});
