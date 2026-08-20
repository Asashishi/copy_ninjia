/**
 * `infra/logger` 门面的完整桩面。
 *
 * 各测试文件此前按「被测代码当时会调哪几个级别」各写各的桩：有的只给 `error`，
 * 有的给三个。生产侧新增一次 `logger.warn(...)` 之后，补没补全凭偶然，没补的那个
 * 文件里它就是 `undefined`——命中即 TypeError，而错误信息指向的是被测代码，不是
 * 那份漏了一格的桩。桩面收在这里之后只有一份定义，跟着 `Logger` 接口一起改。
 *
 * 只导出工厂、不在本文件登记 `mock.module`：各用例文件到生产模块的相对路径深度
 * 不同，登记必须留在调用方；这里只保证「拿到的那个对象四个级别都在」。
 */

/**
 * 只覆写关心的级别；其余自动补成静默 no-op。
 *
 * 四项写成**方法简写**而不是属性上的函数类型：方法位置在 TS 里是双变的，
 * 用例里常见的窄签名替身（如 `mock((message: string) => void)`）才能直接传进来，
 * 不必为了迁移到这个工厂而把每个替身的形参改成 `unknown[]`。
 */
export interface LoggerStubOverrides {
  log?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** 与 infra/logger.ts 的 Logger 结构一致的完整桩。 */
export function loggerStub(overrides: LoggerStubOverrides = {}): Required<LoggerStubOverrides> {
  return {
    log: overrides.log ?? ((): void => {}),
    info: overrides.info ?? ((): void => {}),
    warn: overrides.warn ?? ((): void => {}),
    error: overrides.error ?? ((): void => {}),
  };
}
