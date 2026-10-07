import { afterEach, describe, expect, test } from "bun:test";
import { adoptPersona, getPersona } from "../../packages/config/persona";
import { personaCache } from "../../packages/cache/perThread/config";

// preload 已经为全进程装好人设快照；本文件临时改写 holder，跑完还原。
const PRELOADED_PERSONA: string | null = personaCache.current;

afterEach((): void => {
  personaCache.current = PRELOADED_PERSONA;
});

describe("persona snapshot", () => {
  test("运行期只读已接管的快照，未接管时拒绝而不回退读盘", () => {
    adoptPersona("已经接管的人设");
    expect(getPersona()).toBe("已经接管的人设");
    personaCache.current = null;
    expect(() => getPersona()).toThrow("Persona was not initialized by the deployment input preflight.");
  });
});
