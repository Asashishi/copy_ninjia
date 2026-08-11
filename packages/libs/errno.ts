/**
 * 按 Node.js 错误码收窄未知异常；只比较稳定的 code 字段，不依赖平台文案。
 */
export function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
