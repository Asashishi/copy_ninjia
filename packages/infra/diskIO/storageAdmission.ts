import { STORAGE_PENDING_MAX_BYTES, STORAGE_PENDING_MAX_ENTRIES } from "../../consts/diskIO/business";
import { StorageWriteCapacityError } from "../../libs/storageWriteBudget";
import { signalDiskIOFatal } from "./fatal";

/** 主线程在发布最终值前检查所属领域的未 ACK 预算；拒收不淘汰既有事实。 */
export function assertStorageAdmission(entries: number, bytes: number): void {
  if (entries <= STORAGE_PENDING_MAX_ENTRIES && bytes <= STORAGE_PENDING_MAX_BYTES) return;
  const error: StorageWriteCapacityError = new StorageWriteCapacityError();
  signalDiskIOFatal(error);
  throw error;
}
