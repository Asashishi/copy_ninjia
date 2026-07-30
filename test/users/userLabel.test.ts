import { describe, expect, test } from "bun:test";
import { formatTargetLabel, formatUserLabel } from "../../packages/users/userLabel";

describe("破坏性命令的目标标签", () => {
  test("有身份字段时与常规标签完全一致", () => {
    for (const user of [
      { id: 7, username: "alice" },
      { id: 7, first_name: "Alice" },
      { id: -1009, title: "某频道", isChannel: true },
    ]) {
      expect(formatTargetLabel(user)).toBe(formatUserLabel(user));
    }
  });

  test("只有 id 时念出 id，而不是泛指的兜底称呼", () => {
    // 按裸 id 下的 /block 会走到这一档：那个人可能从没在本天才见过的群里说过
    // 话。回执必须把 id 原样念出来，否则打错一位数字根本看不出来。
    expect(formatTargetLabel({ id: 4242 })).toBe("用户 4242");
    expect(formatUserLabel({ id: 4242 })).toBe("这个杂鱼");
  });

  test("只有 id 的频道身份念成频道，不与真人目标混为一谈", () => {
    // /unblock 按负数 id 划掉的正是这一档，而 isChannel 同时决定走哪个解封
    // 接口——回执得让管理员看出本天才把目标当成了哪一类。
    expect(formatTargetLabel({ id: -1009, isChannel: true })).toBe("频道 -1009");
    expect(formatUserLabel({ id: -1009, isChannel: true })).toBe("这个频道");
  });

  test("昵称里的换行与连续空白照常压成单行，不把一整块贴图糊进回执", () => {
    expect(formatTargetLabel({ id: 7, first_name: "A\n\n  B" })).toBe("A B");
  });
});
