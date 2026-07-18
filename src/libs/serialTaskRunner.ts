/**
 * 按提交顺序逐个执行后台异步任务。单个任务失败会交给 onError，并在兜底后
 * 继续下一个任务，不会把整条队列永久打断。
 */
export interface SerialTaskRunner {
  run(task: () => Promise<void>): void;
}

export function createSerialTaskRunner(onError: (error: unknown) => void): SerialTaskRunner {
  let tail: Promise<void> = Promise.resolve();
  return {
    run(task: () => Promise<void>): void {
      tail = tail.then(task).catch((error: unknown): void => {
        try {
          onError(error);
        } catch (onErrorFailure: unknown) {
          // onError 本身若也抛错，不能任由它让这次 .catch 的返回值变成
          // rejected：那样 tail 会带着 rejected 状态传给下一个 run()，
          // 而 `.then(task)` 在输入已 rejected 时会直接透传拒绝、根本不
          // 执行 task——下一个任务被静默跳过，且尾随的 .catch 会拿着
          // "onError 抛出的错"（而非任务本身的错）再调一次 onError，
          // 上下文完全错位。这里兜底吞掉，保证 tail 始终以 resolved 收尾。
          console.error("[serialTaskRunner] onError itself threw, swallowing to keep the queue alive:", onErrorFailure);
        }
      });
    },
  };
}
