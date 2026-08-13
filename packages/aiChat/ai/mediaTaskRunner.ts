import { mediaTaskRunner } from "../../cache/workers/aiChat/mediaTasks";

export function runMediaTask<T>(
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T | undefined> {
  return mediaTaskRunner.run(task, signal);
}
