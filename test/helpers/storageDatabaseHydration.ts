import {
  adoptStorageDatabase,
  inspectStorageDatabase,
} from "../../packages/workers/diskIO/storageDatabase/hydration";
import type { StorageDatabaseHydration } from "../../packages/types/identityStorage";

/**
 * 单领域恢复：生产启动编排走 inspect/adopt 两阶段（跨域先全部 inspect 再统一
 * adopt，见 workers/diskIO/startup.ts），只有用例需要把两步并成一次调用。
 */
export function hydrateStorageDatabase(): StorageDatabaseHydration {
  return adoptStorageDatabase(inspectStorageDatabase());
}
