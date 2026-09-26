import { expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";

/** 文案叶子的种类；数组只比较种类，不比较长度（两套文案的候选池可以不同大小）。 */
type LeafKind = "string" | "function" | "array" | "object" | "other";

function kindOf(value: unknown): LeafKind {
  if (typeof value === "string") return "string";
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

/** 按形参个数调用文案函数：先传字符串实参；产出里出现 undefined 时改传按字段名回显的选项对象。 */
function render(fn: (...args: unknown[]) => unknown): unknown {
  const strings: string[] = Array.from({ length: fn.length }, (_: unknown, index: number): string => `参数${index}`);
  const output: unknown = fn(...strings);
  if (typeof output !== "string" || !output.includes("undefined")) return output;
  const options: object = new Proxy({}, {
    get: (_target: object, key: string | symbol): string | undefined => typeof key === "string" ? `〈${key}〉` : undefined,
  });
  return fn(...strings.map((): object => options));
}

/** assertParity 的入参：同一路径上两套文案的值，以及已渲染函数路径的收集表。 */
interface ParityNode {
  readonly plain: unknown;
  readonly teasing: unknown;
  readonly path: string;
  readonly rendered: string[];
}

/**
 * 并行遍历两套文案：每一层键集相同、同名叶子种类相同、函数形参个数相同；两边每个函数
 * 按形参调用后都产出非空字符串，且不含 undefined、NaN 或 [object Object]。
 */
function assertParity({ plain, teasing, path, rendered }: ParityNode): void {
  expect(`${path}: ${kindOf(plain)}`).toBe(`${path}: ${kindOf(teasing)}`);
  if (typeof plain === "function" && typeof teasing === "function") {
    expect(`${path}: ${plain.length}`).toBe(`${path}: ${teasing.length}`);
    for (const fn of [plain, teasing]) {
      const output: unknown = render(fn as (...args: unknown[]) => unknown);
      expect(`${path}: ${typeof output}`).toBe(`${path}: string`);
      const text: string = output as string;
      expect(text.length).toBeGreaterThan(0);
      expect(`${path}: ${text}`).not.toMatch(/undefined|NaN|\[object Object\]/);
    }
    rendered.push(path);
    return;
  }
  if (kindOf(plain) !== "object") return;
  const plainRecord: Record<string, unknown> = plain as Record<string, unknown>;
  const teasingRecord: Record<string, unknown> = teasing as Record<string, unknown>;
  expect(`${path}: ${Object.keys(plainRecord).sort().join(",")}`)
    .toBe(`${path}: ${Object.keys(teasingRecord).sort().join(",")}`);
  for (const key of Object.keys(plainRecord)) {
    assertParity({ plain: plainRecord[key], teasing: teasingRecord[key], path: `${path}.${key}`, rendered });
  }
}

test("两套氛围文案逐层键集、叶子种类与函数形参一致，每个文案函数都能渲染出完整文本", () => {
  const rendered: string[] = [];
  assertParity({ plain: ATMOSPHERE_TEXTS.plain, teasing: ATMOSPHERE_TEXTS.teasing, path: "$", rendered });
  // 遍历确实走到了文案函数，而不是在顶层就提前结束。
  expect(rendered.length).toBeGreaterThan(100);
});
