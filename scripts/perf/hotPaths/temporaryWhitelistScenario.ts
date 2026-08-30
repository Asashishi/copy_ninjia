import { TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD } from
  "../../../packages/consts/temporaryWhitelist";
import { advanceTemporaryWhitelistActivity } from
  "../../../packages/states/temporaryWhitelist";
import type { TemporaryWhitelistActivity } from
  "../../../packages/types/temporaryWhitelist";
import type { Scenario } from "./types";

/** 临时白名单日内稳态与首次授权边沿共用的固定基准输入。 */
export function createTemporaryWhitelistActivityScenario(): Scenario {
  const steady: Readonly<TemporaryWhitelistActivity> = {
    tempWhite: false,
    tempWhiteAt: null,
    tempWhiteCount: 0,
    sendCount: 1,
    countedAt: 1_800_000_000_000,
    qualifiedAt: null,
  };
  const grantEdge: Readonly<TemporaryWhitelistActivity> = {
    tempWhite: false,
    tempWhiteAt: null,
    tempWhiteCount: 0,
    sendCount: TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD,
    countedAt: 1_800_000_000_000,
    qualifiedAt: null,
  };
  const now: number = steady.countedAt + 1;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        // 90% 日内未授权稳态、10% 首次合格授权边沿；输入与对象 shape 固定。
        const current: Readonly<TemporaryWhitelistActivity> =
          index % 10 === 0 ? grantEdge : steady;
        const next: Readonly<TemporaryWhitelistActivity> =
          advanceTemporaryWhitelistActivity(current, now);
        checksum += next.sendCount + (next.tempWhite ? 1 : 0);
      }
      return checksum;
    },
    probes: { advanceTemporaryWhitelistActivity },
  };
}
