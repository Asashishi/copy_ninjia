import { describe, expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { formatTargetLabel, formatUserLabel } from "../../packages/users/userLabel";

describe("破坏性命令的目标标签", () => {
  test("有身份字段时与常规标签完全一致", () => {
    for (const user of [
      { id: 7, username: "alice" },
      { id: 7, first_name: "Alice" },
      { id: -1009, title: "某频道", isChannel: true },
    ]) {
      expect(formatTargetLabel(user, ATMOSPHERE_TEXTS.teasing)).toBe(formatUserLabel(user, ATMOSPHERE_TEXTS.teasing));
    }
  });

  test("只有 id 时念出 id，而不是泛指的兜底称呼", () => {
    expect(formatTargetLabel({ id: 4242 }, ATMOSPHERE_TEXTS.teasing)).toBe("用户 4242");
    expect(formatUserLabel({ id: 4242 }, ATMOSPHERE_TEXTS.teasing)).toBe("这个杂鱼");
  });

  test("只有 id 的频道身份念成频道，不与真人目标混为一谈", () => {
    expect(formatTargetLabel({ id: -1009, isChannel: true }, ATMOSPHERE_TEXTS.teasing)).toBe("频道 -1009");
    expect(formatUserLabel({ id: -1009, isChannel: true }, ATMOSPHERE_TEXTS.teasing)).toBe("这个频道");
  });

  test("昵称里的换行与连续空白照常压成单行，不把一整块贴图糊进回执", () => {
    expect(formatTargetLabel({ id: 7, first_name: "A\n\n  B" }, ATMOSPHERE_TEXTS.teasing)).toBe("A B");
  });
});
