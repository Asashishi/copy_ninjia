import { afterEach, describe, expect, test } from "bun:test";
import {
  activeCopyModeIn,
  activeCopyTargetIdIn,
  claimCopyCooldown,
  getGlobalCopyState,
  restoreCopyCooldown,
} from "../../../packages/infra/storage/stateStore";
import { globalCopyState } from "../../../packages/cache/main/storage";

describe("全局复读状态门面", () => {
  afterEach((): void => {
    globalCopyState.copiedUser = null;
    globalCopyState.copyMode = undefined;
    globalCopyState.copyChatId = undefined;
    globalCopyState.lastCopyTime = undefined;
  });

  test("目标只在所属群可见，模式与同一份权威状态保持一致", (): void => {
    expect(activeCopyTargetIdIn(-1001)).toBeUndefined();
    expect(activeCopyModeIn(-1001)).toBeUndefined();

    globalCopyState.copiedUser = { id: 42, first_name: "Target" };
    globalCopyState.copyMode = "reverse";
    globalCopyState.copyChatId = -1001;

    expect(activeCopyTargetIdIn(-1002)).toBeUndefined();
    expect(activeCopyModeIn(-1002)).toBeUndefined();
    expect(activeCopyTargetIdIn(-1001)).toBe(42);
    expect(activeCopyModeIn(-1001)).toBe("reverse");
    expect(getGlobalCopyState()).toBe(globalCopyState);
  });

  test("冷却占位返回原值；回滚只在起点仍是本次占位时生效", (): void => {
    globalCopyState.lastCopyTime = 900_000;
    expect(claimCopyCooldown(1_000_000)).toBe(900_000);
    expect(globalCopyState.lastCopyTime).toBe(1_000_000);

    // 期间另一次占位（超级管理员豁免冷却）改写了起点：旧占位的回滚不得抹掉它。
    globalCopyState.lastCopyTime = 1_000_001;
    expect(restoreCopyCooldown(1_000_000, 900_000)).toBeFalse();
    expect(globalCopyState.lastCopyTime).toBe(1_000_001);

    globalCopyState.lastCopyTime = 1_000_000;
    expect(restoreCopyCooldown(1_000_000, 900_000)).toBeTrue();
    expect(globalCopyState.lastCopyTime).toBe(900_000);
  });

  test("只读视图不允许调用方绕过写入边界", (): void => {
    const check = (): void => {
      // @ts-expect-error 冷却起点只能经 claimCopyCooldown/restoreCopyCooldown 改写。
      getGlobalCopyState().lastCopyTime = 0;
      // @ts-expect-error 复读目标只能经 adoptCopyTarget/clearCopyTarget 改写。
      getGlobalCopyState().copiedUser = null;
    };
    expect(check).toBeFunction();
  });
});
