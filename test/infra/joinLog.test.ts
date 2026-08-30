import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskBusinessMessage, JoinLogRecord } from "../../packages/types/diskIO";

/**
 * 入群事实的 durable 屏障（packages/infra/joinLog.ts）。
 *
 * 它的返回值直接决定 antiRaid/updateIngress.ts 抛不抛错，而那条错误会一路
 * 经 bot.catch rethrow 让 handleUpdate reject，最终使 ApplicationLifecycle.run("main")
 * 非零退出并扣住最终 offset——Telegram 会把上次确认点之后的全部更新重投一遍。
 * 因此「已缓冲待写」必须与「写入失败」分开报。
 */

const postDiskIO = mock((_message: DiskBusinessMessage): boolean => true);
const flushDiskIODomain = mock(async (): Promise<string> => "flushed");
const readJoinLog = mock(async (..._args: unknown[]): Promise<readonly unknown[]> => []);
let buffering: boolean = false;

mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  flushDiskIODomain,
  isDiskIOBuffering: (): boolean => buffering,
  readJoinLog,
}));

const { readRecentJoinLog, recordJoinLog } = await import("../../packages/infra/joinLog");

const PARAMS = { chatId: -1001, userId: 42, joinedAt: 1_753_000_000_000 };

beforeEach(() => {
  postDiskIO.mockClear();
  flushDiskIODomain.mockClear();
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIODomain.mockImplementation(async (): Promise<string> => "flushed");
  readJoinLog.mockClear();
  readJoinLog.mockImplementation(async (): Promise<readonly unknown[]> => []);
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

/**
 * 读取侧只是一层到 Disk I/O Worker 的转发，但它是 /batch_kick 等命令唯一的入群
 * 事实来源：三个字段任一在转发时丢掉或改名，命令拿到的就是一份「这段时间没人
 * 进群」的空清单，而不是报错——踢不到人却回执成功。因此这里钉的是「参数原样
 * 过桥、结果原样返回」。
 */
describe("readRecentJoinLog 的读取转发", () => {
  test("三个参数原样交给落盘线程，结果原样返回", async () => {
    const records: readonly JoinLogRecord[] = [
      { userId: 42, joinedAt: 1_753_000_000_000 },
      { userId: 43, joinedAt: 1_753_000_000_500 },
    ];
    readJoinLog.mockImplementation(async (): Promise<readonly JoinLogRecord[]> => records);

    await expect(readRecentJoinLog({
      chatId: -1001,
      since: 1_752_999_000_000,
      now: 1_753_000_001_000,
    })).resolves.toBe(records);
    expect(readJoinLog).toHaveBeenCalledTimes(1);
    expect(readJoinLog).toHaveBeenCalledWith({
      chatId: -1001,
      since: 1_752_999_000_000,
      now: 1_753_000_001_000,
    });
  });

  test("没有记录时返回空清单，不把它伪装成失败", async () => {
    await expect(readRecentJoinLog({
      chatId: -1001,
      since: 1,
      now: 2,
    })).resolves.toEqual([]);
  });
});
