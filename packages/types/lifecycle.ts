import type { lifecycleDependencies } from "../app/lifecycleDependencies";

/** 生命周期排空阶段的统一结果。 */
export type FlushResult = "flushed" | "timedOut" | "failed";

/** 正常或异常停机时各持久化 owner 的完整时间预算。 */
export interface FlushTimeouts {
  aiMemoryMs: number;
  diskIOMs: number;
  stateMs: number;
  maintenanceMs: number;
}

/** 应用生命周期的完整副作用依赖；测试通过构造器注入替身。 */
export type ApplicationLifecycleDependencies = typeof lifecycleDependencies;
