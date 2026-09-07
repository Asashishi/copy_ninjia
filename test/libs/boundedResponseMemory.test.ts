import { heapStats } from "bun:jsc";
import { expect, test } from "bun:test";
import { readBoundedResponseBytes } from "../../packages/libs/boundedResponse";

test.each([0, 1])("EOF 前的留存不随 %s 字节碎片数量线性增长", async (chunkBytes: number): Promise<void> => {
  const count: number = 131_072;
  let remaining: number = count;
  let retainedObjects: number = 0;
  let retainedHeap: number = 0;
  Bun.gc(true);
  const before: ReturnType<typeof heapStats> = heapStats();
  const response: Response = new Response(new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      if (remaining-- > 0) {
        controller.enqueue(new Uint8Array(chunkBytes).fill(1));
        return;
      }
      // 在读取器仍持有待拼接数据时检查，避免只测 EOF 后已经释放的对象。
      Bun.gc(true);
      const held: ReturnType<typeof heapStats> = heapStats();
      retainedObjects = held.objectCount - before.objectCount;
      retainedHeap = held.heapSize - before.heapSize;
      controller.close();
    },
  }));
  const result: Awaited<ReturnType<typeof readBoundedResponseBytes>> = await readBoundedResponseBytes(response, count * chunkBytes);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.bytes.byteLength).toBe(count * chunkBytes);
    if (chunkBytes > 0) expect(result.bytes.every((byte: number): boolean => byte === 1)).toBe(true);
  }
  expect(retainedObjects).toBeLessThan(4_096);
  expect(retainedHeap).toBeLessThan(2 * 1_024 * 1_024);
  expect(response.body?.locked).toBe(false);
});
