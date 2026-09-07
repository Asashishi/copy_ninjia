import { PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES } from "../../../packages/consts/telegram";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../packages/consts/aiChat/media";
import { readBoundedResponseBytes } from "../../../packages/libs/boundedResponse";
import type { BoundedResponseResult } from "../../../packages/libs/boundedResponse";
import type { Scenario } from "./types";

/** 按固定输入分别测量空块、细碎块及正常响应，逐响应核对内容及锁释放。 */
export function boundedResponseScenario(shape: "empty" | "tiny" | "small" | "normal" | "large"): Scenario {
  const chunkBytes: number = shape === "empty" ? 0 : shape === "tiny" ? 1 : shape === "small" ? 1_024 : 65_536;
  const bytes: number = shape === "empty" ? 0 : shape === "tiny" ? PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES / 8 : shape === "small" ? chunkBytes : shape === "large" ? MEDIA_MAX_DOWNLOAD_BYTES : PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES;
  const chunkCount: number = shape === "empty" ? PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES / 8 : bytes / chunkBytes;
  return {
    iterations: shape === "empty" || shape === "tiny" ? 3 : shape === "small" ? 1_000 : shape === "large" ? 10 : 100,
    warmupIterations: shape === "empty" || shape === "tiny" ? 10 : shape === "large" ? 100 : 1_000,
    profileRequiresOptimizedJit: false,
    run: async (iterations: number): Promise<number> => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        let remaining: number = chunkCount;
        const response: Response = new Response(new ReadableStream<Uint8Array>({
          pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
            if (remaining === 0) { controller.close(); return; }
            remaining--;
            controller.enqueue(new Uint8Array(chunkBytes).fill(remaining % 251));
          },
        }));
        const result: BoundedResponseResult = await readBoundedResponseBytes(response, bytes);
        if (!result.ok || result.bytes.byteLength !== bytes || remaining !== 0 || response.body?.locked) throw new Error("Bounded response did not consume and release the fixture.");
        for (let offset: number = 0; offset < bytes; offset += chunkBytes) {
          const expected: number = (chunkCount - offset / chunkBytes - 1) % 251;
          if (result.bytes[offset] !== expected || result.bytes[offset + chunkBytes - 1] !== expected) throw new Error("Bounded response changed chunk order or content.");
        }
        checksum += result.bytes.byteLength + (result.bytes[0] ?? 0);
      }
      return checksum;
    },
    probes: { readBoundedResponseBytes },
  };
}
