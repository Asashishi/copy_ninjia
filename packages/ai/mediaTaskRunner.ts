import { mediaTaskRunner } from "../cache/aiChat/mediaTasks";

export function runMediaTask<T>(task: () => Promise<T>): Promise<T | undefined> {
  return mediaTaskRunner.run(task);
}
