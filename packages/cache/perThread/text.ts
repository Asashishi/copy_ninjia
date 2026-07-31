/**
 * 文本工具（packages/libs/text.ts）的逐线程惰性状态。
 *
 * libs/text.ts 会被主线程与各 Worker 各自加载；每条线程只缓存自己构造成功的
 * Intl.Segmenter，不跨线程同步。首次按字素切分时填充，测试可显式清空；
 * Worker 崩溃或进程重启后从 null 重建。null 表示本线程尚无可复用实例，
 * 调用方应尝试构造，并在失败时安全退化为按码点切分。容量固定为一个实例。
 */

/** 本线程唯一的字素 Segmenter；构造失败不写入，下一次调用仍可重试。 */
export const graphemeSegmenterHolder: { current: Intl.Segmenter | null } = {
  current: null,
};
