import { beforeEach, expect, mock, test } from "bun:test";

const handleGagInlineQuery = mock(async (): Promise<boolean> => false);
const handleLuckChallengeInlineQuery = mock(async (): Promise<void> => undefined);

mock.module("../../packages/commands/gag", () => ({ handleGagInlineQuery }));
mock.module("../../packages/commands/luckChallenge", () => ({
  handleLuckChallengeInlineQuery,
}));

const { handleInlineQuery } = await import("../../packages/commands/inline");

beforeEach(() => {
  handleGagInlineQuery.mockClear();
  handleLuckChallengeInlineQuery.mockClear();
  handleGagInlineQuery.mockImplementation(async (): Promise<boolean> => false);
});

test("活动 gag 用户的 inline 查询被 gag 入口独占，不再生成运势选项", async () => {
  handleGagInlineQuery.mockImplementationOnce(async (): Promise<boolean> => true);
  const context: never = {} as never;
  await handleInlineQuery(context);
  expect(handleGagInlineQuery).toHaveBeenCalledWith(context);
  expect(handleLuckChallengeInlineQuery).not.toHaveBeenCalled();
});

test("非 gag 用户保持既有运势 inline 行为", async () => {
  const context: never = {} as never;
  await handleInlineQuery(context);
  expect(handleGagInlineQuery).toHaveBeenCalledWith(context);
  expect(handleLuckChallengeInlineQuery).toHaveBeenCalledWith(context);
});
