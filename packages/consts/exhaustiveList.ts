/**
 * 联合类型全集表的构造器，由 `packages/consts/` 内的模块在初始化时调用：
 * `exhaustiveList<U>()([...])` 要求数组字面量覆盖 U 的每一个成员，漏掉任何一个时形参类型
 * 退化成 `never`，混入 U 以外的值时违反约束，两者都在调用点编译失败。表的顺序就是字面量的
 * 顺序；重复成员不在检查范围内。运行期原样返回同一个数组。
 *
 * `bun run check:conventions` 要求 consts 里元素为字面量联合的导出数组表都经它构造，
 * 有意只列子集的表登记在 scripts/conventions/constExhaustiveLists.ts。
 */
export function exhaustiveList<U>(): <const T extends readonly U[]>(
  items: T & ([U] extends [T[number]] ? unknown : never)
) => readonly U[] {
  return returnItems;
}

function returnItems<T>(items: T): T {
  return items;
}
