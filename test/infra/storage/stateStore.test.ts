import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { waitUntil } from "../../helpers/waitUntil";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  activeCopyModeIn,
  activeCopyTargetIdIn,
  clearChatStateField,
  disableChatStateSwitch,
  getActiveProxySendTarget,
  getChatState,
  getChatStateCache,
  getGlobalCopyState,
  getOrCreateChatState,
  loadState,
  purgeChatStateExceptLockdown,
} from "../../../packages/infra/storage/stateStore";
import { chatStateCache } from "../../../packages/cache/main/chatState";
import { LEGACY_STATE_FILE_PATHS } from "../../../packages/consts/paths";
import { logger } from "../../../packages/infra/logger";
import {
  globalCopyState,
  stateStoreHolder,
} from "../../../packages/cache/main/storage";
import { DEFAULT_CHAT_STATE } from "../../../packages/libs/chatState";
import { decodeGlobalStateFile } from "../../../packages/libs/stateFileCodec";
import type {
  ChatState,
  DecodedGlobalState,
  GlobalState,
  LockdownRecord,
} from "../../../packages/types/chatState";
import { botPermissions } from "../../helpers/botPermissions";
import { chatStateOf } from "../../helpers/chatState";

/**
 * 让某一条路径的 stat 或 bytes 以给定 errno 失败，其余路径走真实 Bun.file。
 * 测试账号常为 root，chmod 挡不住读取，权限类失败只能在这一层注入。
 */
