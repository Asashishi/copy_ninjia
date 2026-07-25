import type {
  ReadableStreamDefaultReader as WebReadableStreamDefaultReader,
  ReadableStreamReadResult as WebReadableStreamReadResult,
} from "node:stream/web";

/** 有界响应读取结果；失败时返回实际观察到的大小，不保留部分响应体。 */
export type BoundedResponseResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large"; readonly observedBytes: number };

/**
 * 在读取过程中强制限制响应体大小。Content-Length 只用于提前拒绝，真正的
 * 上限由流式累计保证，因此缺失或伪造响应头也不能触发无界内存分配。
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

  const reader: WebReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes: number = 0;
  try {
    while (true) {
      const { done, value }: WebReadableStreamReadResult<Uint8Array<ArrayBufferLike>> = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch((): undefined => undefined);
        return { ok: false, reason: "too-large", observedBytes: totalBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes: Uint8Array = new Uint8Array(totalBytes);
  let offset: number = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** 按 UTF-8 解码有界响应；超过上限时返回 null。 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  const result: BoundedResponseResult = await readBoundedResponseBytes(response, maxBytes);
  return result.ok ? new TextDecoder().decode(result.bytes) : null;
}
