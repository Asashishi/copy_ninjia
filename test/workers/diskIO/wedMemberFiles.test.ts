import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirtyWedChats, pendingWedMembers, resetWedFileWrites, wedFileFlushTimer } from "../../../packages/cache/workers/diskIO/wed";
import { FLUSH_INTERVAL_MS } from "../../../packages/consts/diskIO/appendOnly";
import { WED_MEMORY_DIR } from "../../../packages/consts/paths";
import { WED_MEMBER_LIMIT } from "../../../packages/consts/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { flushWedMemberFiles, handleWedMembersMessage, inspectWedMemberFiles, maintainWedMemberFiles, writeWedMemberFile } from "../../../packages/workers/diskIO/wedMemberFiles";
import { handleDiskIOStartupLoad } from "../../../packages/workers/diskIO/startup";
import { handleDiskIOWorkerMessage } from "../../../packages/workers/diskIOWorker";
import { stopDiskIOMaintenanceCron } from "../../../packages/workers/diskIO/maintenanceCron";

const path: string = join(WED_MEMORY_DIR, "-1001.json");

beforeEach(() => {
  resetWedFileWrites();
  rmSync(WED_MEMORY_DIR, { recursive: true, force: true });
});

afterEach(() => {
  stopDiskIOMaintenanceCron();
  resetWedFileWrites();
  rmSync(WED_MEMORY_DIR, { recursive: true, force: true });
  jest.useRealTimers();
});

test("启动 load 通过全部门禁后回传已建立的成员 Set", async () => {
  writeWedMemberFile(-1001, [5974478892]);
  const reply = mock();
  await handleDiskIOStartupLoad(null, reply);
  expect(reply.mock.calls[0]![0]).toEqual(expect.objectContaining({
    type: "loaded", error: undefined, wedMembers: new Map([[-1001, new Set([5974478892])]]),
  }));
});

test("成员目录被普通文件占用时拒绝加载", async () => {
  await Bun.write(WED_MEMORY_DIR, "[]");
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${WED_MEMORY_DIR}: $ must be a readable directory`);
});

test("文件缺省恢复为空；首次写自动建目录和文件，重启加载数字 ID", async () => {
  expect((await inspectWedMemberFiles()).snapshots.size).toBe(0);
  await handleDiskIOWorkerMessage({ type: "wedMembers", chatId: -1001, revision: 1, members: [5974478892, 2] });
  expect(await Bun.file(path).json()).toEqual([5974478892, 2]);
  expect(pendingWedMembers.size).toBe(0);
  resetWedFileWrites();
  expect((await inspectWedMemberFiles()).snapshots.get(-1001)).toEqual(new Set([5974478892, 2]));
  handleWedMembersMessage({ type: "wedMembers", chatId: -1001, revision: 2, members: [] });
  expect(await Bun.file(path).json()).toEqual([]);
  expect(await Bun.file(`${path}.tmp`).exists()).toBeFalse();
});

test.each([
  ["{", "$"], ["{}", "$"], ["[null]", "$[0]"], ["[true]", "$[0]"],
  ["[\"5974478892\"]", "$[0]"], ["[0]", "$[0]"], ["[-1]", "$[0]"],
  ["[1.5]", "$[0]"], ["[9007199254740992]", "$[0]"], ["[1,1]", "$[1]"],
])("非法状态 %s 拒绝加载并保留原字节", async (content, field) => {
  await Bun.write(path, content);
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${path}: ${field} must be`);
  expect(await Bun.file(path).text()).toBe(content);
});

