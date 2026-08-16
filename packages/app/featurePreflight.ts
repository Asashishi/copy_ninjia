/**
 * 应用启动阶段的部署输入校验出口。
 *
 * 这里只复用配置模块对已存在部署输入的严格校验；SQLite `chat_states` 只在持久化
 * 恢复边界解码，不再按其中的功能开关执行 JSON 状态时代的启动前提核对。
 */

export { validateExistingDeploymentInputs } from "../config/readiness";
