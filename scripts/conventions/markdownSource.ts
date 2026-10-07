/** Markdown 链接核对与目录清单核对共用的正文预处理。 */

/**
 * 去掉 fenced code block 的内容，但保留换行与字符下标。
 *
 * 代码块里的示例 `](./foo)` 与示例文件名不参与链接核对和目录清单核对。代码块内容
 * 用等长空格替换，调用方按 `match.index` 反算出的行号与原文对齐。
 */
export function withoutMarkdownCodeFences(source: string): string {
  return source.replace(
    /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (block: string): string => block.replace(/[^\n]/g, " ")
  );
}
