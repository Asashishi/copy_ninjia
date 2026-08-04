import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskBusinessMessage } from "../../packages/types/diskIO";

/**
 * 入群事实的 durable 屏障（packages/infra/joinLog.ts）。
 *
 * 它的返回值直接决定 antiRaid/updateIngress.ts 抛不抛错，而那条错误会一路
 * 经 bot.catch rethrow 让 handleUpdate reject，最终使 ApplicationLifecycle.run()
 * 非零退出并扣住最终 offset——Telegram 会把上次确认点之后的全部更新重投一遍。
 * 因此「已缓冲待写」必须与「写入失败」分开报。
 */

const postDiskIO = mock((_message: DiskBusinessMessage): boolean => true);
const flushDiskIODomain = mock(async (): Promise<string> => "flushed");
let buffering: boolean = false;

mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  flushDiskIODomain,
  isDiskIOBuffering: (): boolean => buffering,
  readJoinLog: async (): Promise<readonly unknown[]> => [],
}));

const { recordJoinLog } = await import("../../packages/infra/joinLog");

const PARAMS = { chatId: -1001, userId: 42, joinedAt: 1_753_000_000_000 };

beforeEach(() => {
  postDiskIO.mockClear();
  flushDiskIODomain.mockClear();
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIODomain.mockImplementation(async (): Promise<string> => "flushed");
  buffering = false;
});

describe("recordJoinLog 的 durable 屏障", () => {
  test("正常可写时以 joinLog 领域的 flush 回执为准", async () => {
    await expect(recordJoinLog(PARAMS)).resolves.toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIODomain).toHaveBeenCalledWith("joinLog");
  });

  test("可写时真的没写进去就报失败，让这条 update 重投", async () => {
    flushDiskIODomain.mockImplementation(async (): Promise<string> => "failed");

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
  });

  test("投递本身被拒时直接失败，不再问 flush", async () => {
    postDiskIO.mockImplementation((): boolean => false);

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("恢复握手期已进缓冲即算受理：不问 flush，也不把瞬时故障放大成进程退出", async () => {
    // 这段窗口里没有可写的 Worker，requestDiskIOFlush 会直接短路成 "failed"
    // ——那是「此刻没人能刷盘」，不是「写坏了」。消息已经在有硬顶的 FIFO 里排着，
    // 握手结束后由 activateDiskIOWorker 原序重放；重放失败或缓冲触顶都走
    // stopWorkerAfterLoadFailure 的统一 fatal，事实不会被静默丢掉。
    buffering = true;
    flushDiskIODomain.mockImplementation(async (): Promise<string> => "failed");

    await expect(recordJoinLog(PARAMS)).resolves.toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("恢复握手期缓冲触顶被拒时照样报失败", async () => {
    buffering = true;
    postDiskIO.mockImplementation((): boolean => false);

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
  });
});
