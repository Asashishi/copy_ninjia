import { expect, mock, test } from "bun:test";
import type { VerificationAttemptPermitResult } from "../../../packages/types/antiRaid";

const granted: VerificationAttemptPermitResult = { status: "granted", attempt: 3 };
const requestMainThread = mock(
  async (_request: unknown): Promise<VerificationAttemptPermitResult> => granted
);

mock.module("../../../packages/libs/workerDuplex", () => ({ requestMainThread }));

const { requestVerificationAttemptPermit } = await import(
  "../../../packages/workers/antiRaid/verificationAttemptPermit"
);

test("验证终态许可把 key、Worker 代际与 revision 原样封进双工请求", async () => {
  await expect(requestVerificationAttemptPermit("-1001:7", 4, 9)).resolves.toBe(granted);
  expect(requestMainThread).toHaveBeenCalledWith({
    operation: "verificationAttemptPermit",
    key: "-1001:7",
    generation: 4,
    revision: 9,
  });
});
