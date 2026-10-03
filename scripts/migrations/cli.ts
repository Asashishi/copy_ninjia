import { invalidInput } from "../../packages/libs/inputValidation";

/** 停机备份根与独立产物目录；冷迁移与停机清理 CLI 都要求两项由命令行明确给出。 */
export interface SourceOutputRoots {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

/**
 * 解析 `--source-root <cold-backup> --output-root <new-directory>`，不默认选取部署路径。
 * 未知选项、重复选项、缺值、空白值或以 `--` 开头的值一律拒绝；值去掉首尾空白。
 */
export function parseSourceOutputRoots(args: readonly string[]): SourceOutputRoots {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-root", "--output-root"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-root <cold-backup> --output-root <new-directory>");
    }
    values.set(key, value.trim());
  }
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) return invalidInput("arguments", "$", "both required path options");
  return { sourceRoot, outputRoot };
}
