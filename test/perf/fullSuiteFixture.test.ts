import { expect, test } from "bun:test";
import { buildAiMemorySnapshot } from "../../scripts/perf/fullSuite/fixture";
import {
  COLD_START_AI_MEMORY_CHATS,
  COLD_START_AI_MEMORY_MESSAGES,
  COLD_START_AI_MEMORY_SUMMARIES,
} from "../../scripts/perf/fullSuite/constants";
import { parseAiMemorySnapshot } from "../../packages/libs/persistedSnapshotCodec";
import type { AiMemorySnapshot } from "../../packages/types/aiChat/memory";

test("全量基准的满容量 AI 夹具通过生产恢复解码", (): void => {
  for (let index: number = 0; index < COLD_START_AI_MEMORY_CHATS; index++) {
    const snapshot: AiMemorySnapshot = parseAiMemorySnapshot(
      buildAiMemorySnapshot(index),
      `performance fixture:memory/ai/${index}.json`
    );
    expect(snapshot.buffer).toHaveLength(COLD_START_AI_MEMORY_MESSAGES);
    expect(snapshot.summaries).toHaveLength(COLD_START_AI_MEMORY_SUMMARIES);
    expect(snapshot.buffer[0]?.at).toBe("2026/01/01 09:00:00");
  }
});
