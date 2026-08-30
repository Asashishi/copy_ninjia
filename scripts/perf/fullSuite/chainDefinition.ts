import type { ChainName } from "./types";

/** 一条链路的定义；run 必须在本次动作的完成点之后才返回。 */
export interface ChainDefinition {
  readonly chain: ChainName;
  readonly operations: number;
  readonly recordsPerOperation: number;
  readonly warmupOperations?: number;
  readonly prepare?: () => void | Promise<void>;
  readonly run: (sequence: number) => Promise<void>;
  readonly excludedNanoseconds?: () => number;
  readonly verify?: () => void | Promise<void>;
}
