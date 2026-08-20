import { describe, expect, test } from "bun:test";
import { jsonSerializedBytes } from "../../packages/libs/jsonBytes";

/**
 * 跨线程诊断载荷的容量单位。
 *
 * 关键契约是**异常输入不得让容量检查自己抛出**：这个函数的调用点是有界队列的
 * 入队判定（见 infra/logger.ts 的 forwardWorkerLog），在那里抛出等于让一条畸形
 * 日志把整条转发通道打死。约定是返回 MAX_SAFE_INTEGER，让队列拒收这一条。
 */
describe("jsonSerializedBytes", () => {
  test("常规值按 UTF-8 字节数计量", () => {
    expect(jsonSerializedBytes("ab")).toBe(Buffer.byteLength(JSON.stringify("ab")));
    expect(jsonSerializedBytes({ a: 1 })).toBe(Buffer.byteLength('{"a":1}'));
    // 中文按 UTF-8 计三字节，不能按码元数算。
    expect(jsonSerializedBytes("中")).toBe(Buffer.byteLength('"中"'));
  });

  test("永远不返回 0：空串也占一个字节的容量额度", () => {
    expect(jsonSerializedBytes("")).toBeGreaterThanOrEqual(1);
    expect(jsonSerializedBytes({})).toBeGreaterThanOrEqual(1);
  });

  test("JSON.stringify 返回 undefined 的值按拒收计量", () => {
    expect(jsonSerializedBytes(undefined)).toBe(Number.MAX_SAFE_INTEGER);
    expect(jsonSerializedBytes((): void => {})).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("循环引用不抛出，按拒收计量", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jsonSerializedBytes(circular)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("BigInt 与抛错的 toJSON 同样只降级，不把异常抛给调用方", () => {
    expect(jsonSerializedBytes({ big: 1n })).toBe(Number.MAX_SAFE_INTEGER);
    expect(jsonSerializedBytes({
      toJSON: (): never => { throw new Error("hostile toJSON"); },
    })).toBe(Number.MAX_SAFE_INTEGER);
  });
});
