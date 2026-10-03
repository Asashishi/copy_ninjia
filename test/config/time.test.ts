import { afterEach, expect, test } from "bun:test";
import { timeZoneState } from "../../packages/cache/perThread/time";
import { adoptTimeZone, getTimeZone, getTimeZoneState } from "../../packages/config/time";
import { BOT_CONFIG_PATH } from "../../packages/consts/paths";
import type { TimeZoneState } from "../../packages/types/time";

const INITIAL_STATE: TimeZoneState = getTimeZoneState();
afterEach((): void => { timeZoneState.current = INITIAL_STATE; });

test("未接管时区时拒绝日历操作，不从宿主机推断时区", (): void => {
  timeZoneState.current = null;
  expect(getTimeZone).toThrow(`${BOT_CONFIG_PATH}: $.time_zone must be initialized before calendar operations.`);
});

test("同一启动时区复用格式器，重放不同快照时在当前线程重建", (): void => {
  const assertReadonly = (state: TimeZoneState): void => {
    // @ts-expect-error 启动时区只通过接管快照整体替换，调用方不得改写。
    state.timeZone = "UTC";
    // @ts-expect-error 构造后的格式器句柄只供读取，不允许调用方替换。
    state.fullTimeFormatter = new Intl.DateTimeFormat();
  };
  expect(assertReadonly).toBeDefined();
  adoptTimeZone(INITIAL_STATE.timeZone);
  expect(getTimeZoneState()).toBe(INITIAL_STATE);
  adoptTimeZone("UTC");
  expect(getTimeZone()).toBe("UTC");
  const utc: TimeZoneState = getTimeZoneState();
  expect(utc.fullTimeFormatter.resolvedOptions().timeZone).toBe("UTC");
  adoptTimeZone("UTC");
  expect(getTimeZoneState()).toBe(utc);
});
