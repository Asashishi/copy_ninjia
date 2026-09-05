import { afterEach, expect, mock, test } from "bun:test";
import type { WorkerDuplexOutbound } from "../../../packages/types/workerDuplex";
import type * as WorkerClientModule from "../../../packages/infra/telegram/workerClient";
import type * as DuplexModule from "../../../packages/libs/workerDuplex";
import type * as DuplexCacheModule from "../../../packages/cache/perThread/workerDuplex";
import type * as LinkedChannelModule from "../../../packages/workers/antiRaid/linkedChannel";
import type * as LinkedChannelCacheModule from "../../../packages/cache/workers/antiRaid/linkedChannels";
import type * as TasksModule from "../../../packages/cache/workers/antiRaid/tasks";
const root: string = new URL("../../../packages/", import.meta.url).pathname.slice(0, -1);
mock.module(root + "/consts/antiRaid/cache.ts", () => ({ LINKED_CHANNEL_FETCH_TIMEOUT_MS: 5, LINKED_CHANNEL_TTL_MS: 300_000, ANTI_RAID_CHAT_CACHE_MAX: 500 }));
mock.module(root + "/infra/logger.ts", () => ({ logger: { error(): void {}, log(): void {}, warn(): void {}, info(): void {} } }));
const { workerTelegramApi }: typeof WorkerClientModule = await import(root + "/infra/telegram/workerClient.ts");
mock.module(root + "/infra/telegram/index.ts", () => ({ telegramApi: workerTelegramApi }));
const duplex: typeof DuplexModule = await import(root + "/libs/workerDuplex.ts");
const { workerDuplexWaiters }: typeof DuplexCacheModule = await import(root + "/cache/perThread/workerDuplex.ts");
const candidate: typeof LinkedChannelModule = await import("../../../packages/workers/antiRaid/linkedChannel");
const cache: typeof LinkedChannelCacheModule = await import(root + "/cache/workers/antiRaid/linkedChannels.ts");
const { antiRaidInFlightTasks }: typeof TasksModule = await import(root + "/cache/workers/antiRaid/tasks.ts");
let sent: WorkerDuplexOutbound<unknown>[] = [];
function connect(): void {
  sent = [];
  duplex.initializeWorkerDuplex((message: WorkerDuplexOutbound<unknown>): void => { sent.push(message); });
}
function respond(index: number, value: unknown): void {
  duplex.handleWorkerDuplexResponse({ __duplex: "response", requestId: sent[index]!.requestId, ok: true, value, error: undefined });
}
afterEach((): void => {
  expect(workerDuplexWaiters.size).toBe(0);
  expect(cache.linkedChannelFetches.size).toBe(0);
  expect(antiRaidInFlightTasks.size).toBe(0);
  duplex.resetWorkerDuplex("review cleanup");
  cache.resetLinkedChannelCache();
});
test("同群去重、正常返回与缓存不变", async (): Promise<void> => {
  connect();
  const first: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  const second: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  expect(sent).toHaveLength(1);
  respond(0, { id: -1001, type: "supergroup", linked_chat_id: -2001 });
  expect(await first).toBeTrue();
  expect(await second).toBeTrue();
  expect(candidate.cachedChatHasLinkedChannel(-1001)).toBeTrue();
});
test("失败保留 undefined，允许下一次成功查询", async (): Promise<void> => {
  connect();
  const failed: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  duplex.handleWorkerDuplexResponse({ __duplex: "response", requestId: sent[0]!.requestId, ok: false, value: undefined, error: undefined });
  expect(await failed).toBeUndefined();
  expect(candidate.cachedChatHasLinkedChannel(-1001)).toBeUndefined();
  const success: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  respond(1, { id: -1001, type: "supergroup" });
  expect(await success).toBeFalse();
});
test("超时发送 cancel，迟到回执不污染缓存", async (): Promise<void> => {
  connect();
  expect(await candidate.fetchChatHasLinkedChannel(-1001)).toBeUndefined();
  expect(sent.map((value: WorkerDuplexOutbound<unknown>): string => value.__duplex)).toEqual(["request", "cancel"]);
  respond(0, { linked_chat_id: -2001 });
  expect(candidate.cachedChatHasLinkedChannel(-1001)).toBeUndefined();
});
test("重建后旧代返回不能覆盖新代缓存", async (): Promise<void> => {
  connect();
  const old: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  cache.resetLinkedChannelCache();
  const current: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  respond(0, { linked_chat_id: -2001 });
  expect(await old).toBeUndefined();
  expect(cache.linkedChannelFetches.size).toBe(1);
  respond(1, { id: -1001, type: "supergroup" });
  expect(await current).toBeFalse();
});
test("Worker 生命周期取消排空等待者", async (): Promise<void> => {
  connect();
  const lifetime: AbortController = new AbortController();
  duplex.setWorkerDuplexRequestSignal(lifetime.signal);
  const pending: Promise<boolean | undefined> = candidate.fetchChatHasLinkedChannel(-1001);
  lifetime.abort();
  expect(await pending).toBeUndefined();
  expect(sent.map((value: WorkerDuplexOutbound<unknown>): string => value.__duplex)).toEqual(["request", "cancel"]);
});
