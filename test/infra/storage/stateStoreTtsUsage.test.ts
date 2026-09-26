import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, adoptTtsUsage, getTtsUsage, loadState } from "../../../packages/infra/storage/stateStore";
import { globalTtsUsageState, stateStoreHolder } from "../../../packages/cache/main/storage";
import { decodeGlobalStateFile } from "../../../packages/libs/stateFileCodec";
import type { GlobalState } from "../../../packages/types/chatState";

/**
 * 全局状态的 `ttsUsage`：启动从 memory/global/state.json 恢复到主线程镜像，AI Worker 回执经 adoptTtsUsage 替换
 * 镜像并在后台写出，写出的文件能被同一个解码器读回。
 */
describe("语音合成每日计数的持久化", () => {
  let dir: string = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-tts-usage-test-"));
  });

  afterEach(() => {
    globalTtsUsageState.current = null;
    stateStoreHolder.current?.dispose();
    stateStoreHolder.current = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("启动恢复文件里的计数；缺省时为 null", async () => {
    const statePath: string = join(dir, "state.json");
    await Bun.write(statePath, JSON.stringify({
      copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 5_000, count: 7 },
    }));
    stateStoreHolder.current = new StateStore({ stateFilePath: statePath });
    await loadState();
    expect(getTtsUsage()).toEqual({ windowStartedAt: 5_000, count: 7 });

    stateStoreHolder.current.dispose();
    const emptyPath: string = join(dir, "state-empty.json");
    await Bun.write(emptyPath, JSON.stringify({ copy: { copiedUser: null } }));
    stateStoreHolder.current = new StateStore({ stateFilePath: emptyPath });
    await loadState();
    expect(getTtsUsage()).toBeNull();
  });

  test("接管回执后写出 ttsUsage，读回一致", async () => {
    const statePath: string = join(dir, "state.json");
    stateStoreHolder.current = new StateStore({ stateFilePath: statePath });
    adoptTtsUsage({ windowStartedAt: 9_000, count: 3 });
    expect(getTtsUsage()).toEqual({ windowStartedAt: 9_000, count: 3 });
    expect(await stateStoreHolder.current.flush(5_000)).toBe("flushed");
    const written: GlobalState = JSON.parse(await Bun.file(statePath).text()) as GlobalState;
    expect(written.ttsUsage).toEqual({ windowStartedAt: 9_000, count: 3 });
    expect(decodeGlobalStateFile(written, statePath).ttsUsage).toEqual({ windowStartedAt: 9_000, count: 3 });
  });
});
