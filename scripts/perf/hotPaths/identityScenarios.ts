/**
 * 身份策略 LRU 的每消息热读场景。
 *
 * 每条群消息要在三张身份缓存上读多次：`canBypassFloodControl`
 * （antiRaid/floodControl.ts 的 buildFloodCandidate）、`canBypassAdDetection`
 * 与 `isUserBlocked`（antiRaid/adCandidate.ts 的 buildAdCandidate）。
 *
 * 场景覆盖 `libs/lruCache.ts` 的侵入式双向链表命中路径：命中只重连节点指针，
 * 不分配对象，也不对底层 Map 做删除后重插。
 *
 * 缓存整表填满（容量 `IDENTITY_READ_CACHE_MAX_ENTRIES`）：每条 update 的前置预热把
 * 见到的每个身份连同负缓存一起写进来（见 app/registerHandlers.ts）。取键序列固定，
 * 偏斜到反复发言的工作集（`WORKING_SET`），其余散落全表，不依赖时钟。
 */

import {
  blocklistEntryCache,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import { temporaryAdBypassActivityCache } from
  "../../../packages/cache/main/temporaryAdBypass";
import { IDENTITY_READ_CACHE_MAX_ENTRIES } from "../../../packages/consts/identityStorage";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../../packages/consts/whitelist";
import { SUPER_ADMIN_USER_ID } from "../../../packages/config/bot";
import {
  canBypassAdDetection,
  canBypassFloodControl,
} from "../../../packages/antiRaid/memberFacts";
import { isUserBlocked } from "../../../packages/infra/blocklist/membership";
import { LruCache } from "../../../packages/libs/lruCache";
import { prototypeProbes } from "./jitTiers";
import type { Scenario } from "./types";
import type {
  BlocklistEntryData,
  WhitelistEntryData,
} from "../../../packages/types/identityPolicy";

/** 基准身份的起始 id；远离 fixture 里其它场景使用的号段。 */
const IDENTITY_BASE: number = 7_000_000_000;
/** 一个活跃群里反复发言的身份数；其余条目是历史上见过的负缓存。 */
const WORKING_SET: number = 500;
/** 固定取键序列的下标掩码：序列长度为 KEY_SEQUENCE_MASK + 1（2 的幂），便于用位与取模。 */
const KEY_SEQUENCE_MASK: number = 65_535;

const BENCHMARK_META: WhitelistEntryData["meta"] = {
  firstName: "fixture",
  lastName: "",
  username: "fixture_user",
};

const WHITELIST_ENTRY: Readonly<WhitelistEntryData> = {
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: BENCHMARK_META,
};

const BLOCKLIST_ENTRY: Readonly<BlocklistEntryData> = {
  blockedAt: "2026/08/16 12:00:00",
  meta: BENCHMARK_META,
};

/** 超级管理员在两个读口都会短路，序列里的 id 避开它。 */
function benchmarkIdentityId(index: number): number {
  const id: number = IDENTITY_BASE + index;
  return id === SUPER_ADMIN_USER_ID ? id + IDENTITY_READ_CACHE_MAX_ENTRIES : id;
}

/** 确定性伪随机取键：偏斜到工作集，其余散落全表。 */
function buildKeySequence(): Int32Array {
  const keys: Int32Array = new Int32Array(KEY_SEQUENCE_MASK + 1);
  let state: number = 123_456_789;
  for (let index: number = 0; index < keys.length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const roll: number = state / 0x1_0000_0000;
    keys[index] = roll < 0.9
      ? Math.floor((roll / 0.9) * WORKING_SET)
      : Math.floor(((roll - 0.9) / 0.1) * IDENTITY_READ_CACHE_MAX_ENTRIES);
  }
  return keys;
}

export function createIdentityPermissionReadScenario(): Scenario {
  // Int32Array 装不下 Telegram id，序列里存的是下标，取用时换算成 id。
  const keys: Int32Array = buildKeySequence();
  const ids: Float64Array = new Float64Array(IDENTITY_READ_CACHE_MAX_ENTRIES);
  for (let index: number = 0; index < ids.length; index += 1) {
    ids[index] = benchmarkIdentityId(index);
  }
  return {
    iterations: 3_000_000,
    prepare: (): void => {
      for (let index: number = 0; index < ids.length; index += 1) {
        const id: number = ids[index]!;
        // 绝大多数条目是负缓存（见过、但不在任何名单里）；三张表一起填充，
        // 临时广告免检的常态热读也进入场景。
        const whitelisted: boolean = index % 50 === 0;
        const blocked: boolean = !whitelisted && index % 97 === 0;
        whitelistEntryCache.set(id, whitelisted ? WHITELIST_ENTRY : null);
        blocklistEntryCache.set(id, blocked ? BLOCKLIST_ENTRY : null);
        temporaryAdBypassActivityCache.set(id, null);
      }
    },
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const id: number = ids[keys[index & KEY_SEQUENCE_MASK]!]!;
        // 与 buildFloodCandidate + buildAdCandidate 在一条群消息上的读法一致。
        if (canBypassFloodControl(id)) checksum += 1;
        if (canBypassAdDetection(id)) checksum += 1;
        if (isUserBlocked(id)) checksum += 1;
      }
      return checksum;
    },
    reset: (): void => {
      whitelistEntryCache.clear();
      blocklistEntryCache.clear();
      temporaryAdBypassActivityCache.clear();
    },
    probes: {
      canBypassFloodControl,
      isUserBlocked,
      ...prototypeProbes("LruCache", LruCache.prototype, ["get"]),
    },
  };
}
