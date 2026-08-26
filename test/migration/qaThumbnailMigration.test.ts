import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasRetiredAssetKey,
  inspectStateFile,
  RETIRED_ASSET_KEY,
  rewriteStateFile,
  withoutRetiredKey,
} from "../../scripts/qaThumbnailMigration/stateFile";
import type { StateFileInspection } from "../../scripts/qaThumbnailMigration/stateFile";
import {
  runQaThumbnailMigration,
} from "../../scripts/migrateQaThumbnail";

const roots: string[] = [];

/** 写一份部署侧形态的 state.json，返回它的路径。 */
function writeStateFile(value: unknown, mode: number = 0o600): string {
  const root: string = mkdtempSync(join(tmpdir(), "qa-thumbnail-migration-"));
  roots.push(root);
  const path: string = join(root, "state.json");
  writeFileSync(path, JSON.stringify(value, null, 2), { mode });
  chmodSync(path, mode);
  return path;
}

/** 升级前那份带着退场字段的 state.json。 */
function legacyState(): Record<string, unknown> {
  return {
    global: {
      copy: { copiedUser: null },
      assets: {
        fortuneThumbnailUrl: "https://cdn.example/fortune.png",
        probabilityThumbnailUrl: "https://cdn.example/probability.png",
        gagThumbnailUrl: "https://cdn.example/gag.png",
        qaThumbnailUrl: "https://cdn.example/qa.png",
        botDefaultAvatarUrl: "https://cdn.example/face.jpg",
      },
    },
  };
}

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("退场字段的识别", () => {
  test("带着这个键就要迁移，键值是什么都算", () => {
    expect(hasRetiredAssetKey(legacyState())).toBeTrue();
    // 严格解析看的是键在不在，写成 null 一样会让启动失败。
    expect(hasRetiredAssetKey({
      global: { copy: {}, assets: { [RETIRED_ASSET_KEY]: null } },
    })).toBeTrue();
  });

  test("已经迁过、没有 assets 块、结构不对的一律算作无需迁移", () => {
    expect(hasRetiredAssetKey({
      global: { copy: {}, assets: { gagThumbnailUrl: "https://cdn.example/gag.png" } },
    })).toBeFalse();
    expect(hasRetiredAssetKey({ global: { copy: {} } })).toBeFalse();
    expect(hasRetiredAssetKey({})).toBeFalse();
    expect(hasRetiredAssetKey({ global: null })).toBeFalse();
  });
});

describe("读取部署副本", () => {
  test("文件不存在时返回 null——缺 .bak 是正常部署形态", async () => {
    expect(await inspectStateFile(
      join(tmpdir(), "definitely-absent-state.json")
    )).toBeNull();
  });

  test("坏掉的 JSON 当场抛错，不在坏文件上继续动手", async () => {
    const root: string = mkdtempSync(join(tmpdir(), "qa-thumbnail-migration-"));
    roots.push(root);
    const path: string = join(root, "state.json");
    writeFileSync(path, "{ 这不是 JSON");

    await expect(inspectStateFile(path)).rejects.toThrow();
  });

  test("顶层不是对象同样拒绝", async () => {
    const path: string = writeStateFile([1, 2, 3]);

    await expect(inspectStateFile(path)).rejects.toThrow(
      "must decode to a JSON object"
    );
  });

  test("断链符号链接不是缺省文件，必须在读取前拒绝", async () => {
    const root: string = mkdtempSync(join(tmpdir(), "qa-thumbnail-migration-"));
    roots.push(root);
    const path: string = join(root, "state.json");
    symlinkSync(join(root, "missing-state.json"), path);

    await expect(inspectStateFile(path)).rejects.toThrow("must be regular files");
  });
});

describe("摘键", () => {
  test("只摘那一个键，其余素材直链原样保留", () => {
    const json: string = withoutRetiredKey(JSON.stringify(legacyState(), null, 2));
    const assets = (JSON.parse(json) as {
      global: { assets: Record<string, unknown> };
    }).global.assets;

    expect(RETIRED_ASSET_KEY in assets).toBeFalse();
    expect(assets).toEqual({
      fortuneThumbnailUrl: "https://cdn.example/fortune.png",
      probabilityThumbnailUrl: "https://cdn.example/probability.png",
      gagThumbnailUrl: "https://cdn.example/gag.png",
      botDefaultAvatarUrl: "https://cdn.example/face.jpg",
    });
  });

  test("摘完的文本必须能过启动期那套严格解析", () => {
    // 这条是本次迁移的全部意义：摘不干净就等于把启动失败推迟到运维离开之后。
    const legacy: Record<string, unknown> = legacyState();
    expect((): unknown => withoutRetiredKey(JSON.stringify(legacy, null, 2))).not.toThrow();
  });

  test("同一份文件里另有非法字段时拒绝写出，而不是摘完了事", () => {
    const broken: Record<string, unknown> = legacyState();
    (broken.global as { assets: Record<string, unknown> }).assets.unknownAsset = "x";

    expect((): unknown => withoutRetiredKey(JSON.stringify(broken, null, 2))).toThrow();
  });
});

