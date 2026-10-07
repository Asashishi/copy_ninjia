/**
 * 估算已经规范化、可 JSON 落盘值的序列化字节数。
 *
 * logger 的参数在进入队列前已经断开原对象引用并规范化；广告样本也只含声明过的
 * 标量与数组。这份 JSON 字节数作为跨线程诊断载荷的容量单位；无法序列化的值返回
 * MAX_SAFE_INTEGER，有界队列据此拒绝保留，容量检查本身不抛错。
 */
export function jsonSerializedBytes(value: unknown): number {
  try {
    const serialized: string | undefined = JSON.stringify(value);
    if (serialized === undefined) return Number.MAX_SAFE_INTEGER;
    return Math.max(1, Buffer.byteLength(serialized));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
