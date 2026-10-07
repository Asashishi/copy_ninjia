/**
 * 真实 Disk I/O Worker 线程：经 startDiskIOWorker 接好的回执出口完成恢复握手、业务批与 flush，
 * 再以 closeStorage 干净关库。数据根是测试进程独占的临时目录。
 */

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getTimeZone } from "../../packages/config/time";
import { DISK_IO_WORKER_URL, IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { createChatState } from "../../packages/libs/chatState";
import type { ChatState } from "../../packages/types/chatState";
import type { DiskIOMessage } from "../../packages/types/diskIO/messages";
import type { DiskIOReply } from "../../packages/types/diskIO/replies";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import { clearStorageBusinessTables } from "../../scripts/fixtures/storageDatabase";

const REPLY_TIMEOUT_MS: number = 5_000;

/** 一个真实 Worker 及其已收到的回执；waitFor 按类型取第一条未消费的回执。 */
interface WorkerProbe {
  readonly worker: Worker;
  post(message: DiskIOMessage): void;
  waitFor<TType extends DiskIOReply["type"]>(type: TType): Promise<Extract<DiskIOReply, { type: TType }>>;
}

const started: Worker[] = [];

function startWorker(): WorkerProbe {
  // Worker 的环境默认取进程启动时的 process.env 快照，不含 test/preloadEnv.ts 运行期注入的
  // 数据根与配置根；显式传入当前环境，Worker 才会读写同一个临时数据根，不落到仓库根。
  const worker: Worker = new Worker(DISK_IO_WORKER_URL, { env: { ...process.env } as Record<string, string> });
  started.push(worker);
  const replies: DiskIOReply[] = [];
  const errors: string[] = [];
  worker.onmessage = (event: MessageEvent<DiskIOReply>): void => {
    replies.push(event.data);
  };
  worker.onerror = (event: ErrorEvent): void => {
    errors.push(event.message);
  };
  return {
    worker,
    post(message: DiskIOMessage): void {
      worker.postMessage(message);
    },
    async waitFor<TType extends DiskIOReply["type"]>(type: TType): Promise<Extract<DiskIOReply, { type: TType }>> {
      const deadline: number = performance.now() + REPLY_TIMEOUT_MS;
      for (;;) {
        const index: number = replies.findIndex((reply: DiskIOReply): boolean => reply.type === type);
        if (index !== -1) return replies.splice(index, 1)[0] as Extract<DiskIOReply, { type: TType }>;
        if (errors.length > 0) throw new Error(`Disk I/O Worker errored: ${errors.join("; ")}`);
        if (performance.now() >= deadline) {
          throw new Error(`Timed out waiting for ${type}; received ${replies.map((reply: DiskIOReply): string => reply.type).join(", ")}`);
        }
        await Bun.sleep(5);
      }
    },
  };
}

afterEach((): void => {
  for (const worker of started.splice(0)) worker.terminate();
});

test("真实线程：恢复握手、业务批与 flush 回执，closeStorage 关库后 WAL/SHM 删除且主库可重开", async () => {
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  const probe: WorkerProbe = startWorker();

  probe.post({ type: "load", timeZone: getTimeZone(), stickerPacks: null });
  const loaded: Extract<DiskIOReply, { type: "loaded" }> = await probe.waitFor("loaded");
  expect(loaded.error).toBeUndefined();

  const state: ChatState = createChatState();
  state.isInitEnabled = true;
  probe.post({
    type: "operationBatch",
    batchId: 1,
    messages: [
      { type: "chatStateWrite", chatId: -1001, data: encodeChatStateData(state), revision: 1 },
      { type: "flush", flushId: 1, scope: "chatState" },
    ],
  });
  expect((await probe.waitFor("identityStoragePersisted")).chatStateWrites).toEqual([{ chatId: -1001, revision: 1 }]);
  expect((await probe.waitFor("flushed")).flushedId).toBe(1);
  expect((await probe.waitFor("operationBatchAccepted")).batchId).toBe(1);
  expect(existsSync(`${IDENTITY_DATABASE_PATH}-wal`)).toBeTrue();

  probe.post({ type: "operationBatch", batchId: 2, messages: [{ type: "closeStorage", requestId: 1 }] });
  expect(await probe.waitFor("storageClosed")).toEqual({
    type: "storageClosed",
    requestId: 1,
    outcome: { committed: true, checkpointBusy: false },
  });

  expect(existsSync(`${IDENTITY_DATABASE_PATH}-wal`)).toBeFalse();
  expect(existsSync(`${IDENTITY_DATABASE_PATH}-shm`)).toBeFalse();
  const reopened: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
  try {
    expect(reopened.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chat_states;").get()!.count).toBe(1);
  } finally {
    reopened.close();
  }
});
