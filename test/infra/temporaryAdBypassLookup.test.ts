import { afterEach, expect, spyOn, test } from "bun:test";
import { temporaryAdBypassActivityCache } from "../../packages/cache/main/temporaryAdBypass";
import { whitelistEntryCache } from "../../packages/cache/main/identityStorage";
import { DAY_MS } from "../../packages/consts/time";
import {
  hasActiveTemporaryAdBypass,
  hasActiveTemporaryAdBypassAt,
} from "../../packages/infra/identityPolicy/temporaryAdBypass";
import { getEffectiveWhitelistPermissions } from "../../packages/infra/identityPolicy/whitelist";

afterEach(() => {
  temporaryAdBypassActivityCache.clear();
  whitelistEntryCache.clear();
});

test("缺省时刻时只在缓存确有免检记录时读墙钟，负缓存查询不取时钟", () => {
  const now: number = Date.now();
  whitelistEntryCache.set(7, null);
  temporaryAdBypassActivityCache.set(7, {
    adBypass: true,
    adBypassGrantedAt: now - DAY_MS,
    qualifiedDays: 7,
    sendCount: 8,
    countedAt: now - DAY_MS,
    qualifiedAt: now - DAY_MS,
  });
  whitelistEntryCache.set(8, null);
  temporaryAdBypassActivityCache.set(8, null);
  const clock = spyOn(Date, "now");
  try {
    expect(hasActiveTemporaryAdBypass(8)).toBeFalse();
    expect(getEffectiveWhitelistPermissions(8)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
    expect(hasActiveTemporaryAdBypass(7)).toBeTrue();
    expect(getEffectiveWhitelistPermissions(7)).toBeDefined();
    expect(clock).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
  expect(hasActiveTemporaryAdBypassAt(7, now)).toBeTrue();
  expect(hasActiveTemporaryAdBypassAt(7, now + 3 * DAY_MS)).toBeFalse();
});