function failBunFile(target: string, stage: "stat" | "bytes", error: Error): () => void {
  const original = Bun.file.bind(Bun);
  const spy = spyOn(Bun, "file");
  spy.mockImplementation(((path: string) => {
    const file = original(path);
    if (path !== target) return file;
    return new Proxy(file, {
      get(source: object, prop: string | symbol): unknown {
        if (prop === stage) return async (): Promise<never> => { throw error; };
        const value = Reflect.get(source, prop, source);
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
  }) as typeof Bun.file);
  return (): void => { spy.mockRestore(); };
}

function schema(chatId: number): DecodedGlobalState {
  return { copy: { copiedUser: null, lastCopyTime: chatId }, ttsUsage: undefined };
}

describe("StateStore", () => {
  test("拒绝非法重试延时与 flush 预算", () => {
    expect(() => new StateStore({ retryDelaysMs: [] })).toThrow("at least one retry delay");
    expect(() => new StateStore({ retryDelaysMs: [0] })).toThrow("positive finite");
    const store = new StateStore();
    expect(() => store.flush(0)).toThrow("positive finite");
    expect(() => store.flush(Number.NaN)).toThrow("positive finite");
    store.dispose();
  });

  test("注入 IO 后独立验证 schema 序列化与 latest-only 写入", async () => {
    const writes: { path: string; content: string }[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      writeText: async (path, content) => {
        writes.push({ path, content });
        if (writes.length === 1) await firstBlocked;
      },
    });

    const first = store.save(schema(1));
    const second = store.save(schema(2));
    const third = store.save(schema(3));
    releaseFirst!();
    await Promise.allSettled([first, second, third]);

    expect(writes.map((write) => write.path)).toEqual([
      "/virtual/state.json",
      "/virtual/state.json",
    ]);
    expect(JSON.parse(writes[1]!.content)).toEqual(schema(3));
    store.dispose();
  });

  test("失败快照由退避计时器重试，成功后不依赖模块级全局状态", async () => {
    let attempts: number = 0;
    let retried: (() => void) | undefined;
    const retryCompleted = new Promise<void>((resolve) => {
      retried = resolve;
    });
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        if (attempts === 1) throw new Error("disk unavailable");
        retried!();
      },
    });

    const saved: Promise<void> = store.save(schema(4));
    await retryCompleted;
    await expect(saved).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await store.flush(1_000);
    store.dispose();
  });

  test("后台快照只排队重试，不为永久磁盘故障保留逐次持久化等待者", async () => {
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        throw new Error("disk unavailable");
      },
    });

    await expect(store.save(schema(40), { waitForPersistence: false })).resolves.toBeUndefined();
    // 等的是「第二次 writeText 已经发生」这个可观测事实，不猜 timer 在繁忙事件循环里晚多久触发。
    await waitUntil((): boolean => attempts > 1);
    expect(attempts).toBeGreaterThan(1);
    await expect(store.flush(20, true)).resolves.toBe("failed");
    store.dispose();
  });

  test("权威写入用尽有限重试后 reject 等待者并只触发一次 fatal", async () => {
    const fatalErrors: Error[] = [];
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      maxAttempts: 2,
      onRetryError: () => {},
      onFatal: (error) => { fatalErrors.push(error); },
      writeText: async () => {
        attempts++;
        throw new Error("read-only filesystem");
      },
    });

    await expect(store.save(schema(41))).rejects.toThrow("refusing further updates");
    expect(attempts).toBe(2);
    expect(fatalErrors).toHaveLength(1);
    await expect(store.save(schema(42))).rejects.toThrow("quiescing");
    expect(fatalErrors).toHaveLength(1);
    store.dispose();
  });

  test("load 通过当前严格 codec 解码，不存在文件返回 null", async () => {
    const missing = new StateStore({ readText: async () => null });
    await expect(missing.load()).resolves.toBeNull();

    const expected = schema(5);
    const existing = new StateStore({ readText: async () => JSON.stringify(expected) });
    await expect(existing.load()).resolves.toEqual(expected);
    missing.dispose();
    existing.dispose();
  });

  test("文件写坏时拒绝启动，不隔离、不覆盖现场", async () => {
    const writes: string[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async () => "{broken",
      writeText: async (path) => { writes.push(path); },
    });

    await expect(store.load()).rejects.toThrow("/virtual/state.json: $ must be valid JSON.");
    expect(writes).toEqual([]);
    store.dispose();
  });

  test("手改错的字段拒绝启动，诊断点名字段且不回显原值", async () => {
    const edited: string = JSON.stringify({
      copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1_700_000_000_000, count: -7 },
    }, null, 2);
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async () => edited,
      writeText: async () => { throw new Error("must not write"); },
    });

    const failure: Error | null = await store.load().then(
      (): null => null,
      (error: unknown): Error => error instanceof Error ? error : new Error("non-Error failure")
    );
    expect(failure?.message).toBe("/virtual/state.json: $.ttsUsage.count must be a positive safe integer.");
    expect(failure?.message).not.toContain("-7");
    store.dispose();
  });

  test("保存前拒绝严格 codec 无法重新加载的快照，不写入", async () => {
    const paths: string[] = [];
    const store = new StateStore({
      writeText: async (path) => { paths.push(path); },
    });
    const invalid = { copy: { copiedUser: null }, unknownField: true } as unknown as GlobalState;

    await expect(store.save(invalid)).rejects.toThrow("unknownField");
    expect(paths).toEqual([]);
    store.dispose();
  });

  test("默认写入边界在状态目录缺失时建出目录，并原子写入可重新加载的内容", async () => {
    const dir: string = mkdtempSync(join(tmpdir(), "state-write-test-"));
    const statePath: string = join(dir, "memory", "global", "state.json");
    const store = new StateStore({ stateFilePath: statePath });

    try {
      await store.save(schema(59));
      expect(lstatSync(join(dir, "memory", "global")).isDirectory()).toBeTrue();
      expect(decodeGlobalStateFile(await Bun.file(statePath).json(), statePath)).toEqual(schema(59));
      expect(readdirSync(join(dir, "memory", "global"))).toEqual(["state.json"]);
    } finally {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("底层 writer 未停稳时 flush 明确返回 timedOut", async () => {
    const store = new StateStore({
      writeText: async () => await new Promise<void>(() => {}),
    });
    const save = store.save(schema(6)).catch(() => undefined);

    await expect(store.flush(1)).resolves.toBe("timedOut");
    store.dispose();
    await save;
  });

  test("退出 quiesce 后失败 writer 不会重新安排后台重试", async () => {
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        throw new Error("disk unavailable");
      },
    });
    const save = store.save(schema(7)).catch(() => undefined);

    await expect(store.flush(20, true)).resolves.toBe("failed");
    const attemptsAfterFlush: number = attempts;
    await Bun.sleep(10);

    expect(attemptsAfterFlush).toBeGreaterThan(0);
    expect(attempts).toBe(attemptsAfterFlush);
    store.dispose();
    await save;
  });
});

