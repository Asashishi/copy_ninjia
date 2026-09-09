import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptPersona,
  ensurePersona,
  getPersona,
  loadPersona,
} from "../../packages/config/persona";
import { personaCache } from "../../packages/cache/perThread/config";

// preload 已经为全进程装好人设快照；本文件会临时改写 holder，跑完必须还原，
// 否则后续文件里读 getPersona 的用例会看到本文件留下的值。
const PRELOADED_PERSONA: string | null = personaCache.current;

/** 各用例独占的临时目录；afterEach 整棵删掉，不给 tmpdir 留残留。 */
const tempDirs: string[] = [];

afterEach((): void => {
  personaCache.current = PRELOADED_PERSONA;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 开一个用例独占的临时目录并登记，返回其中尚未创建的人设文件路径。 */
function personaPath(): string {
  const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
  tempDirs.push(directory);
  return join(directory, "persona.md");
}

describe("persona deployment input", () => {
  test("缺失与空白文件都安全地拒绝", async () => {
    const path: string = personaPath();

    await expect(loadPersona(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
    await Bun.write(path, " \n\t ");
    await expect(loadPersona(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
  });

  test("非空内容去掉边界空白后复用", async () => {
    const path: string = personaPath();
    await Bun.write(path, "  stable persona  \n");

    expect(await loadPersona(path)).toBe("stable persona");
  });

  test("ensurePersona 只在 holder 为空时读盘，已有快照时原样短路", async () => {
    adoptPersona("已经接管的人设");
    await ensurePersona();
    // 短路分支：holder 非空就直接返回，不得再读 PERSONA_PATH 覆盖掉调用方
    // 通过启动预检或 Worker init 消息接管的那一份。
    expect(getPersona()).toBe("已经接管的人设");
  });

  test("ensurePersona 在 holder 为空时按默认路径补齐快照", async () => {
    personaCache.current = null;
    await ensurePersona();
    expect(getPersona().length).toBeGreaterThan(0);
    // 幂等：补齐之后再调一次不改变已接管的快照。
    const filled: string = getPersona();
    await ensurePersona();
    expect(getPersona()).toBe(filled);
  });

  test("非法 UTF-8 不得被替换字符掩盖", async () => {
    const path: string = personaPath();
    await Bun.write(path, new Uint8Array([0xff]));

    await expect(loadPersona(path)).rejects.toThrow(
      `${path}: $ must be a readable non-empty UTF-8 text file`
    );
  });
});
