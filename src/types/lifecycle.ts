import type { lifecycleDependencies } from "../app/lifecycleDependencies";

/** 应用生命周期的完整副作用依赖；测试通过构造器注入替身。 */
export type ApplicationLifecycleDependencies = typeof lifecycleDependencies;
