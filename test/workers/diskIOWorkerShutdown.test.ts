/** Disk I/O Worker 路由：停机关库请求的回执、关库后的身份写忽略与写入容量停摆回执。 */

import { describe, expect, test } from "bun:test";
import { StorageWriteCapacityError } from "../../packages/libs/storageWriteBudget";
import {
  closeStorageDatabaseForShutdown,
  consoleError,
  handleIdentityPolicyWrite,
  postMessage,
  rejectedStorageDomains,
  route,
  storageDatabaseClosed,
} from "../helpers/diskIOWorkerRouterHarness";

describe("Disk I/O Worker 停机关库路由", () => {
  test("closeStorage 带回关库结局；关库抛错时只带错误文案", async () => {
    await route({ type: "closeStorage", requestId: 3 });
    expect(closeStorageDatabaseForShutdown).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "storageClosed",
      requestId: 3,
      outcome: { committed: true, checkpointBusy: false },
    });

    closeStorageDatabaseForShutdown.mockImplementationOnce((): never => {
      throw new Error("database is locked");
    });
    await route({ type: "closeStorage", requestId: 4 });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "storageClosed", requestId: 4, error: "database is locked" });
  });

  test("关库后到达的身份写直接忽略：不调用写入、不记拒收", async () => {
    storageDatabaseClosed.current = true;
    await route({ type: "identityPolicyWrite", table: "whitelist", id: 7, data: null, revision: 1 });

    expect(handleIdentityPolicyWrite).not.toHaveBeenCalled();
    expect(rejectedStorageDomains.size).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("身份写触发容量超限时记拒收并回 storageWriteStalled", async () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): never => {
      throw new StorageWriteCapacityError();
    });
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "identityPolicyWrite", table: "whitelist", id: 7, data: null, revision: 1 });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).toHaveBeenCalledWith({ type: "storageWriteStalled" });
    expect([...rejectedStorageDomains]).toEqual(["whitelist"]);
    rejectedStorageDomains.clear();
  });
});
