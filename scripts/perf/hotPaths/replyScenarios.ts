import { decodeBase64Payload } from "../../../packages/aiChat/ai/utils/base64Payload";
import type { DecodeBase64PayloadOptions } from "../../../packages/aiChat/ai/utils/base64Payload";
import { IMAGE_GENERATION_MAX_BYTES } from "../../../packages/consts/aiChat/imageGeneration";
import { SONG_GENERATION_MAX_BYTES, SONG_GENERATION_MAX_ENCODED_CHARS } from "../../../packages/consts/aiChat/songGeneration";
import { RATE_LIMIT_LONG_MAX_TRIGGERS, REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL, REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../../../packages/consts/aiChat/rateLimit";
import { admitRound, admitTrigger } from "../../../packages/states/replyAdmission";
import { reserveReplyDelivery } from "../../../packages/workers/aiChat/replyDelivery";
import { invalidateChatReplyCache, replyDeliveryCounts, replyDeliveryTotal, replyDeliveryWindows } from "../../../packages/cache/workers/aiChat/replies";
import type { AdmitRoundInput, AdmitTriggerInput } from "../../../packages/types/states/replyAdmission";
import type { ReplyDeliveryTurn } from "../../../packages/types/aiChat/replies";
import type { Scenario } from "./types";

/** 覆盖模型、存活容量、队列、触发种类和出站压力的准入组合，计时内仅传既有输入。 */
export function replyAdmissionScenario(): Scenario {
  const inputs: AdmitTriggerInput[] = [];
  for (const kind of ["direct", "random", "mediaDirect", "mediaRandom"] as const) {
    for (const telegramBackpressured of [false, true]) {
      for (const deliveryAvailable of [true, false]) {
        for (const activeRounds of [0, 1, REPLY_ROUND_MAX_CONCURRENT - 1, REPLY_ROUND_MAX_CONCURRENT]) {
          for (const queueSize of [0, REPLY_TRIGGER_QUEUE_MAX - 1, REPLY_TRIGGER_QUEUE_MAX]) {
            inputs.push({ activeRounds, queueSize, kind, telegramBackpressured, deliveryAvailable });
          }
        }
      }
    }
  }
  const rounds: readonly AdmitRoundInput[] = [
    { windowCount: 0 }, { windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS - 1 }, { windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS },
  ];
  return {
    iterations: 4_000_000,
    warmupIterations: 8_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        checksum += admitTrigger(inputs[index % inputs.length]!).action.length +
          admitRound(rounds[index % rounds.length]!).action.length;
      }
      return checksum;
    },
    probes: { admitTrigger, admitRound },
  };
}

/** 固定字节分布与大小，独立测量有效媒体和异常首尾；解码结果逐次校验。 */
export function base64PayloadScenario(shape: "normal" | "large" | "head" | "tail"): Scenario {
  const size: number = shape === "large" ? SONG_GENERATION_MAX_BYTES / 3 : IMAGE_GENERATION_MAX_BYTES / 10;
  const payload: Uint8Array = new Uint8Array(size);
  for (let index: number = 0; index < payload.length; index++) payload[index] = (index * 73 + 19) % 256;
  const encoded: string = payload.toBase64();
  const params: DecodeBase64PayloadOptions = {
    encoded: new TextDecoder().decode(new TextEncoder().encode(
      shape === "head" ? `!${encoded.slice(1)}` : shape === "tail" ? `${encoded.slice(0, -1)}!` : encoded
    )),
    maxEncodedChars: SONG_GENERATION_MAX_ENCODED_CHARS,
    maxBytes: SONG_GENERATION_MAX_BYTES,
  };
  const invalid: boolean = shape === "head" || shape === "tail";
  const iterations: number = shape === "head" ? 1_000_000 : shape === "large" ? 16 : 80;
  return {
    iterations,
    warmupIterations: iterations,
    profileRequiresOptimizedJit: false,
    run: (count: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < count; index++) {
        const result: ReturnType<typeof decodeBase64Payload> = decodeBase64Payload(params);
        if (invalid) {
          if (result.ok || result.reason !== "payload is not canonical base64") throw new Error("Invalid Base64 fixture was accepted.");
          checksum++;
        } else {
          if (!result.ok || result.bytes.length !== size || result.bytes[size - 1] !== payload[size - 1]) throw new Error("Base64 fixture bytes changed.");
          checksum += result.bytes[0]!;
        }
      }
      return checksum;
    },
    probes: { decodeBase64Payload },
  };
}

/** 正常发送及阻塞/重开压力均调用生产顺位边界，按真实存活数核对容量与清理。 */
export function replyDeliveryScenario(blocked: boolean): Scenario {
  return {
    iterations: blocked ? 40 : 10_000,
    warmupIterations: blocked ? 200 : 10_000,
    run: async (iterations: number): Promise<number> => {
      let checksum: number = 0;
      for (let iteration: number = 0; iteration < iterations; iteration++) {
        const total: number = blocked ? REPLY_DELIVERY_MAX_TOTAL : 1;
        const turns: ReplyDeliveryTurn[] = [];
        try {
          for (let index: number = 0; index < total; index++) {
            const chatId: number = -1 - Math.floor(index / REPLY_DELIVERY_MAX_PER_CHAT);
            const turn: ReplyDeliveryTurn | undefined = reserveReplyDelivery(chatId);
            if (!turn) throw new Error("Reply delivery rejected available capacity.");
            turns.push(turn);
            if (blocked) invalidateChatReplyCache(chatId);
          }
          if (replyDeliveryTotal.current !== total) throw new Error("Reply delivery count drifted.");
          if (blocked) {
            for (let index: number = 0; index < RATE_LIMIT_LONG_MAX_TRIGGERS; index++) {
              if (reserveReplyDelivery(-1) !== undefined || reserveReplyDelivery(-999) !== undefined) {
                throw new Error("Reply delivery escaped the capacity limit.");
              }
            }
          }
          checksum += total;
        } finally {
          for (const turn of turns) {
            turn.commit();
            await turn.ready;
            await turn.finish();
          }
        }
        if (replyDeliveryTotal.current !== 0 || replyDeliveryCounts.size !== 0 || replyDeliveryWindows.size !== 0) {
          throw new Error("Reply delivery retained finished work.");
        }
      }
      return checksum;
    },
    probes: { reserveReplyDelivery },
  };
}
