import { expect, test } from "bun:test";
import { serializeLogArgs } from "../../packages/infra/logger/serialization";
import {
  LOGGER_MAX_ERROR_NODES,
  LOGGER_MAX_SERIALIZED_BYTES,
  LOGGER_MAX_SERIALIZED_ITEMS,
  LOGGER_SERIALIZATION_LIMIT_VALUE,
} from "../../packages/consts/logger";

test("多个参数与重复引用的 AggregateError 共用展开预算", () => {
  let error: Error = new Error("leaf");
  error.stack = "leaf";
  for (let depth: number = 0; depth < 5; depth++) {
    error = new AggregateError(Array<Error>(6).fill(error), "nested");
    error.stack = "nested";
  }
  const text: string = JSON.stringify(serializeLogArgs([error, error]));
  expect([...text.matchAll(/"name":/g)].length).toBeLessThanOrEqual(LOGGER_MAX_ERROR_NODES);
  expect(text).toContain(LOGGER_SERIALIZATION_LIMIT_VALUE);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_BYTES);
});

test("宽数组与大量参数只读取预算内的条目", () => {
  const elements: unknown[] = new Array<unknown>(LOGGER_MAX_SERIALIZED_ITEMS * 100);
  Object.defineProperty(elements, LOGGER_MAX_SERIALIZED_ITEMS + 1, {
    get: (): never => { throw new Error("must not read past budget"); },
  });
  const error: AggregateError = new AggregateError([], "wide");
  Object.defineProperty(error, "errors", { value: elements });
  const [serialized] = serializeLogArgs([error]) as { errors: unknown[] }[];
  expect(serialized!.errors.length).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_ITEMS + 1);
  expect(serialized!.errors.at(-1)).toBe(LOGGER_SERIALIZATION_LIMIT_VALUE);
  const args: unknown[] = serializeLogArgs(Array<string>(1_000).fill("argument"));
  expect(args).toHaveLength(LOGGER_MAX_SERIALIZED_ITEMS + 1);
  expect(args.at(-1)).toBe(LOGGER_SERIALIZATION_LIMIT_VALUE);
});

test("输出预算覆盖多字节文本、JSON 转义与多个参数，截断使用静态标记", () => {
  const values: readonly unknown[][] = [
    ["保留", "\u0000".repeat(LOGGER_MAX_SERIALIZED_BYTES)],
    [new Error("界".repeat(LOGGER_MAX_SERIALIZED_BYTES))],
    Array<string>(256).fill("界".repeat(1_000)),
  ];
  for (const args of values) {
    const result: unknown[] = serializeLogArgs(args);
    expect(result).toContain(LOGGER_SERIALIZATION_LIMIT_VALUE);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_BYTES);
  }
});
