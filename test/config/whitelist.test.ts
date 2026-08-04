import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableAllWhitelistPermissions,
  getEffectiveWhitelistPermissions,
  getWhitelistConfig,
  hasWhitelistPermission,
  isWhitelisted,
  loadWhitelistConfig,
  parseWhitelistConfig,
  serializeWhitelistConfig,
  setWhitelistMembership,
  setWhitelistPermission,
} from "../../packages/config/whitelist";
import { SUPER_ADMIN_USER_ID } from "../../packages/infra/config";
import {
  whitelistConfigCache,
  whitelistFileRevisionCache,
  whitelistMutationQueue,
} from "../../packages/cache/main/whitelist";
import type {
  WhitelistConfig,
  WhitelistPermissions,
} from "../../packages/types/whitelist";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  SUPER_ADMIN_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../../packages/consts/whitelist";

function oneEntry(
  id: number,
  overrides: Partial<WhitelistPermissions> = {}
): WhitelistConfig {
  return parseWhitelistConfig({ [String(id)]: overrides });
}

beforeEach(() => {
  whitelistConfigCache.current = null;
  whitelistFileRevisionCache.current = null;
  whitelistMutationQueue.current = Promise.resolve();
});

describe("whitelist config", () => {
  test("部分权限覆盖会补齐约定默认值，并接受负数频道 ID", () => {
    const config: WhitelistConfig = parseWhitelistConfig({
      "100": { isCanMute: true },
      "-1002233445566": { isCanBypassAdDetection: false },
    });

    expect(config.get(100)).toEqual({
      isCanMute: true,
      isCanUnMute: false,
      isCanBlock: false,
      isCanUnBlock: false,
      isCanSwitchMood: false,
      isCanBypassAdDetection: true,
      isCanBypassFloodControl: true,
      isCanControllAIPermission: false,
      isCanControllAdDetectPermission: false,
      isCanControllFloodControlPermission: false,
      isCanControllJATranslatePermission: false,
    });
    expect(config.get(-1002233445566)?.isCanBypassAdDetection).toBe(false);
    expect(config.get(-1002233445566)?.isCanBypassFloodControl).toBe(true);
    const exampleConfig: WhitelistConfig = loadWhitelistConfig();
    expect(exampleConfig.has(123456789)).toBe(true);
    expect(exampleConfig.has(-1001234567890)).toBe(true);
  });

  test("严格拒绝非法 ID、未知键与非布尔值，不保留旧 env 列表格式", () => {
    for (const invalid of [
      [],
      { "01": {} },
      { "0": {} },
      { "1e3": {} },
      { "9007199254740992": {} },
      { "100": { unknown: true } },
      { "100": { isCanMute: 1 } },
    ]) {
      expect(() => parseWhitelistConfig(invalid)).toThrow();
    }
  });

  test("成员身份与逐项权限是两层判定", () => {
    whitelistConfigCache.current = oneEntry(100, {
      isCanMute: false,
      isCanBypassAdDetection: true,
    });

    expect(getWhitelistConfig().has(100)).toBe(true);
    expect(isWhitelisted(100)).toBe(true);
    expect(hasWhitelistPermission(100, "isCanMute")).toBe(false);
    expect(hasWhitelistPermission(100, "isCanBypassAdDetection")).toBe(true);
    expect(isWhitelisted(101)).toBe(false);
  });

  test("超级管理员由身份直接持有全部权限，无需出现在配置文件里", () => {
    whitelistConfigCache.current = oneEntry(100);

    expect(getWhitelistConfig().has(SUPER_ADMIN_USER_ID)).toBe(false);
    expect(isWhitelisted(SUPER_ADMIN_USER_ID)).toBe(true);
    expect(getEffectiveWhitelistPermissions(SUPER_ADMIN_USER_ID))
      .toEqual(SUPER_ADMIN_WHITELIST_PERMISSIONS);
    for (const key of WHITELIST_PERMISSION_KEYS) {
      expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, key)).toBe(true);
      expect(SUPER_ADMIN_WHITELIST_PERMISSIONS[key]).toBe(true);
    }
  });

  test("配置文件里同 id 的旧条目改不动超级管理员的有效权限", () => {
    // 换 SUPER_ADMIN_USER_ID 之前留下的残留条目，或部署方手工写了一份全 false，
    // 都不得把超级管理员降权：覆盖只发生在读取侧，且以身份为准。
    whitelistConfigCache.current = oneEntry(SUPER_ADMIN_USER_ID, {
      isCanBlock: false,
      isCanMute: false,
      isCanBypassAdDetection: false,
      isCanBypassFloodControl: false,
    });

    expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, "isCanBlock")).toBe(true);
    expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, "isCanMute")).toBe(true);
    expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, "isCanBypassAdDetection"))
      .toBe(true);
    expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, "isCanBypassFloodControl"))
      .toBe(true);
  });

  test("超级管理员的全开视图只在读取侧存在，任何一次写盘都不会把它带进文件", async () => {
    whitelistConfigCache.current = oneEntry(100);
    const writes: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      writes.push(content);
    });

    await setWhitelistPermission(
      { id: 100, key: "isCanMute", value: true },
      { path: "/tmp/whitelist-test.json", writeText }
    );
    await setWhitelistMembership(
      { id: 200, enabled: true },
      { path: "/tmp/whitelist-test.json", writeText }
    );

    expect(writes).toHaveLength(2);
    for (const content of writes) {
      expect(Object.keys(JSON.parse(content) as Record<string, unknown>))
        .not.toContain(String(SUPER_ADMIN_USER_ID));
    }
    // 写盘不带上它，读取侧照样恒为全开。
    expect(isWhitelisted(SUPER_ADMIN_USER_ID)).toBe(true);
    expect(hasWhitelistPermission(SUPER_ADMIN_USER_ID, "isCanBlock")).toBe(true);
  });

  test("权限写入成功后才发布新快照，落盘失败保持旧值", async () => {
    whitelistConfigCache.current = oneEntry(100);
    const writes: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      writes.push(content);
    });

    await expect(setWhitelistPermission(
      { id: 100, key: "isCanMute", value: true },
      { path: "/tmp/whitelist-test.json", writeText }
    )).resolves.toMatchObject({ changed: true });
    expect(hasWhitelistPermission(100, "isCanMute")).toBe(true);
    expect(JSON.parse(writes[0]!)["100"].isCanMute).toBe(true);

    const failure = new Error("disk full");
    writeText.mockImplementationOnce(async (): Promise<never> => {
      throw failure;
    });
    await expect(setWhitelistPermission(
      { id: 100, key: "isCanUnMute", value: true },
      { path: "/tmp/whitelist-test.json", writeText }
    )).rejects.toBe(failure);
    expect(hasWhitelistPermission(100, "isCanUnMute")).toBe(false);
  });

  test("不同群并发修改按调用顺序串行，最终文件包含两项授权", async () => {
    whitelistConfigCache.current = oneEntry(100);
    let releaseFirst!: () => void;
    const contents: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      contents.push(content);
      if (contents.length === 1) {
        await new Promise<void>((resolve: () => void): void => {
          releaseFirst = resolve;
        });
      }
    });

    const first: Promise<unknown> = setWhitelistPermission(
      { id: 100, key: "isCanMute", value: true },
      { writeText }
    );
    const second: Promise<unknown> = setWhitelistPermission(
      { id: 100, key: "isCanUnMute", value: true },
      { writeText }
    );
    await Bun.sleep(0);
    expect(contents).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);

    const persisted: Record<string, WhitelistPermissions> =
      JSON.parse(contents.at(-1)!) as Record<string, WhitelistPermissions>;
    expect(persisted["100"]?.isCanMute).toBe(true);
    expect(persisted["100"]?.isCanUnMute).toBe(true);
  });

  test("all 在一次写入中打开全部权限，重复执行保持幂等", async () => {
    whitelistConfigCache.current = oneEntry(100);
    const contents: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      contents.push(content);
    });

    await expect(enableAllWhitelistPermissions(
      100,
      { writeText }
    )).resolves.toMatchObject({ changed: true });
    for (const permission of Object.values(getWhitelistConfig().get(100)!)) {
      expect(permission).toBe(true);
    }
    expect(contents).toHaveLength(1);
    for (const permission of Object.values(JSON.parse(contents[0]!)["100"])) {
      expect(permission).toBe(true);
    }

    await expect(enableAllWhitelistPermissions(
      100,
      { writeText }
    )).resolves.toMatchObject({ changed: false });
    expect(contents).toHaveLength(1);
  });

  test("all 落盘失败不发布快照，不存在的身份同样拒绝", async () => {
    whitelistConfigCache.current = oneEntry(100);
    const failure = new Error("disk full");
    const writeText = mock(async (): Promise<never> => {
      throw failure;
    });

    await expect(enableAllWhitelistPermissions(
      100,
      { writeText }
    )).rejects.toBe(failure);
    expect(hasWhitelistPermission(100, "isCanMute")).toBe(false);

    await expect(enableAllWhitelistPermissions(
      200,
      { writeText }
    )).rejects.toThrow("does not exist");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("all 与后续单项收回串行，最终状态遵守调用顺序", async () => {
    whitelistConfigCache.current = oneEntry(100);
    let releaseFirst!: () => void;
    const contents: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      contents.push(content);
      if (contents.length === 1) {
        await new Promise<void>((resolve: () => void): void => {
          releaseFirst = resolve;
        });
      }
    });

    const enableAll: Promise<unknown> = enableAllWhitelistPermissions(
      100,
      { writeText }
    );
    const revokeMute: Promise<unknown> = setWhitelistPermission(
      { id: 100, key: "isCanMute", value: false },
      { writeText }
    );
    await Bun.sleep(0);
    expect(contents).toHaveLength(1);
    releaseFirst();
    await Promise.all([enableAll, revokeMute]);

    expect(contents).toHaveLength(2);
    expect(hasWhitelistPermission(100, "isCanMute")).toBe(false);
    expect(hasWhitelistPermission(100, "isCanUnMute")).toBe(true);
    expect(JSON.parse(contents[1]!)["100"].isCanMute).toBe(false);
  });

  test("成员 enable 使用完整默认权限，重复启用不重置，disable 幂等删除", async () => {
    whitelistConfigCache.current = oneEntry(100, { isCanMute: true });
    const contents: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      contents.push(content);
    });

    await expect(setWhitelistMembership(
      { id: 200, enabled: true },
      { writeText }
    )).resolves.toEqual({
      changed: true,
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
    });
    expect(getWhitelistConfig().get(200)).toEqual(DEFAULT_WHITELIST_PERMISSIONS);
    expect(JSON.parse(contents[0]!)["200"]).toEqual(DEFAULT_WHITELIST_PERMISSIONS);

    await expect(setWhitelistMembership(
      { id: 100, enabled: true },
      { writeText }
    )).resolves.toMatchObject({
      changed: false,
      permissions: { isCanMute: true },
    });
    expect(contents).toHaveLength(1);

    await expect(setWhitelistMembership(
      { id: 200, enabled: false },
      { writeText }
    )).resolves.toEqual({ changed: true, permissions: undefined });
    expect(getWhitelistConfig().has(200)).toBe(false);
    expect(JSON.parse(contents[1]!)["200"]).toBeUndefined();

    await expect(setWhitelistMembership(
      { id: 200, enabled: false },
      { writeText }
    )).resolves.toEqual({ changed: false, permissions: undefined });
    expect(contents).toHaveLength(2);
  });

  test("成员关系落盘失败时不发布内存快照", async () => {
    whitelistConfigCache.current = oneEntry(100);
    const failure = new Error("disk full");
    const writeText = mock(async (): Promise<never> => {
      throw failure;
    });

    await expect(setWhitelistMembership(
      { id: 200, enabled: true },
      { writeText }
    )).rejects.toBe(failure);
    expect(getWhitelistConfig().has(200)).toBe(false);

    await expect(setWhitelistMembership(
      { id: 100, enabled: false },
      { writeText }
    )).rejects.toBe(failure);
    expect(getWhitelistConfig().has(100)).toBe(true);
  });

  test("成员新增与逐项授权共用串行链，后一次授权能看到新增条目", async () => {
    whitelistConfigCache.current = parseWhitelistConfig({});
    let releaseFirst!: () => void;
    const contents: string[] = [];
    const writeText = mock(async (_path: string, content: string): Promise<void> => {
      contents.push(content);
      if (contents.length === 1) {
        await new Promise<void>((resolve: () => void): void => {
          releaseFirst = resolve;
        });
      }
    });

    const enable: Promise<unknown> = setWhitelistMembership(
      { id: 200, enabled: true },
      { writeText }
    );
    const grant: Promise<unknown> = setWhitelistPermission(
      { id: 200, key: "isCanMute", value: true },
      { writeText }
    );
    await Bun.sleep(0);
    expect(contents).toHaveLength(1);
    releaseFirst();
    await Promise.all([enable, grant]);

    expect(contents).toHaveLength(2);
    expect(JSON.parse(contents[1]!)["200"].isCanMute).toBe(true);
    expect(hasWhitelistPermission(200, "isCanMute")).toBe(true);
  });

  test("序列化输出完整权限对象并以换行结尾", () => {
    const serialized: string = serializeWhitelistConfig(oneEntry(-1001));
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)["-1001"]).toHaveProperty("isCanBlock", false);
    expect(JSON.parse(serialized)["-1001"]).toHaveProperty("isCanUnBlock", false);
  });

  test("回归用例：写出的文件按 id 升序，频道与大数用户 id 不被整数键重排顶到后面", () => {
    // 塞进一个对象再整体 stringify 的话，"123456789" 是整数索引形态的键、会被
    // 引擎提到最前面，负数频道 id 和超过 2^32 的新用户 id 反而排到它后面——
    // 运维手工排过 config/whitelist.json，下一次白名单命令写盘就重排一次。
    const config: WhitelistConfig = parseWhitelistConfig({
      "123456789": {},
      "-1001234567890": {},
      "6000000000": {},
    });
    const serialized: string = serializeWhitelistConfig(config);
    const keyOrder: string[] = [...serialized.matchAll(/^ {2}"(-?\d+)":/gm)]
      .map((match: RegExpMatchArray): string => match[1]!);

    expect(keyOrder).toEqual(["-1001234567890", "123456789", "6000000000"]);
    // 仍然是能被原样读回来的合法 JSON，且排版与 JSON.stringify(value, null, 2) 一致。
    expect(Object.keys(JSON.parse(serialized))).toHaveLength(3);
    expect(serialized).toContain("  \"-1001234567890\": {\n    \"isCanMute\": false");
    expect(serialized.endsWith("\n  }\n}\n")).toBe(true);
  });

  test("加载后文件被外部编辑时明确拒绝整份覆盖并保留外部字节", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "whitelist-conflict-"));
    const path: string = join(directory, "whitelist.json");
    try {
      writeFileSync(path, serializeWhitelistConfig(oneEntry(100)));
      expect(getWhitelistConfig(path).has(100)).toBe(true);

      const externallyEdited: WhitelistConfig = parseWhitelistConfig({
        "100": { isCanMute: false },
        "200": { isCanBlock: true },
      });
      const externalBytes: string = serializeWhitelistConfig(externallyEdited);
      writeFileSync(path, externalBytes);

      await expect(setWhitelistPermission(
        { id: 100, key: "isCanMute", value: true },
        { path }
      )).rejects.toThrow("changed outside this process");
      expect(readFileSync(path, "utf8")).toBe(externalBytes);
      expect(getWhitelistConfig().has(200)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("回归用例：改另一个文件时现读现改，不拿运行时那份去整份覆写", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "whitelist-foreign-"));
    const loadedPath: string = join(directory, "loaded.json");
    const otherPath: string = join(directory, "other.json");
    try {
      // 运行时快照来自 loadedPath；otherPath 里有一个只存在于它自己的身份。
      writeFileSync(loadedPath, serializeWhitelistConfig(oneEntry(100)));
      writeFileSync(otherPath, serializeWhitelistConfig(parseWhitelistConfig({
        "300": { isCanBlock: true },
        "400": {},
      })));
      expect(getWhitelistConfig(loadedPath).has(100)).toBe(true);

      await expect(setWhitelistPermission(
        { id: 300, key: "isCanMute", value: true },
        { path: otherPath }
      )).resolves.toMatchObject({ changed: true });

      // 目标文件保留自己的两个身份，且没有被 loadedPath 的 100 污染。
      const persisted: Record<string, WhitelistPermissions> =
        JSON.parse(readFileSync(otherPath, "utf8")) as Record<string, WhitelistPermissions>;
      expect(Object.keys(persisted).sort()).toEqual(["300", "400"]);
      expect(persisted["300"]?.isCanMute).toBe(true);
      expect(persisted["300"]?.isCanBlock).toBe(true);
      // 运行时判定仍来自 loadedPath：绝不能改成一个从未被要求加载的文件。
      expect(isWhitelisted(100)).toBe(true);
      expect(isWhitelisted(300)).toBe(false);
      // loadedPath 一个字节都没动，指纹槽位仍指向它，后续写入照常复核。
      expect(readFileSync(loadedPath, "utf8")).toBe(serializeWhitelistConfig(oneEntry(100)));
      writeFileSync(loadedPath, serializeWhitelistConfig(oneEntry(100, { isCanBlock: true })));
      await expect(setWhitelistPermission(
        { id: 100, key: "isCanMute", value: true },
        { path: loadedPath }
      )).rejects.toThrow("changed outside this process");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("本进程连续写入会推进文件指纹，不误报自己的上一次修改", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "whitelist-revision-"));
    const path: string = join(directory, "whitelist.json");
    try {
      writeFileSync(path, serializeWhitelistConfig(oneEntry(100)));
      getWhitelistConfig(path);

      await setWhitelistPermission(
        { id: 100, key: "isCanMute", value: true },
        { path }
      );
      await setWhitelistMembership(
        { id: 200, enabled: true },
        { path }
      );

      const persisted: Record<string, WhitelistPermissions> =
        JSON.parse(readFileSync(path, "utf8")) as Record<string, WhitelistPermissions>;
      expect(persisted["100"]?.isCanMute).toBe(true);
      expect(persisted["200"]).toEqual(DEFAULT_WHITELIST_PERMISSIONS);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
