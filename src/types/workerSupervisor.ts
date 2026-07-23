/** 业务 Worker 永久不可用时，由应用生命周期接收的 fatal 回调。 */
export type BusinessWorkerFatalHandler = (error: Error) => void;
