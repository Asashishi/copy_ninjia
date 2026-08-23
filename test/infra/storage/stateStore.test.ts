import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  getActiveProxySendTarget,
  getBotDefaultAvatarUrl,
  getFortuneThumbnailUrl,
  getGagThumbnailUrl,
  getProbabilityThumbnailUrl,
  loadState,
  pruneDepartedChatState,
  seedMissingAssetState,
} from "../../../packages/infra/storage/stateStore";
import { chatStateCache } from "../../../packages/cache/main/chatState";
import { globalAssetState, stateStoreHolder } from "../../../packages/cache/main/storage";
import {
  BOT_DEFAULT_AVATAR_URL,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  QA_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
} from "../../../packages/consts/ui/assets";
import type { DecodedStateFile, LockdownRecord, StateFileSchema } from "../../../packages/types/chatState";
import { botPermissions } from "../../helpers/botPermissions";

function schema(chatId: number): DecodedStateFile {
  return {
    global: { copy: { copiedUser: null, lastCopyTime: chatId }, assets: {} },
  };
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
      "/virtual/state.json.bak",
      "/virtual/state.json",
      "/virtual/state.json.bak",
    ]);
    expect(JSON.parse(writes[3]!.content)).toEqual(schema(3));
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
    expect(attempts).toBe(3);
    await store.flush(20);
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
    // 等的这条链只有 `retryDelaysMs` 那 1 毫秒是设计延迟，其余是调度延迟：
    // save 返回 → writer 异步 reject → handleWriteFailure → scheduleRetry 的
    // setTimeout(1) → 触发后再 push 一次 writeText。事件循环繁忙时 timer 会晚触发，
    // 实测（300 次采样）空载 p99 2.4ms / max 2.8ms，而 6 个忙循环争用 CPU 时
    // p99 8.3ms / max 9.3ms——`bun test --isolate --coverage` 跑 260 个文件时正是
    // 后一种条件，5ms 预算下约 3% 的运行会误报。15ms 在实测最大值上留了约 60% 余量。
    await Bun.sleep(15);
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

  test("主文件有效但备份缺失时先补建 LKG，再返回解码状态", async () => {
    const expected: DecodedStateFile = schema(50);
    const primaryContent: string = JSON.stringify(expected, null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? null : primaryContent,
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).resolves.toEqual(expected);
    expect(writes).toEqual([{ path: "/virtual/state.json.bak", content: primaryContent }]);
    store.dispose();
  });

  test("主文件有效时直接刷新内容不同但同样合法的旧备份", async () => {
    const primary: string = JSON.stringify(schema(51), null, 2);
    const staleBackup: string = JSON.stringify(schema(52), null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? staleBackup : primary,
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).resolves.toEqual(schema(51));
    expect(writes).toEqual([{ path: "/virtual/state.json.bak", content: primary }]);
    store.dispose();
  });

  test("主文件有效、备份损坏时仍保留原字节并拒绝启动", async () => {
    const primary: string = JSON.stringify(schema(53), null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? "{broken" : primary,
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).rejects.toThrow("/virtual/state.json.bak: $ must be valid JSON.");
    expect(writes).toEqual([]);
    store.dispose();
  });

  test("主文件写坏时拒绝启动，即使 LKG 完好也不隔离、不覆盖现场", async () => {
    // 落盘是临时文件 + 原子 rename，主文件不会写出半份，所以「在但解不开」只剩
    // 手改错和介质损坏两种来源。拿 LKG 顶上去 = 把运维刚编辑的文件改名成
    // .corrupt、用陈旧内容盖回去，然后一切正常启动（见 AGENTS.md 不为用户行为兜底）。
    const valid: DecodedStateFile = schema(53);
    const backup: string = JSON.stringify(valid, null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : "{broken",
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).rejects.toThrow("/virtual/state.json: $ must be valid JSON.");
    expect(writes).toEqual([]);
    store.dispose();
  });

  test("手改错的字段不被 LKG 静默还原，诊断不回显原值", async () => {
    const backup: string = JSON.stringify(schema(58), null, 2);
    const edited: string = JSON.stringify({
      // 漏掉 scheme 是最常见的手误，且它在两份副本逐字节相同时只会出现在主文件里。
      global: { copy: { copiedUser: null }, assets: { botDefaultAvatarUrl: "cdn.example.com/face.jpg" } },
    }, null, 2);
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : edited,
      writeText: async () => { throw new Error("must not write"); },
    });

    const failure: Error | null = await store.load().then(
      (): null => null,
      (error: unknown): Error => error instanceof Error ? error : new Error("non-Error failure")
    );
    // 诊断必须点名坏在哪个字段、期望什么形态：换成「整份文件不符合 schema」
    // 等于让运维对着自己唯一能手工编辑的旋钮猜。
    expect(failure?.message).toBe(
      "/virtual/state.json: state.global.assets.botDefaultAvatarUrl must be an absolute http(s) URL."
    );
    expect(failure?.message).not.toContain("cdn.example.com");
    store.dispose();
  });

  test("主文件缺失时从有效 LKG 原子恢复且不创建损坏隔离件", async () => {
    const expected: DecodedStateFile = schema(54);
    const backup: string = JSON.stringify(expected, null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : null,
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).resolves.toEqual(expected);
    expect(writes).toEqual([{ path: "/virtual/state.json", content: backup }]);
    store.dispose();
  });

  test("主文件缺失且 LKG 也解不开时 fail-closed，且不隔离、不覆盖现场", async () => {
    const writes: string[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? JSON.stringify({ chats: {} }) : null,
      writeText: async (path) => { writes.push(path); },
    });

    await expect(store.load()).rejects.toThrow("manual recovery is required");
    expect(writes).toEqual([]);
    store.dispose();
  });

  test("两份都解不开时同样只报错，不动任何一份", async () => {
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

  test("主文件缺失时的恢复 IO 失败会终止加载", async () => {
    const backup: string = JSON.stringify(schema(55));
    const restoreFailure = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : null,
      writeText: async () => { throw new Error("write unavailable"); },
    });
    await expect(restoreFailure.load()).rejects.toThrow("write unavailable");
    restoreFailure.dispose();
  });

  test("备份写失败也算保存失败，并按主文件到备份的完整顺序重试", async () => {
    const paths: string[] = [];
    let backupAttempts: number = 0;
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      retryDelaysMs: [1],
      writeText: async (path) => {
        paths.push(path);
        if (path.endsWith(".bak") && ++backupAttempts === 1) throw new Error("backup unavailable");
      },
    });

    await expect(store.save(schema(56))).resolves.toBeUndefined();
    expect(paths).toEqual([
      "/virtual/state.json",
      "/virtual/state.json.bak",
      "/virtual/state.json",
      "/virtual/state.json.bak",
    ]);
    store.dispose();
  });

  test("保存前拒绝严格 codec 无法重新加载的快照，主备均不写入", async () => {
    const paths: string[] = [];
    const store = new StateStore({
      writeText: async (path) => { paths.push(path); },
    });
    const invalid = {
      global: { copy: { copiedUser: null } },
      unknownField: true,
    } as unknown as StateFileSchema;

    await expect(store.save(invalid)).rejects.toThrow("unknownField");
    expect(paths).toEqual([]);
    store.dispose();
  });

  test("真实文件边界下坏主文件原样保留，两份副本一个字节都不动", async () => {
    const dir: string = mkdtempSync(join(tmpdir(), "state-lkg-test-"));
    const statePath: string = join(dir, "state.json");
    const backupPath: string = `${statePath}.bak`;
    const backup: string = JSON.stringify(schema(57), null, 2);
    writeFileSync(statePath, "{broken");
    writeFileSync(backupPath, backup);
    const store = new StateStore({ stateFilePath: statePath });

    try {
      await expect(store.load()).rejects.toThrow(`${statePath}: $ must be valid JSON.`);
      // 运维要接着排查的就是这份文件：既不改名也不覆盖。
      expect(readFileSync(statePath, "utf8")).toBe("{broken");
      expect(readFileSync(backupPath, "utf8")).toBe(backup);
      expect(readdirSync(dir).some((entry) => entry.endsWith(".corrupt"))).toBeFalse();
    } finally {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("真实文件边界下主文件缺失时才由 LKG 原子重建", async () => {
    const dir: string = mkdtempSync(join(tmpdir(), "state-lkg-test-"));
    const statePath: string = join(dir, "state.json");
    const backup: string = JSON.stringify(schema(59), null, 2);
    writeFileSync(`${statePath}.bak`, backup);
    const store = new StateStore({ stateFilePath: statePath });

    try {
      await expect(store.load()).resolves.toEqual(schema(59));
      expect(readFileSync(statePath, "utf8")).toBe(backup);
      expect(readdirSync(dir).some((entry) => entry.endsWith(".corrupt"))).toBeFalse();
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
    chatStateCache.set(-1001, { isAIChatEnabled: true, botPermissions: permissions });
    chatStateCache.set(-1002, { isAIChatEnabled: true, botPermissions: permissions, lockdown });

    pruneDepartedChatState(-1001);
    pruneDepartedChatState(-1002);
    // 没有任何记录的群不应被凭空建出条目。
    pruneDepartedChatState(-1003);

    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(chatStateCache.get(-1002)).toEqual({ lockdown });
    expect(chatStateCache.has(-1003)).toBeFalse();
  });

  test("中转发送目标全局唯一，扫描全部群只认显式启用的那个", () => {
    chatStateCache.set(-1001, { isAIChatEnabled: true });
    expect(getActiveProxySendTarget()).toBeUndefined();

    chatStateCache.set(-1002, { isProxySendEnabled: true });
    expect(getActiveProxySendTarget()).toBe(-1002);
  });
});

/**
 * `state.global.assets` 的四个取值函数：缺省即回退到内置常量，设过就以 state 为准。
 * 缺省这一侧必须守住——它是「没配过的部署行为与从前逐字相同」的唯一保证。
 */
describe("素材直链的取值", () => {
  afterEach(() => {
    globalAssetState.fortuneThumbnailUrl = undefined;
    globalAssetState.probabilityThumbnailUrl = undefined;
    globalAssetState.gagThumbnailUrl = undefined;
    globalAssetState.botDefaultAvatarUrl = undefined;
  });

  test("四项都没设过时回退到内置常量", () => {
    expect(getFortuneThumbnailUrl()).toBe(FORTUNE_THUMBNAIL_URL);
    expect(getProbabilityThumbnailUrl()).toBe(PROBABILITY_THUMBNAIL_URL);
    expect(getGagThumbnailUrl()).toBe(GAG_THUMBNAIL_URL);
    expect(getBotDefaultAvatarUrl()).toBe(BOT_DEFAULT_AVATAR_URL);
  });

  test("设过的那一项以 state 为准，没设过的仍走常量", () => {
    globalAssetState.probabilityThumbnailUrl = "https://cdn.example/probability.png";
    expect(getProbabilityThumbnailUrl()).toBe("https://cdn.example/probability.png");
    expect(getFortuneThumbnailUrl()).toBe(FORTUNE_THUMBNAIL_URL);
    expect(getBotDefaultAvatarUrl()).toBe(BOT_DEFAULT_AVATAR_URL);
  });
});

/**
 * `loadState()` 把解码结果接到取值函数上的那三行。纯解码测试与直接改
 * `globalAssetState` 的测试都走不到它：交换两行或整行删掉都能全绿，而生产表现是
 * 「我配的图悄悄不生效」，无日志、无门禁。这里从真实文件一路走到取值函数。
 */
describe("素材直链的加载接线", () => {
  let dir: string = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-load-test-"));
  });

  afterEach(() => {
    globalAssetState.fortuneThumbnailUrl = undefined;
    globalAssetState.probabilityThumbnailUrl = undefined;
    globalAssetState.gagThumbnailUrl = undefined;
    globalAssetState.botDefaultAvatarUrl = undefined;
    chatStateCache.clear();
    stateStoreHolder.current?.dispose();
    stateStoreHolder.current = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("四项各自落到对应的取值函数上，不串位、不漏接", async () => {
    // 四个值互不相同：两张运势缩略图的内置常量逐字节相同，用常量做断言的话交换两行
    // 也看不出来。
    const statePath: string = join(dir, "state.json");
    const stored: DecodedStateFile = {
      global: {
        copy: { copiedUser: null },
        assets: {
          fortuneThumbnailUrl: "https://cdn.example/fortune.png",
          probabilityThumbnailUrl: "https://cdn.example/probability.png",
          gagThumbnailUrl: "https://cdn.example/gag.png",
          botDefaultAvatarUrl: "http://assets.internal/face.jpg",
        },
      },
    };
    writeFileSync(statePath, JSON.stringify(stored, null, 2));
    stateStoreHolder.current = new StateStore({ stateFilePath: statePath });

    await loadState();

    expect(getFortuneThumbnailUrl()).toBe("https://cdn.example/fortune.png");
    expect(getProbabilityThumbnailUrl()).toBe("https://cdn.example/probability.png");
    expect(getGagThumbnailUrl()).toBe("https://cdn.example/gag.png");
    expect(getBotDefaultAvatarUrl()).toBe("http://assets.internal/face.jpg");
  });

  test("文件里没有 assets 块时四项都回退到内置常量", async () => {
    const statePath: string = join(dir, "state-without-assets.json");
    writeFileSync(statePath, JSON.stringify({ global: { copy: { copiedUser: null } } }, null, 2));
    stateStoreHolder.current = new StateStore({ stateFilePath: statePath });

    await loadState();

    expect(globalAssetState.botDefaultAvatarUrl).toBeUndefined();
    expect(getFortuneThumbnailUrl()).toBe(FORTUNE_THUMBNAIL_URL);
    expect(getProbabilityThumbnailUrl()).toBe(PROBABILITY_THUMBNAIL_URL);
    expect(getGagThumbnailUrl()).toBe(GAG_THUMBNAIL_URL);
    expect(getBotDefaultAvatarUrl()).toBe(BOT_DEFAULT_AVATAR_URL);
  });
});

/**
 * 启动时把没设过的素材直链补进 state（app/lifecycle.ts 在 loadState 之后调用）。
 * 要守住的是「只补缺的、绝不覆盖部署方写下的地址」，以及「无事可补时不写盘」——
 * 每次启动都白写一次 state 会让 LKG 副本毫无必要地翻新。
 */
describe("启动补齐素材直链", () => {
  const writes: { path: string; content: string }[] = [];

  afterEach(() => {
    globalAssetState.fortuneThumbnailUrl = undefined;
    globalAssetState.probabilityThumbnailUrl = undefined;
    globalAssetState.gagThumbnailUrl = undefined;
    globalAssetState.botDefaultAvatarUrl = undefined;
    stateStoreHolder.current?.dispose();
    stateStoreHolder.current = null;
    writes.length = 0;
  });

  /**
   * 让 saveGlobalStateInBackground 落到可观测的注入 IO 上，不碰真实数据根。
   * @returns 主、备两份都写完时兑现的 Promise；补写是 fire-and-forget，没有别的
   *   等待点（用 flush() 等会把同一份 dirty 快照再推一次，看到的写入数会翻倍）。
   */
  function installRecordingStore(): Promise<void> {
    let backupWritten: (() => void) | undefined;
    const written = new Promise<void>((resolve: () => void): void => {
      backupWritten = resolve;
    });
    stateStoreHolder.current = new StateStore({
      stateFilePath: "/virtual/seed-state.json",
      writeText: async (path: string, content: string): Promise<void> => {
        writes.push({ path, content });
        if (path.endsWith(".bak")) backupWritten!();
      },
    });
    return written;
  }

  test("五项都没设过时补齐并落盘一次", async () => {
    const written: Promise<void> = installRecordingStore();

    expect(seedMissingAssetState()).toBe(5);
    expect(globalAssetState.fortuneThumbnailUrl).toBe(FORTUNE_THUMBNAIL_URL);
    expect(globalAssetState.probabilityThumbnailUrl).toBe(PROBABILITY_THUMBNAIL_URL);
    expect(globalAssetState.gagThumbnailUrl).toBe(GAG_THUMBNAIL_URL);
    expect(globalAssetState.qaThumbnailUrl).toBe(QA_THUMBNAIL_URL);
    expect(globalAssetState.botDefaultAvatarUrl).toBe(BOT_DEFAULT_AVATAR_URL);

    await written;
    expect(writes.map((write): string => write.path))
      .toEqual(["/virtual/seed-state.json", "/virtual/seed-state.json.bak"]);
    expect(JSON.parse(writes[0]!.content).global.assets).toEqual({
      fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
      probabilityThumbnailUrl: PROBABILITY_THUMBNAIL_URL,
      gagThumbnailUrl: GAG_THUMBNAIL_URL,
      qaThumbnailUrl: QA_THUMBNAIL_URL,
      botDefaultAvatarUrl: BOT_DEFAULT_AVATAR_URL,
    });
  });

  test("已配置的项原样保留，只补缺的那一项", () => {
    void installRecordingStore();
    globalAssetState.botDefaultAvatarUrl = "https://cdn.example/custom-face.jpg";
    globalAssetState.fortuneThumbnailUrl = "https://cdn.example/fortune.png";

    expect(seedMissingAssetState()).toBe(2);
    expect(globalAssetState.botDefaultAvatarUrl).toBe("https://cdn.example/custom-face.jpg");
    expect(globalAssetState.fortuneThumbnailUrl).toBe("https://cdn.example/fortune.png");
    expect(globalAssetState.probabilityThumbnailUrl).toBe(PROBABILITY_THUMBNAIL_URL);
    expect(globalAssetState.gagThumbnailUrl).toBe(GAG_THUMBNAIL_URL);
    expect(globalAssetState.qaThumbnailUrl).toBe(QA_THUMBNAIL_URL);
  });

  test("四项都配过时不写盘", async () => {
    void installRecordingStore();
    globalAssetState.fortuneThumbnailUrl = "https://cdn.example/f.png";
    globalAssetState.probabilityThumbnailUrl = "https://cdn.example/p.png";
    globalAssetState.gagThumbnailUrl = "https://cdn.example/g.png";
    globalAssetState.botDefaultAvatarUrl = "https://cdn.example/a.jpg";

    expect(seedMissingAssetState()).toBe(0);
    await stateStoreHolder.current!.flush();
    expect(writes).toHaveLength(0);
  });
});
