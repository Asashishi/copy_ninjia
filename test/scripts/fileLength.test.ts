import { expect, test } from "bun:test";
import { MAX_SOURCE_LINES, collectFileLengthProblems } from "../../scripts/conventions/fileLength";

test.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "sh"])(
  "%s 文件超过硬上限行数必须拆分",
  (extension: string): void => {
    const path: string = `scripts/source.${extension}`;
    expect(collectFileLengthProblems(path, "line\n".repeat(MAX_SOURCE_LINES))).toEqual([]);
    expect(collectFileLengthProblems(path, "line\r\n".repeat(MAX_SOURCE_LINES - 1) + "tail")).toEqual([]);
    expect(collectFileLengthProblems(path, "line\n".repeat(MAX_SOURCE_LINES) + "tail")).toEqual([
      `${path} has ${MAX_SOURCE_LINES + 1} lines; split source files exceeding ${MAX_SOURCE_LINES} lines`,
    ]);
  }
);

test("空源码与非源码文档不触发长度硬门禁", (): void => {
  expect(collectFileLengthProblems("empty.ts", "")).toEqual([]);
  expect(collectFileLengthProblems("guide.md", "line\n".repeat(MAX_SOURCE_LINES + 1))).toEqual([]);
});
