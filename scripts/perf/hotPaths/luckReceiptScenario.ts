import { confirmLuckDraw } from "../../../packages/commands/luckChallenge/receipt";
import type { Scenario } from "./types";

/** 普通消息回执快路径输入；轮换长度和换行位置，防止 JSC 把解析折叠成常量。 */
const LUCK_RECEIPT_FAST_PATH_TEXTS: readonly string[] = [
  "ordinary message",
  "普通聊天消息",
  "first line\nsecond ordinary line",
  "short",
];

/** 每条带正文 update 都会经过的运势回执同步拒绝路径。 */
export function createLuckReceiptFastPathScenario(): Scenario {
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      const length: number = LUCK_RECEIPT_FAST_PATH_TEXTS.length;
      for (let index: number = 0; index < iterations; index += 1) {
        const text: string = LUCK_RECEIPT_FAST_PATH_TEXTS[index % length]!;
        const confirmation: Promise<void> | undefined = confirmLuckDraw(text);
        if (confirmation !== undefined) checksum += 1;
        checksum += text.length;
      }
      return checksum;
    },
    probes: { confirmLuckDraw },
  };
}
