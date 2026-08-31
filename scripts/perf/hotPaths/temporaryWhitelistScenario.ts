import { TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD } from
  "../../../packages/consts/temporaryWhitelist";
import { advanceTemporaryWhitelistActivity } from
  "../../../packages/states/temporaryWhitelist";
import type { TemporaryWhitelistActivity } from
  "../../../packages/types/temporaryWhitelist";
import type { Scenario } from "./types";

/** 临时白名单已达标稳态、未达标稳态与首次授权边沿共用的固定基准输入。 */
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
  // 活跃发言者当天第 8 条之后的全部消息都落在这一形态上：状态机原样返回入参，
  // 调用方据此跳过写回，所以它必须占基准输入的主体。
  const qualified: Readonly<TemporaryWhitelistActivity> = {
    tempWhite: true,
    tempWhiteAt: 1_800_000_000_000,
    tempWhiteCount: 1,
    sendCount: TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD + 1,
    countedAt: 1_800_000_000_000,
    qualifiedAt: 1_800_000_000_000,
  };
  const now: number = steady.countedAt + 1;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        // 80% 日内已达标稳态、10% 未授权稳态、10% 首次合格授权边沿；
        // 输入与对象 shape 固定。
        const slot: number = index % 10;
        const current: Readonly<TemporaryWhitelistActivity> =
          slot === 0 ? grantEdge : slot === 1 ? steady : qualified;
        const next: Readonly<TemporaryWhitelistActivity> =
          advanceTemporaryWhitelistActivity(current, now);
        checksum += next.sendCount + (next.tempWhite ? 1 : 0);
      }
      return checksum;
    },
    probes: { advanceTemporaryWhitelistActivity },
  };
}
