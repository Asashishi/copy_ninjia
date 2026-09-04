import { relative } from "node:path";
import ts from "typescript";

/**
 * Worker isolate 内 timer 的 `unref()` 门禁。
 *
 * 三个 Worker 的 timer 都由 owner 缓存或状态条目持有、并在失败后重新武装自己，
 * 必须 `unref()`：isolate 的存活由主线程那条 message port 提供，与 timer 的 ref
 * 状态无关；有序停机由各自的 drain/flush 提前兑现，随后由主线程 terminate。
 * timer 不该单独扣住 isolate 的事件循环（约束见 docs/cn/04-invariants.md）。
 *
 * 判定按**句柄逐个**核对，而不是「函数体内出现过 unref 就算数」：
 * `startVerificationTimer` 装两个 timer、`runLockdownEffects` 装三个，后一种口径
 * 下漏掉其中一个的 unref 会被同函数里另一个的 unref 掩盖。
 *
 * 具体口径：取每次 `setTimeout`/`setInterval` 的赋值目标文本（`const t = …`、
 * `entry.timer = …`、`holder.current = …`），要求在同一函数体内、该调用之后、
 * 且早于下一次写同一目标的 timer 调用之前，出现一次 `<同一目标>.unref()`。
 * 句柄没有落到任何目标上（例如直接 `return setTimeout(...)`）同样拒绝——那种
 * 写法根本没有可以 unref 的引用。
 *
 * 范围只到 `packages/workers/`：主线程另有一批**有意**不 unref 的 timer（由
 * `finally` 清理的短命 promise race、停机硬截止），它们没有「liveness 由 message
 * port 提供」这个前提，不适用本规则。
 */

/** 一次 timer 安装：句柄落点与它所在的函数体范围。 */
interface TimerInstall {
  readonly line: number;
  readonly kind: string;
  /** 句柄落点的源码文本；`null` 表示句柄没有被任何目标接住。 */
  readonly target: string | null;
  readonly scopeFrom: number;
  readonly scopeTo: number;
}

/** 一次 `<目标>.unref()` 调用。 */
interface UnrefCall {
  readonly line: number;
  readonly target: string;
}

/** 取 timer 调用的赋值目标文本；没有可 unref 的落点时返回 null。 */
function installTarget(call: ts.CallExpression, source: ts.SourceFile): string | null {
  const parent: ts.Node = call.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === call &&
    (ts.isIdentifier(parent.left) || ts.isPropertyAccessExpression(parent.left))
  ) {
    return parent.left.getText(source);
  }
  return null;
}

/** 找到包住节点的最近函数体范围（行号闭区间）。 */
function enclosingScope(node: ts.Node, source: ts.SourceFile): { from: number; to: number } {
  let scope: ts.Node = node;
  while (
    scope.parent !== undefined &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope)
  ) scope = scope.parent;
  return {
    from: source.getLineAndCharacterOfPosition(scope.getStart()).line + 1,
    to: source.getLineAndCharacterOfPosition(scope.getEnd()).line + 1,
  };
}

export function collectWorkerTimerProblems(
  projectRoot: string,
  path: string,
  source: ts.SourceFile
): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const installs: TimerInstall[] = [];
  const unrefs: UnrefCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === "unref") {
        unrefs.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          target: node.expression.expression.getText(source),
        });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "setTimeout" || node.expression.text === "setInterval")
    ) {
      const scope: { from: number; to: number } = enclosingScope(node, source);
      installs.push({
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        kind: node.expression.text,
        target: installTarget(node, source),
        scopeFrom: scope.from,
        scopeTo: scope.to,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const install of installs) {
    const location: string = `${relativePath}:${install.line}`;
    if (install.target === null) {
      problems.push(
        `${location} installs a worker ${install.kind} without keeping the handle: ` +
        "assign it before returning so it can be unref()ed"
      );
      continue;
    }
    // 同一目标被下一次 timer 调用覆盖之前，必须先 unref 掉本次这一个。
    let boundary: number = install.scopeTo;
    for (const other of installs) {
      if (
        other !== install &&
        other.target === install.target &&
        other.scopeFrom === install.scopeFrom &&
        other.line > install.line &&
        other.line < boundary
      ) boundary = other.line;
    }
    const unrefed: boolean = unrefs.some(
      (candidate: UnrefCall): boolean =>
        candidate.target === install.target &&
        candidate.line > install.line &&
        candidate.line <= boundary
    );
    if (!unrefed) {
      problems.push(
        `${location} installs a worker ${install.kind} without unref(): ` +
        "worker timers must not hold the isolate event loop open"
      );
    }
  }
  return problems;
}
