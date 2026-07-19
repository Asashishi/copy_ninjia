/** test/libs 下多个测试文件共用的小工具（非测试文件，bun test 不会执行它）。 */

/** 手动控制 settle 时机的 Promise，串行/并发调度类测试用。 */
export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 按给定分块流式返回 body 的 Response，流式读取/字节上限类测试用。 */
export function chunkedResponse(chunks: readonly Uint8Array[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}