/**
 * 默认读取边界：状态文件必须是普通文件且是严格 UTF-8，否则拒绝启动。
 *
 * 一律使用真实临时文件和默认 reader；注入 readText 只能测到已经解码成合法字符串
 * 的内容，测不到非法字节和非文件路径。写入统一注入 mock 计数，用来断言被拒绝的
 * 加载一次都没有回写。
 */
describe("StateStore 默认读取边界", () => {
  const legal: string = '{"copy":{"copiedUser":{"id":1,"first_name":"X"},"copyChatId":-1}}';

  let dir: string;
  let statePath: string;
  let writes: { path: string; content: string }[];

  function storeAt(): StateStore {
    return new StateStore({
      stateFilePath: statePath,
      writeText: async (path: string, content: string): Promise<void> => { writes.push({ path, content }); },
    });
  }

  /** 把合法样本里 first_name 的那个 `X` 换成裸 0xff，其余字节保持不变。 */
  function invalidBytes(): Uint8Array {
    const bytes: Uint8Array = new TextEncoder().encode(legal);
    const marker: number = legal.indexOf('"X"') + 1;
    bytes[marker] = 0xff;
    return bytes;
  }

  /** 截断的多字节序列：合法前缀加一个孤立的 UTF-8 首字节。 */
  function truncatedBytes(): Uint8Array {
    const head: Uint8Array = new TextEncoder().encode('{"copy":{"copiedUser":null}}');
    const bytes: Uint8Array = new Uint8Array(head.length + 1);
    bytes.set(head, 0);
    bytes[head.length] = 0xe4;
    return bytes;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-read-boundary-"));
    statePath = join(dir, "state.json");
    writes = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, make] of [["非法字节", invalidBytes], ["截断多字节", truncatedBytes]] as const) {
    test(`${label}时拒绝且零回写，原字节保留`, async () => {
      const bad: Uint8Array = make();
      await Bun.write(statePath, bad);
      const store = storeAt();

      try {
        await expect(store.load()).rejects.toThrow(`${statePath}: $ must be a regular file readable as strictly valid UTF-8 text.`);
        expect(writes).toEqual([]);
        expect(Array.from(await Bun.file(statePath).bytes())).toEqual(Array.from(bad));
      } finally {
        store.dispose();
      }
    });
  }

  for (const kind of ["directory", "dirLink", "danglingLink"] as const) {
    test(`${kind} 占住状态路径时拒绝，原样保留`, async () => {
      if (kind === "directory") mkdirSync(statePath);
      if (kind === "dirLink") {
        const target: string = join(dir, "target-dir");
        mkdirSync(target);
        symlinkSync(target, statePath);
      }
      if (kind === "danglingLink") symlinkSync(join(dir, "absent-target"), statePath);
      const store = storeAt();

      try {
        await expect(store.load()).rejects.toThrow(`${statePath}: $ must be`);
        expect(writes).toEqual([]);
        expect(lstatSync(statePath).isSymbolicLink() || lstatSync(statePath).isDirectory()).toBeTrue();
      } finally {
        store.dispose();
      }
    });
  }

  test("stat 报权限失败时是安全错误而不是缺失", async () => {
    const denied: Error & { code?: string } = new Error("EACCES: permission denied, stat");
    denied.code = "EACCES";
    const restore: () => void = failBunFile(statePath, "stat", denied);
    const store = storeAt();

    try {
      await expect(store.load()).rejects.toThrow(`${statePath}: $ must be an accessible regular file.`);
      expect(writes).toEqual([]);
    } finally {
      restore();
      store.dispose();
    }
  });

  test("stat 通过后读取阶段文件消失同样报错，不降级为缺失", async () => {
    await Bun.write(statePath, legal);
    const vanished: Error & { code?: string } = new Error("ENOENT: no such file or directory, read");
    vanished.code = "ENOENT";
    const restore: () => void = failBunFile(statePath, "bytes", vanished);
    const store = storeAt();

    try {
      await expect(store.load()).rejects.toThrow(`${statePath}: $ must be`);
      expect(writes).toEqual([]);
    } finally {
      restore();
      store.dispose();
    }
  });

  test("文件缺失时返回 null，不写盘", async () => {
    const store = storeAt();
    try {
      await expect(store.load()).resolves.toBeNull();
      expect(writes).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  test("中文与 emoji 正常加载", async () => {
    await Bun.write(statePath, '{"copy":{"copiedUser":{"id":7,"first_name":"忍者🥷"},"copyChatId":-9}}');
    const store = storeAt();
    try {
      const loaded: DecodedGlobalState | null = await store.load();
      expect(loaded?.copy.copiedUser?.first_name).toBe("忍者🥷");
      expect(writes).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  test("指向普通文件的软链接继续接受", async () => {
    const target: string = join(dir, "real-state.json");
    await Bun.write(target, legal);
    symlinkSync(target, statePath);
    const store = storeAt();
    try {
      await expect(store.load()).resolves.toEqual(decodeGlobalStateFile(JSON.parse(legal), "state.json"));
      expect(writes).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  test("UTF-8 BOM 被剥离后正常解析", async () => {
    await Bun.write(statePath, new TextEncoder().encode(`\uFEFF${legal}`));
    const store = storeAt();
    try {
      await expect(store.load()).resolves.toEqual(decodeGlobalStateFile(JSON.parse(legal), "state.json"));
      expect(writes).toEqual([]);
    } finally {
      store.dispose();
    }
  });
});

/**
 * 内存镜像上的纯查询/裁剪门面。业务侧测试普遍 mock 掉这些函数，这里直接打
 * 真实现，避免各处替身与真语义悄悄漂移。
 */
describe("群级状态门面", () => {
  afterEach(() => {
    chatStateCache.clear();
  });

  test("退群清理普通配置，但保留尚需恢复的 lockdown 记录", () => {
    const permissions = botPermissions({ canRestrictMembers: true });
    const lockdown: LockdownRecord = {
      phase: "active",
      intentId: 3,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 1_700_000_000_000,
    };
    chatStateCache.set(-1001, chatStateOf({ isAIChatEnabled: true, botPermissions: permissions }));
    chatStateCache.set(-1002, chatStateOf({ isAIChatEnabled: true, botPermissions: permissions, lockdown }));

    purgeChatStateExceptLockdown(-1001);
    purgeChatStateExceptLockdown(-1002);
    // 没有任何记录的群不应被凭空建出条目。
    purgeChatStateExceptLockdown(-1003);

    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(chatStateCache.get(-1002)).toEqual(chatStateOf({ lockdown }));
    expect(chatStateCache.has(-1003)).toBeFalse();
  });

  test("中转发送目标全局唯一，扫描全部群只认显式启用的那个", () => {
    chatStateCache.set(-1001, chatStateOf({ isAIChatEnabled: true }));
    expect(getActiveProxySendTarget()).toBeUndefined();

    chatStateCache.set(-1002, chatStateOf({ isProxySendEnabled: true }));
    expect(getActiveProxySendTarget()).toBe(-1002);
  });

  test("缺省读取不建条目，首次写入返回同一稳定对象与只读缓存视图", (): void => {
    const missing: Readonly<ChatState> = getChatState(-1001);
    expect(missing).toBe(DEFAULT_CHAT_STATE);
    expect(chatStateCache.has(-1001)).toBeFalse();

    const created: ChatState = getOrCreateChatState(-1001);
    created.isAIChatEnabled = true;

    expect(getOrCreateChatState(-1001)).toBe(created);
    expect(getChatState(-1001)).toBe(created);
    expect(getChatStateCache()).toBe(chatStateCache);
  });

  test("清字段区分未设置与已清除，并在最后一项清空后回收群条目", (): void => {
    const state: ChatState = getOrCreateChatState(-1001);
    state.isAIChatEnabled = true;
    state.isProxySendEnabled = true;

    expect(disableChatStateSwitch(-1001, "isAntiRaidEnabled")).toBeFalse();
    expect(disableChatStateSwitch(-1001, "isAIChatEnabled")).toBeTrue();
    expect(chatStateCache.get(-1001)?.isAIChatEnabled).toBeFalse();
    expect(chatStateCache.get(-1001)?.isProxySendEnabled).toBeTrue();

    expect(disableChatStateSwitch(-1001, "isProxySendEnabled")).toBeTrue();
    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(disableChatStateSwitch(-1001, "isProxySendEnabled")).toBeFalse();
  });

  test("清可选字段区分未设置与已清除，并在最后一项清空后回收群条目", (): void => {
    const state: ChatState = getOrCreateChatState(-1002);
    state.quietUntil = Date.now() + 60_000;
    state.title = "群名";

    expect(clearChatStateField(-1002, "aiPersona")).toBeFalse();
    expect(clearChatStateField(-1002, "quietUntil")).toBeTrue();
    expect(chatStateCache.get(-1002)?.quietUntil).toBeUndefined();

    expect(clearChatStateField(-1002, "title")).toBeTrue();
    expect(chatStateCache.has(-1002)).toBeFalse();
    expect(clearChatStateField(-1002, "title")).toBeFalse();
  });
});

/** `loadState()` 从真实文件一路恢复到复读状态的取值函数。 */
describe("全局状态的加载接线", () => {
  let dir: string = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-load-test-"));
  });

  afterEach(() => {
    globalCopyState.copiedUser = null;
    globalCopyState.copyMode = undefined;
    globalCopyState.copyChatId = undefined;
    globalCopyState.lastCopyTime = undefined;
    chatStateCache.clear();
    stateStoreHolder.current?.dispose();
    stateStoreHolder.current = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("复读目标、模式、所属群与冷却时间按判别联合完整恢复", async () => {
    const statePath: string = join(dir, "state-with-copy.json");
    const stored: DecodedGlobalState = {
      copy: {
        copiedUser: { id: 42, first_name: "Target" },
        copyMode: "nya",
        copyChatId: -1001,
        lastCopyTime: 123_456,
      },
      ttsUsage: undefined,
    };
    await Bun.write(statePath, JSON.stringify(stored, null, 2));
    stateStoreHolder.current = new StateStore({ stateFilePath: statePath });

    await loadState();

    expect(getGlobalCopyState()).toEqual(stored.copy);
    expect(activeCopyTargetIdIn(-1001)).toBe(42);
    expect(activeCopyModeIn(-1001)).toBe("nya");
  });

  test.each(LEGACY_STATE_FILE_PATHS.map((path: string): [string] => [path]))(
    "数据根仍有旧位置的 %s 时拒绝启动，不读新文件、不改旧文件",
    async (legacyPath: string) => {
      const statePath: string = join(dir, "state.json");
      await Bun.write(statePath, JSON.stringify(schema(8)));
      await Bun.write(legacyPath, "{\"global\":{}}");
      stateStoreHolder.current = new StateStore({ stateFilePath: statePath });
      const logged = spyOn(logger, "error").mockImplementation((): void => {});
      try {
        await expect(loadState()).rejects.toThrow(
          `${legacyPath}: $ must be absent; migrate it with migrate:global-state and move it out of the data root.`
        );
        expect(globalCopyState.lastCopyTime).toBeUndefined();
        expect(await Bun.file(legacyPath).text()).toBe("{\"global\":{}}");
      } finally {
        logged.mockRestore();
        rmSync(legacyPath, { force: true });
      }
    }
  );
});
