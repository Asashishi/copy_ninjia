import { DISK_BUSINESS_MESSAGE_BASE_BYTES, STORAGE_PENDING_MAX_BYTES, STORAGE_PENDING_MAX_ENTRIES } from "../consts/diskIO/business";

/** 待写文本的保守 UTF-16 与记录开销预算；null 墓碑仍占一个条目。 */
export function storageWriteCost(data: string | null, key: string = ""): number {
  return DISK_BUSINESS_MESSAGE_BASE_BYTES + ((data?.length ?? 0) + key.length) * 2;
}

/** 容量拒收必须与普通领域校验失败区分，通知宿主停止入口。 */
export class StorageWriteCapacityError extends Error {
  constructor() { super("Storage pending write capacity was exhausted."); }
}

/** 按最终值计费；新增、替换和删除的预算变动必须先于缓冲修改。 */
export class StorageWriteBudget {
  private entries: number = 0;
  private bytes: number = 0;

  /** 在一个同步片段中预约行变化；拒绝时不改变已有预算。 */
  reserve(entryDelta: number, byteDelta: number): void {
    if (this.entries + entryDelta > STORAGE_PENDING_MAX_ENTRIES ||
      this.bytes + byteDelta > STORAGE_PENDING_MAX_BYTES) throw new StorageWriteCapacityError();
    this.entries += entryDelta;
    this.bytes += byteDelta;
  }

  /** 事务成功、回调之前释放；失败事务不得调用。 */
  reset(): void { this.entries = 0; this.bytes = 0; }
}
