import { join, relative } from "node:path";
import ts from "typescript";
import { sourceFilesUnder } from "./sourceAnalysis";

async function parse(path: string): Promise<ts.SourceFile> {
  return ts.createSourceFile(
    path,
    await Bun.file(path).text(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

/** 核对命令提示清理、状态消息豁免与长期留存话题归属。 */
export async function collectTelegramMessageProblems(
  projectRoot: string,
  sourceRoot: string,
  commandsRoot: string
): Promise<readonly string[]> {
  const problems: string[] = [];
  const commandTextOutputFiles: readonly string[] = [
    ...sourceFilesUnder(commandsRoot),
    join(sourceRoot, "copy", "avatarQueue.ts"),
  ];
  const gagCommandPath: string = join(commandsRoot, "gag.ts");
  const gagNoticesPath: string = join(commandsRoot, "gag", "notices.ts");
  const qaNoticesPath: string = join(commandsRoot, "qa", "notices.ts");

  for (const path of commandTextOutputFiles) {
    const source: ts.SourceFile = await parse(path);
    function visit(node: ts.Node): void {
      if (
        ts.isImportSpecifier(node) &&
        ["sendEphemeralMessage", "sendMessage"].includes(
          node.propertyName?.text ?? node.name.text
        )
      ) {
        if (
          (path === gagCommandPath || path === gagNoticesPath || path === qaNoticesPath) &&
          ["sendEphemeralMessage", "sendMessage"].includes(node.name.text)
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        problems.push(
          `${relative(projectRoot, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          "command text must use sendCommandMessage so group prompts are deleted"
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  for (const path of [gagCommandPath, gagNoticesPath, qaNoticesPath]) {
    const source: ts.SourceFile = await parse(path);
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["sendEphemeralMessage", "sendMessage"].includes(node.expression.text)
      ) {
        let owner: ts.Node | undefined = node.parent;
        while (
          owner !== undefined &&
          !ts.isVariableDeclaration(owner) &&
          !ts.isFunctionLike(owner)
        ) owner = owner.parent;
        const isPublicNoticeAssignment: boolean = path === gagCommandPath &&
          owner !== undefined && ts.isVariableDeclaration(owner) &&
          ts.isIdentifier(owner.name) && owner.name.text === "publicNoticeMessageId";
        const isSpeakNoticeBoundary: boolean = path === gagNoticesPath &&
          owner !== undefined && ts.isFunctionDeclaration(owner) &&
          owner.name?.text === "sendGagSpeakNotice";
        const isQaFormBoundary: boolean = path === qaNoticesPath &&
          owner !== undefined && ts.isFunctionDeclaration(owner) &&
          owner.name?.text === "sendQaForm";
        if (!isPublicNoticeAssignment && !isSpeakNoticeBoundary && !isQaFormBoundary) {
          problems.push(
            `${relative(projectRoot, path)}:` +
            `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
            "only the state-owned gag notices and the /set_qa form boundary may " +
            "bypass sendCommandMessage"
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  for (const path of sourceFilesUnder(commandsRoot)) {
    const source: ts.SourceFile = await parse(path);
    function visit(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        let preservesInGroup: boolean = false;
        let carriesThread: boolean = false;
        for (const property of node.properties) {
          const name: string | undefined = property.name !== undefined &&
            ts.isIdentifier(property.name) ? property.name.text : undefined;
          if (
            name === "preserveInGroup" &&
            ts.isPropertyAssignment(property) &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword
          ) preservesInGroup = true;
          if (name === "messageThreadId") carriesThread = true;
        }
        if (preservesInGroup && !carriesThread) {
          problems.push(
            `${relative(projectRoot, path)}:` +
            `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
            "preserveInGroup content stays in the chat forever and must also pass messageThreadId"
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const fixedDelayDeleteExemptFiles: readonly string[] = [
    ...sourceFilesUnder(join(commandsRoot, "luckChallenge")),
    join(sourceRoot, "workers", "antiRaid", "verificationReminders.ts"),
  ];
  for (const path of fixedDelayDeleteExemptFiles) {
    const source: ts.SourceFile = await parse(path);
    function visit(node: ts.Node): void {
      if (
        ts.isImportSpecifier(node) &&
        (node.propertyName?.text ?? node.name.text) === "sendCommandMessage"
      ) {
        problems.push(
          `${relative(projectRoot, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          "state-owned button messages and inline luck results must not use fixed-delay command cleanup"
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return problems;
}
