import { join } from "node:path";
import ts from "typescript";

/** packages/consts/ 里一条以标识符命名的导出常量声明。 */
export interface ExportedConstDeclaration {
  readonly path: string;
  readonly name: string;
  readonly declaration: ts.VariableDeclaration;
}

/**
 * 按仓库 tsconfig 为 packages/consts/ 建一个只做类型检查的 program；常量不可变性断言与
 * 字面量联合全集表两道门禁共用同一个 program 与同一份 exportedConstDeclarations 结果。
 */
export function createConstsProgram(projectRoot: string, constFiles: readonly string[]): ts.Program {
  const config: { config?: unknown } = ts.readConfigFile(
    join(projectRoot, "tsconfig.json"),
    (path: string): string | undefined => ts.sys.readFile(path)
  );
  const options: ts.CompilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot).options;
  return ts.createProgram({ rootNames: [...constFiles], options: { ...options, noEmit: true } });
}

/** 按文件与声明顺序列出 constFiles 里顶层带 export 的变量声明。 */
export function exportedConstDeclarations(
  program: ts.Program,
  constFiles: readonly string[]
): ExportedConstDeclaration[] {
  const declarations: ExportedConstDeclaration[] = [];
  for (const path of constFiles) {
    const sourceFile: ts.SourceFile | undefined = program.getSourceFile(path);
    if (sourceFile === undefined) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (statement.modifiers?.some((modifier: ts.ModifierLike): boolean => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.push({ path, name: declaration.name.text, declaration });
      }
    }
  }
  return declarations;
}
