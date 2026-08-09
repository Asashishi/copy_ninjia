import { readFileSync } from "node:fs";

/**
 * 不可信部署输入的安全错误。消息只包含来源、字段路径和期望形态，禁止携带
 * 实际值或底层异常，避免配置与状态内容经日志外泄。
 */
export class InputValidationError extends Error {
  constructor(sourcePath: string, fieldPath: string, expected: string) {
    super(`${sourcePath}: ${fieldPath} must be ${expected}.`);
    this.name = "InputValidationError";
  }
}

/** 抛出统一的安全输入错误；返回 never 便于解码分支直接收窄类型。 */
export function invalidInput(
  sourcePath: string,
  fieldPath: string,
  expected: string
): never {
  throw new InputValidationError(sourcePath, fieldPath, expected);
}

/**
 * 读取并解析一份 JSON 部署输入。读取失败与语法错误都收敛为安全诊断，不把
 * 操作系统路径细节、原始 JSON 片段或解析异常回显到日志。
 */
export function readJsonInput(sourcePath: string): unknown {
  try {
    return JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
  } catch {
    return invalidInput(sourcePath, "$", "a readable valid JSON document");
  }
}

/** 解析已经读入的 JSON 状态文本；语法错误不得携带原文片段逸出。 */
export function parseJsonInput(content: string, sourcePath: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return invalidInput(sourcePath, "$", "valid JSON");
  }
}
