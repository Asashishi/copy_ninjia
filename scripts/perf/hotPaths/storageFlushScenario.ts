import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from "../../../packages/consts/identityStorage";
import { storageDatabaseHandle, resetStorageDatabaseCache } from "../../../packages/cache/workers/diskIO/storageDatabase";
import { openStorageDatabase } from "../../../packages/database/interact/connection";
import { createStorageDatabase } from "../../../packages/database/interact/migration";
import { handleTemporaryWhitelistWrite } from "../../../packages/workers/diskIO/storageDatabase/temporaryWhitelist";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import type { IdentityStoragePersistedReply } from "../../../packages/types/diskIO/replies";
import { assertInsidePerformanceMockRoot } from "../fullSuite/mockRoot";
import type { Scenario } from "./types";

/** 真正的 SQLite 批量写入和精确 ACK；每次迭代提交一个生产容量的事务。 */
export function storageFlushScenario(): Scenario {
  assertInsidePerformanceMockRoot(IDENTITY_DATABASE_PATH);
  mkdirSync(dirname(IDENTITY_DATABASE_PATH), { recursive: true });
  if (!existsSync(IDENTITY_DATABASE_PATH)) createStorageDatabase(IDENTITY_DATABASE_PATH);
  let confirmed: number = 0;
  let revision: number = 0;
  function reply(value: IdentityStoragePersistedReply): void { confirmed += value.temporaryWhitelistWrites.length; }
  return {
    iterations: 1_000,
    prepare: (): void => { storageDatabaseHandle.current = openStorageDatabase({ path: IDENTITY_DATABASE_PATH }); },
    run: (iterations: number): number => {
      const before: number = confirmed;
      for (let index: number = 0; index < iterations; index++) {
        for (let id: number = 1; id <= IDENTITY_WRITE_BATCH_MAX_ENTRIES; id++) {
          handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id, activity: null, revision: ++revision }, reply);
        }
      }
      if (confirmed - before !== iterations * IDENTITY_WRITE_BATCH_MAX_ENTRIES) throw new Error("SQLite benchmark omitted durable acknowledgements.");
      return confirmed - before;
    },
    reset: (): void => { resetStorageDatabaseCache(); confirmed = 0; revision = 0; },
    probes: { handleTemporaryWhitelistWrite, flushStorageDatabase },
  };
}
