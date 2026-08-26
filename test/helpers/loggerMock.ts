/**
 * `infra/logger` 门面的完整桩面。
 *
 * 测试统一从这里取得四个日志级别，避免不完整替身在命中新增日志调用时抛出
 * 与被测语义无关的 TypeError；桩面随 `Logger` 接口一起维护。
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
