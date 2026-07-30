import { mediaTaskRunner } from "../../cache/workers/aiChat/mediaTasks";

export function runMediaTask<T>(task: () => Promise<T>): Promise<T | undefined> {
  return mediaTaskRunner.run(task);
}
