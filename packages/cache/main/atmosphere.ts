/** owner: main。 */

import type { Atmosphere } from "../../types/atmosphere";
/**
 * 本进程生效的群通知风格，容量一个枚举。主线程启动总闸（config/readiness.ts 的
 * ensurePromptFiles）与人设快照一起填充一次，优先使用 config/static/bot.json 的显式
 * atmosphere；风格缺省时按是否部署自定义人设选择，规则见 docs/cn/04-invariants.md。
 * 不热重载，不淘汰，进程重启后重建。
 * 两条业务 Worker 经初始化载荷取得同一值，崩溃重建时由主线程重放。未填充时为 null，
 * 读取方（infra/atmosphere.ts）拒绝使用，不回退到任何缺省风格。
 */
export const botAtmosphereState: { current: Atmosphere | null } = { current: null };