describe("就地改写", () => {
  test("改写后文件可被严格解析，且权限位不变", async () => {
    const path: string = writeStateFile(legacyState(), 0o640);
    const before: number = statSync(path).mode & 0o777;

    const inspection: StateFileInspection | null = await inspectStateFile(path);
    await rewriteStateFile(path, withoutRetiredKey(inspection!.content));

    expect(statSync(path).mode & 0o777).toBe(before);
    const assets = (JSON.parse(readFileSync(path, "utf8")) as {
      global: { assets: Record<string, unknown> };
    }).global.assets;
    expect(RETIRED_ASSET_KEY in assets).toBeFalse();
  });

  test("跑第二遍是幂等的：文件已经没有那个键，无需再改", async () => {
    const path: string = writeStateFile(legacyState());
    const first: StateFileInspection | null = await inspectStateFile(path);
    await rewriteStateFile(path, withoutRetiredKey(first!.content));

    const second: StateFileInspection | null = await inspectStateFile(path);

    expect(second?.hasRetiredKey).toBeFalse();
  });

  test("落盘口径与运行时一致：2 空格缩进", async () => {
    const path: string = writeStateFile(legacyState());
    const inspection: StateFileInspection | null = await inspectStateFile(path);
    await rewriteStateFile(path, withoutRetiredKey(inspection!.content));

    const persisted: string = readFileSync(path, "utf8");
    expect(persisted).toBe(JSON.stringify(JSON.parse(persisted), null, 2));
  });
});

describe("qa-thumbnail 冷迁移入口", () => {
  test("--check 取得并释放锁，且不创建备份或改写文件", async () => {
    const path: string = writeStateFile(legacyState(), 0o640);
    const before: string = readFileSync(path, "utf8");
    const events: string[] = [];
    const createBackup = mock(
      async (): Promise<string> => "/tmp/unreachable-backup"
    );
    const rewriteFile = mock(
      async (_path: string, _json: string): Promise<void> => {}
    );

    const message: string = await runQaThumbnailMigration({
      mode: "check",
      botToken: "test-token",
      statePaths: [path],
      dependencies: {
        acquireLock: async (): Promise<void> => { events.push("acquire"); },
        releaseLock: async (): Promise<void> => { events.push("release"); },
        createBackup,
        rewriteFile,
      },
    });

    expect(message).toContain("No deployment data was changed");
    expect(events).toEqual(["acquire", "release"]);
    expect(createBackup).not.toHaveBeenCalled();
    expect(rewriteFile).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("--apply 原子改写主备副本并留下可核验清单", async () => {
    const path: string = writeStateFile(legacyState(), 0o640);
    const backupPath: string = `${path}.bak`;
    writeFileSync(backupPath, JSON.stringify(legacyState(), null, 2), { mode: 0o600 });
    const events: string[] = [];

    const message: string = await runQaThumbnailMigration({
      mode: "apply",
      botToken: "test-token",
      statePaths: [path, backupPath],
      dependencies: {
        acquireLock: async (): Promise<void> => { events.push("acquire"); },
        releaseLock: async (): Promise<void> => { events.push("release"); },
      },
    });
    const match: RegExpExecArray | null = /external backup retained at (.+)\.\n$/.exec(message);
    expect(match).not.toBeNull();
    const backupRoot: string = match![1]!;
    roots.push(backupRoot);

    expect(events).toEqual(["acquire", "release"]);
    expect((await inspectStateFile(path))?.hasRetiredKey).toBeFalse();
    expect((await inspectStateFile(backupPath))?.hasRetiredKey).toBeFalse();
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const manifest: unknown = JSON.parse(
      readFileSync(join(backupRoot, "manifest.json"), "utf8")
    );
    expect(manifest).toBeArrayOfSize(2);
    expect(readFileSync(join(backupRoot, "state.json"), "utf8")).toContain(
      RETIRED_ASSET_KEY
    );
    expect(readFileSync(join(backupRoot, "state.json.bak"), "utf8")).toContain(
      RETIRED_ASSET_KEY
    );
  });

  test("备份后的改写与解锁双重失败仍报告备份位置和首错", async () => {
    const path: string = writeStateFile(legacyState());

    await expect(runQaThumbnailMigration({
      mode: "apply",
      botToken: "test-token",
      statePaths: [path],
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => { throw new Error("unlock failed"); },
        createBackup: async (): Promise<string> => "/tmp/retained-qa-thumbnail",
        rewriteFile: async (): Promise<never> => { throw new Error("rename failed"); },
      },
    })).rejects.toThrow(
      "External migration backup retained at /tmp/retained-qa-thumbnail; " +
      "migration failed: rename failed Lock release also failed"
    );
  });
});
