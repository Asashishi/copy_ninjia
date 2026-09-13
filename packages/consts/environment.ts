/** 可选的 state/lock/logs/memory 数据根目录环境变量名。 */
export const RUNTIME_DATA_ROOT_ENV: string = "COPY_NINJIA_DATA_ROOT";

/** 可选的部署配置目录环境变量名；未设置时使用项目根目录下的 config/。 */
export const CONFIG_ROOT_ENV: string = "COPY_NINJIA_CONFIG_ROOT";

/** 性能子进程启用 JSC GC 暂停日志的环境变量名。 */
export const JSC_GC_LOG_ENV: string = "BUN_JSC_logGC";