test.each(["1.json", "-01001.json", "-1e3.json", "-9007199254740992.json", "abc.json"])("非规范群文件名 %s 拒绝加载", async (name) => {
  const invalid = join(WED_MEMORY_DIR, name);
  await Bun.write(invalid, "[]");
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${invalid}: $filename must be`);
});

test("每群容量超限和群数超限均拒绝启动，不截断文件", async () => {
  const ids = Array.from({ length: WED_MEMBER_LIMIT }, (_, index) => index + 1);
  await Bun.write(path, JSON.stringify(ids));
  expect((await inspectWedMemberFiles()).snapshots.get(-1001)!.size).toBe(WED_MEMBER_LIMIT);
  ids.push(WED_MEMBER_LIMIT + 1);
  const bytes = JSON.stringify(ids);
  await Bun.write(path, bytes);
  await expect(inspectWedMemberFiles()).rejects.toThrow("at most 150000");
  expect(await Bun.file(path).text()).toBe(bytes);
  await Bun.file(path).delete();
  for (let id = 1; id <= STATE_MANAGED_CHAT_LIMIT + 1; id++) {
    await Bun.write(join(WED_MEMORY_DIR, `${-id}.json`), "[]");
  }
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${WED_MEMORY_DIR}: $ must be at most`);
});

test("临时文件只在全域成功后的 maintenance 清理", async () => {
  await Bun.write(`${path}.tmp`, "incomplete");
  const inspection = await inspectWedMemberFiles();
  expect(await Bun.file(`${path}.tmp`).exists()).toBeTrue();
  await maintainWedMemberFiles(inspection);
  expect(await Bun.file(`${path}.tmp`).exists()).toBeFalse();
});

test("启动 load 串联新门禁：失败不 adopt、不清理临时文件、不回显非法值", async () => {
  const content = "[\"sensitive-invalid-value\"]";
  await Bun.write(path, content);
  await Bun.write(`${path}.tmp`, "incomplete");
  pendingWedMembers.set(-99, [1]);
  const reply = mock();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleDiskIOStartupLoad(null, reply);
    expect(reply).toHaveBeenCalledTimes(1);
    const loaded = reply.mock.calls[0]![0];
    expect(loaded.type).toBe("loaded");
    expect(loaded.error).toContain(`${path}: $[0] must be`);
    expect(loaded.error).not.toContain("sensitive-invalid-value");
    expect(loaded.wedMembers.size).toBe(0);
    expect(pendingWedMembers.get(-99)).toEqual([1]);
    expect(await Bun.file(`${path}.tmp`).exists()).toBeTrue();
    expect(await Bun.file(path).text()).toBe(content);
  } finally {
    diagnostic.mockRestore();
  }
});

test("原子替换失败保留旧文件和最新待写数组，重试成功后才清理 dirty", async () => {
  writeWedMemberFile(-1001, [1]);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    pendingWedMembers.set(-1001, [2]);
    dirtyWedChats.add(-1001);
    expect(flushWedMemberFiles((): never => { throw new Error("disk full"); })).toBeFalse();
    expect(await Bun.file(path).json()).toEqual([1]);
    expect(dirtyWedChats.has(-1001)).toBeTrue();
    handleWedMembersMessage({ type: "wedMembers", chatId: -1001, revision: 2, members: [3] });
    expect(pendingWedMembers.get(-1001)).toEqual([3]);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(await Bun.file(path).json()).toEqual([3]);
    expect(dirtyWedChats.size).toBe(0);
    expect(pendingWedMembers.size).toBe(0);
    expect(wedFileFlushTimer.current).toBeNull();
  } finally {
    diagnostic.mockRestore();
  }
});

test("统一 flush 包含 wed 失败领域，其余领域继续排空", async () => {
  const workerGlobal = globalThis as typeof globalThis & { self: Worker };
  const original = workerGlobal.self;
  const reply = mock();
  workerGlobal.self = { postMessage: reply } as never;
  mkdirSync(path, { recursive: true });
  pendingWedMembers.set(-1001, [1]);
  dirtyWedChats.add(-1001);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleDiskIOWorkerMessage({ type: "flush", scope: "all", flushId: 99 });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      type: "flushFailed", flushedId: 99, failedDomains: expect.arrayContaining(["wedMembers"]),
    }));
  } finally {
    workerGlobal.self = original;
    diagnostic.mockRestore();
  }
});
