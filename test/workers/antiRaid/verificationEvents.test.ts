import { beforeEach, expect, mock, test } from "bun:test";
import type { NewMemberMessage } from "../../../packages/types/antiRaid/protocol";
import type { VerificationEvent } from "../../../packages/types/states/verification";

const CHAT_ID: number = -1001;
const MEMBER_ID: number = 46;
const recordJoin = mock((chatId: number, _now: number): void => {
  lockdownEntries.set(chatId, {} as any);
});

mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({ recordJoin }));

const { lockdownEntries } = await import("../../../packages/cache/workers/antiRaid/lockdown");
const {
  deferredVerificationRecords,
  threadCommentConfirmations,
  verificationEntries,
} = await import("../../../packages/cache/workers/antiRaid/verification");
const { chatAdmins } = await import("../../../packages/cache/workers/antiRaid/admins");
const { recentChannelComments } = await import("../../../packages/cache/workers/antiRaid/recentComments");
const { handleJoinEvent } = await import("../../../packages/workers/antiRaid/verificationEvents");

beforeEach((): void => {
  recordJoin.mockClear();
  lockdownEntries.clear();
  deferredVerificationRecords.clear();
  threadCommentConfirmations.clear();
  verificationEntries.clear();
  chatAdmins.clear();
  recentChannelComments.clear();
});

test("触发私密模式的临界入群读取 recordJoin 建立的新占位", (): void => {
  const message: NewMemberMessage = {
    type: "join",
    chatId: CHAT_ID,
    member: { id: MEMBER_ID, first_name: "临界成员" },
  };
  let dispatched: VerificationEvent | null = null;

  handleJoinEvent({
    message,
    dispatchVerification: (
      _chatId: number,
      _userId: number,
      event: VerificationEvent
    ): void => {
      dispatched = event;
    },
  });

  expect(recordJoin).toHaveBeenCalledTimes(1);
  expect(dispatched).toMatchObject({
    type: "join",
    memberId: MEMBER_ID,
    lockdownActive: true,
  });
});
