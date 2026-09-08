import { BOUNDED_RESPONSE_CHUNK_THRESHOLD, BOUNDED_RESPONSE_COALESCE_BYTES } from "../consts/streams";

/** 全模块共用一个非 fatal 解码器；口径同 libs/atomicFile.ts 的 UTF8_ENCODER，
 *  不为每次解码新建一个（宽松解码，非法字节仍替换成 U+FFFD，与逐次新建同解）。 */
const UTF8_DECODER: TextDecoder = new TextDecoder();

/** 有界响应读取结果；失败时返回实际观察到的大小，不保留部分响应体。 */
export type BoundedResponseResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large"; readonly observedBytes: number };

type ByteStreamReadResult =
  | { readonly done: true; readonly value: Uint8Array<ArrayBufferLike> | undefined }
  | { readonly done: false; readonly value: Uint8Array<ArrayBufferLike> };

interface ByteStreamReader {
  cancel(reason?: unknown): Promise<void>;
  read(): Promise<ByteStreamReadResult>;
  releaseLock(): void;
}

/**
 * 在读取过程中强制限制响应体大小。Content-Length 只用于提前拒绝，真正的
 * 在接纳每个非空块前累计检查字节上限；跳过空块并按字节预算限制暂存块引用。
 * 细碎输入由原生缓冲聚合，成功结果独占输出字节；输入生产者自身的分配不受本函数控制。
 */
export async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<BoundedResponseResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }

  const declaredLength: string | null = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength: number = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel().catch((): undefined => undefined);
      return { ok: false, reason: "too-large", observedBytes: parsedLength };
    }
  }

  // Bun 的全局 Response.body 当前会退化为 ReadableStream<any>；在这一个
  // Web API 边界收窄为 fetch 响应实际产出的字节块，避免 any 向下游扩散。
  const body: ReadableStream<Uint8Array<ArrayBufferLike>> | null = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return { ok: true, bytes: new Uint8Array() };

  const reader: ByteStreamReader = body.getReader();
  const chunks: Uint8Array[] = [];
  let sink: Bun.ArrayBufferSink | undefined;
  let combined: Uint8Array | undefined;
  let totalBytes: number = 0;
  try {
    while (true) {
      const readResult: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (readResult.done) break;
      const value: Uint8Array<ArrayBufferLike> = readResult.value;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch((): undefined => undefined);
        return { ok: false, reason: "too-large", observedBytes: totalBytes };
      }
      // 块引用数由阈值与已读字节预算共同约束；细碎流转交原生缓冲。
      if (value.byteLength === 0) continue;
      if (sink !== undefined) {
        sink.write(value);
      } else if (
        chunks.length < BOUNDED_RESPONSE_CHUNK_THRESHOLD ||
        totalBytes >= chunks.length * BOUNDED_RESPONSE_COALESCE_BYTES
      ) {
        chunks.push(value);
      } else {
        sink = new Bun.ArrayBufferSink();
        sink.start({ asUint8Array: true, highWaterMark: Math.min(maxBytes, Math.max(totalBytes, BOUNDED_RESPONSE_COALESCE_BYTES)) });
        for (const chunk of chunks) sink.write(chunk);
        chunks.length = 0;
        sink.write(value);
      }
    }
  } finally {
    reader.releaseLock();
    if (sink !== undefined) combined = sink.end() as Uint8Array;
  }

  const bytes: Uint8Array = combined ?? Bun.concatArrayBuffers(chunks, totalBytes, true);
  return { ok: true, bytes };
}

/** 按 UTF-8 解码有界响应；超过上限时返回 null。 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  const result: BoundedResponseResult = await readBoundedResponseBytes(response, maxBytes);
  return result.ok ? UTF8_DECODER.decode(result.bytes) : null;
}
