import { expect, test } from "bun:test";
import { DiskIORecoveryRevisions } from "../../packages/libs/diskIORecoveryRevisions";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";

type RevisionedMessage = Extract<DiskBusinessMessage, { revision: number }>;
const messages: readonly RevisionedMessage[] = [
  { type: "identityPolicyWrite", table: "whitelist", id: 7, data: null, revision: 2 },
  { type: "identityPolicyWrite", table: "blocklist", id: 7, data: null, revision: 2 },
  { type: "temporaryAdBypassWrite", id: 7, activity: null, revision: 2 },
  { type: "chatStateWrite", chatId: -7, data: null, revision: 2 },
  { type: "chatQaWrite", chatId: -7, q: "一", data: null, revision: 2 },
  { type: "chatQaWrite", chatId: -7, q: "二", data: null, revision: 2 },
  { type: "blocklistRemovals", removals: [], revision: 2 },
];

test("每个 SQLite 领域独立按主键覆盖旧 revision，保留镜像后的新值", (): void => {
  const revisions: DiskIORecoveryRevisions = new DiskIORecoveryRevisions();
  const buffered = new LinkedQueue<DiskBusinessMessage>();
  for (const message of messages) {
    expect(revisions.covers(message)).toBeFalse();
    revisions.record(message, buffered);
    expect(revisions.covers({ ...message, revision: 1 })).toBeTrue();
    expect(revisions.covers(message)).toBeTrue();
    expect(revisions.covers({ ...message, revision: 3 })).toBeFalse();
  }
  expect(revisions.covers({ type: "chatQaWrite", chatId: -7, q: "三", data: null, revision: 1 })).toBeFalse();
  expect(revisions.covers({ type: "chatStateWrite", chatId: -8, data: null, revision: 1 })).toBeFalse();
});

test("无 revision 的贴纸只覆盖当前 FIFO 的同包快照，不按墙钟猜新旧", (): void => {
  const revisions: DiskIORecoveryRevisions = new DiskIORecoveryRevisions();
  const buffered = new LinkedQueue<DiskBusinessMessage>();
  const old: DiskBusinessMessage = { type: "stickerCatalog", revision: 1, pack: "one", snapshot: "old" };
  const other: DiskBusinessMessage = { type: "stickerCatalog", revision: 1, pack: "two", snapshot: "other" };
  const newer: DiskBusinessMessage = { type: "stickerCatalog", revision: 1, pack: "one", snapshot: "newer" };
  buffered.push(old); buffered.push(other);
  revisions.record({ type: "stickerCatalog", revision: 1, pack: "one", snapshot: "mirror" }, buffered);
  buffered.push(newer);
  expect(revisions.covers(old)).toBeTrue(); expect(revisions.covers(other)).toBeFalse();
  expect(revisions.covers(newer)).toBeFalse();
});

test("入群事实按序号覆盖：镜像重放到的最大序号及之前的 FIFO 事实不再投递", (): void => {
  const revisions: DiskIORecoveryRevisions = new DiskIORecoveryRevisions();
  const buffered = new LinkedQueue<DiskBusinessMessage>();
  const join = (sequence: number): DiskBusinessMessage => ({
    type: "joinLog", sequence, chatId: -7, userId: sequence, joinedAt: sequence, day: "2026-09-27",
  });
  expect(revisions.covers(join(1))).toBeFalse();
  revisions.record(join(1), buffered);
  revisions.record(join(2), buffered);
  expect(revisions.covers(join(1))).toBeTrue();
  expect(revisions.covers(join(2))).toBeTrue();
  expect(revisions.covers(join(3))).toBeFalse();
});
