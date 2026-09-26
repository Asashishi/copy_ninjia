import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { globalTtsUsageState, stateStoreHolder } from "../../../packages/cache/main/storage";
import { STATE_FLUSH_TIMEOUT_MS } from "../../../packages/consts/lifecycle";
import { logger } from "../../../packages/infra/logger";
import {
  StateStore,
  adoptTtsUsage,
  flushStateToDisk,
  loadState,
  persistGlobalState,
  setStatePersistenceFatalHandler,
} from "../../../packages/infra/storage/stateStore";

describe("全局状态落盘门面", () => {
  afterEach(() => {
    stateStoreHolder.current = null;
  });

  test("fatal handler 与 flush 原样转给当前 StateStore，flush 缺省预算与不 quiesce", async () => {
    const store: StateStore = new StateStore({
      stateFilePath: "/virtual/facade-state.json",
      writeText: async (): Promise<void> => {},
    });
    const setFatalHandler = spyOn(store, "setFatalHandler");
    const flush = spyOn(store, "flush");
    stateStoreHolder.current = store;
    const handler = (_error: Error): void => {};

    setStatePersistenceFatalHandler(handler);
    setStatePersistenceFatalHandler(undefined);
    await flushStateToDisk();
    await flushStateToDisk(25, true);

    expect(setFatalHandler.mock.calls).toEqual([[handler], [undefined]]);
    expect(flush.mock.calls).toEqual([[STATE_FLUSH_TIMEOUT_MS, false], [25, true]]);
  });
  test("全局状态落盘失败时带上下文包装错误", async () => {
    const store: StateStore = new StateStore({ stateFilePath: "/virtual/facade-state.json" });
    const failure: Error = new Error("disk full");
    spyOn(store, "save").mockRejectedValue(failure);
    stateStoreHolder.current = store;

    const persisted: Promise<void> = persistGlobalState("copy target");
    await expect(persisted).rejects.toThrow("Failed to persist global state update (copy target): disk full");
    await persisted.catch((error: unknown): void => {
      expect((error as Error).cause).toBe(failure);
    });
  });

  test("后台登记语音计数落盘失败只记错误日志，不向调用方抛出", async () => {
    const store: StateStore = new StateStore({ stateFilePath: "/virtual/facade-state.json" });
    const failure: Error = new Error("disk full");
    const save = spyOn(store, "save").mockRejectedValue(failure);
    const loggedError = spyOn(logger, "error").mockImplementation((): void => {});
    stateStoreHolder.current = store;
    try {
      adoptTtsUsage({ windowStartedAt: 1_700_000_000_000, count: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(save).toHaveBeenCalledTimes(1);
      expect(loggedError).toHaveBeenCalledWith(
        "Failed to persist background global state update (record TTS daily usage):",
        failure
      );
    } finally {
      globalTtsUsageState.current = null;
      loggedError.mockRestore();
    }
  });

  test("加载失败时记错误日志并原样抛出", async () => {
    const store: StateStore = new StateStore({ stateFilePath: "/virtual/facade-state.json" });
    const failure: Error = new Error("both copies are invalid");
    spyOn(store, "load").mockRejectedValue(failure);
    const loggedError = spyOn(logger, "error").mockImplementation((): void => {});
    stateStoreHolder.current = store;
    try {
      await expect(loadState()).rejects.toBe(failure);
      expect(loggedError).toHaveBeenCalledWith("Failed to load state:", failure);
    } finally {
      loggedError.mockRestore();
    }
  });
});
