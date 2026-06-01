import type {
  Command,
  Node,
  Redirect,
  Script,
  Statement,
  Word,
  WordPart,
} from "../deps.ts";
import type { CommandInvocation, CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { applyCd, gitEffectiveCwd, isCd } from "./cwd.ts";

/** 走訪 Script，回傳所有葉指令呼叫。 */
export function walk(script: Script, startCwd: CwdState, _root: string): CommandInvocation[] {
  const out: CommandInvocation[] = [];
  walkSequence(script.commands, startCwd, out, [], true);
  return out;
}

/** 依序處理頂層 / 複合語句序列，回傳序列結束後的 threaded cwd。 */
function walkSequence(
  statements: Statement[],
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
  persistent: boolean,
): CwdState {
  let cur = cwd;
  for (const stmt of statements) {
    cur = walkNode(stmt.command, cur, out, [...inherited, ...stmt.redirects], persistent);
  }
  return cur;
}

/**
 * 處理單一節點，列舉葉指令到 out，回傳處理後的 threaded cwd。
 * persistent=true 表示此節點在當前 shell 執行（cd 會持久）。
 */
function walkNode(
  node: Node,
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
  persistent: boolean,
): CwdState {
  switch (node.type) {
    case "Command": {
      emitCommand(node, cwd, out, inherited);
      if (persistent && isCd(node)) return applyCd(node, cwd);
      return cwd;
    }
    case "AndOr": {
      // && / || 在當前 shell 依序執行 → cd 在成員間傳遞
      let cur = cwd;
      for (const m of node.commands) cur = walkNode(m, cur, out, inherited, persistent);
      return cur;
    }
    case "Pipeline": {
      // 各段在 subshell 執行 → cd 不持久；皆以同一 cwd 列舉
      for (const m of node.commands) walkNode(m, cwd, out, inherited, false);
      return cwd;
    }
    case "Subshell": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return cwd; // 內部 cd 不外洩
    }
    case "BraceGroup": {
      // { …; } 在當前 shell 執行 → cd 持久
      return walkSequence(node.body.commands, cwd, out, inherited, persistent);
    }
    case "If": {
      walkSequence(node.clause.commands, cwd, out, inherited, false);
      walkSequence(node.then.commands, cwd, out, inherited, false);
      if (node.else) {
        if (node.else.type === "If") walkNode(node.else, cwd, out, inherited, false);
        else walkSequence(node.else.commands, cwd, out, inherited, false);
      }
      return afterControlFlow(node, cwd, persistent);
    }
    case "For":
    case "Select": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "While": {
      walkSequence(node.clause.commands, cwd, out, inherited, false);
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "ArithmeticFor": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "Case": {
      for (const item of node.items) {
        walkSequence(item.body.commands, cwd, out, inherited, false);
      }
      return afterControlFlow(node, cwd, persistent);
    }
    case "CompoundList": {
      return walkSequence(node.commands, cwd, out, inherited, persistent);
    }
    case "Statement": {
      return walkNode(
        node.command,
        cwd,
        out,
        [...inherited, ...node.redirects],
        persistent,
      );
    }
    // Function 定義本體當下不執行；TestCommand / ArithmeticCommand 無外部指令。
    case "Function":
    case "TestCommand":
    case "ArithmeticCommand":
    case "Coproc":
    default:
      return cwd;
  }
}

/** 控制流之後：若內部含 cd，threaded cwd 保守標 unknown。 */
function afterControlFlow(node: Node, cwd: CwdState, persistent: boolean): CwdState {
  if (persistent && containsCd(node)) return { kind: "unknown" };
  return cwd;
}

/** 建立一筆葉指令呼叫，並列舉其參數內的 command substitution 內層指令。 */
function emitCommand(
  cmd: Command,
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
): void {
  const name = cmd.name ? staticValue(cmd.name) : null;
  const execCwd = name === "git" ? gitEffectiveCwd(cmd, cwd) : cwd;

  out.push({
    name,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: [...inherited, ...cmd.redirects],
    cwd: execCwd,
  });

  // command substitution / process substitution 內層指令（非持久、用當前 cwd 副本）
  const words: Word[] = [
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.suffix,
    ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
    ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
  ];
  for (const w of words) enumerateInnerScripts(w, cwd, out);
}

/** 掃描 Word 內的 CommandExpansion / ProcessSubstitution，列舉其內層 Script。 */
function enumerateInnerScripts(word: Word, cwd: CwdState, out: CommandInvocation[]): void {
  if (!word.parts) return;
  for (const part of word.parts) walkPart(part, cwd, out);
}

function walkPart(part: WordPart, cwd: CwdState, out: CommandInvocation[]): void {
  if (
    (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") &&
    part.script
  ) {
    walkSequence(part.script.commands, cwd, out, [], false);
  } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) walkPart(child, cwd, out);
  }
}

/** 子樹是否含有 `cd` 指令（決定控制流後是否標 unknown）。 */
function containsCd(node: Node): boolean {
  switch (node.type) {
    case "Command":
      return isCd(node);
    case "AndOr":
    case "Pipeline":
      return node.commands.some(containsCd);
    case "Subshell":
    case "BraceGroup":
    case "CompoundList":
      return seqContainsCd(node.type === "CompoundList" ? node.commands : node.body.commands);
    case "If":
      return (
        seqContainsCd(node.clause.commands) ||
        seqContainsCd(node.then.commands) ||
        (node.else
          ? node.else.type === "If"
            ? containsCd(node.else)
            : seqContainsCd(node.else.commands)
          : false)
      );
    case "For":
    case "Select":
    case "ArithmeticFor":
      return seqContainsCd(node.body.commands);
    case "While":
      return seqContainsCd(node.clause.commands) || seqContainsCd(node.body.commands);
    case "Case":
      return node.items.some((it) => seqContainsCd(it.body.commands));
    case "Statement":
      return containsCd(node.command);
    default:
      return false;
  }
}

function seqContainsCd(statements: Statement[]): boolean {
  return statements.some((s) => containsCd(s.command));
}
