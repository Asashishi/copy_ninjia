/** cartesianProduct 的维度表：字段名 -> 该维度依次取的值。 */
export type CartesianDimensions = Readonly<Record<string, readonly unknown[]>>;

/** cartesianProduct 产出的一个组合：每个维度取一个值。 */
export type CartesianCombination<T extends CartesianDimensions> = {
  [K in keyof T]: T[K][number];
};

/**
 * 穷举各维度取值的全部组合，代替按维度逐层嵌套的 for 循环。组合顺序与同顺序的嵌套循环一致：
 * 第一个维度变化最慢，最后一个维度变化最快；每个组合是新对象，字段按维度声明顺序写入。
 * 任一维度为空时没有组合。只用于冷路径的穷举与夹具构造，热路径不得调用。
 * @param dimensions 维度表；类型参数按 const 推断，字面量取值保持字面量类型。
 */
export function cartesianProduct<const T extends CartesianDimensions>(dimensions: T): CartesianCombination<T>[] {
  let combinations: Record<string, unknown>[] = [{}];
  for (const [key, values] of Object.entries(dimensions)) {
    combinations = combinations.flatMap((combination: Record<string, unknown>): Record<string, unknown>[] =>
      values.map((value: unknown): Record<string, unknown> => ({ ...combination, [key]: value }))
    );
  }
  return combinations as CartesianCombination<T>[];
}
