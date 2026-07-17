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
        onError(error);
      });
    },
  };
}
