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
    // 此 statement 自身掛載的 redirects（如 compound 的 heredoc）在此引入 inherited：
    // 其 target/body 內的命令替換在此以當前 cwd 列舉一次（heredoc 於語句執行前展開一次）。
    for (const r of stmt.redirects) enumerateRedirectScripts(r, cur, out);
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
      // 此 Statement 自身掛載的 redirects（如 pipeline/AndOr 成員上的 compound heredoc）
      // 在此引入 inherited：其 target/body 內的命令替換在此以當前 cwd 列舉一次。
      // （函式定義的 redirect 由 unbash 掛在 Function.redirects、非此處，故自然延後到呼叫時。）
      for (const r of node.redirects) enumerateRedirectScripts(r, cwd, out);
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

  // command substitution / process substitution 內層指令（非持久、用當前 cwd 副本）。
  // 只列舉「自身」redirect 的替換；繼承（compound 掛載）的 redirect 由 walkSequence 在引入點
  // 列舉一次，避免每個葉指令重複列舉、且避免套用葉指令內部 cd 後的錯誤 cwd。
  const words: Word[] = [
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.suffix,
    ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
    ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
    ...cmd.redirects.flatMap((r) => (r.body ? [r.body] : [])), // 自身 heredoc body 內的替換
  ];
  for (const w of words) enumerateInnerScripts(w, cwd, out);
}

/** 列舉單一 redirect 的 target / body 內的命令替換內層指令（以指定 cwd、非持久）。 */
function enumerateRedirectScripts(r: Redirect, cwd: CwdState, out: CommandInvocation[]): void {
  if (r.target) enumerateInnerScripts(r.target, cwd, out);
  if (r.body) enumerateInnerScripts(r.body, cwd, out);
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

/** 遞迴掃描 AST 收集所有函式定義名（靜態名；動態名忽略），含命令替換內層腳本。供 evaluate 閘③偵測函式遮蔽。 */
export function definedFunctionNames(script: Script): Set<string> {
  const out = new Set<string>();
  for (const s of script.commands) {
    // 掃 Statement 層的 redirect（如 `{ cat; } <<EOF $(f(){:;};f) EOF` 的繼承 heredoc）
    for (const r of s.redirects) {
      if (r.target) collectFnsInWord(r.target, out);
      if (r.body) collectFnsInWord(r.body, out);
    }
    collectFns(s.command, out);
  }
  return out;
}

function collectFns(node: Node, out: Set<string>): void {
  switch (node.type) {
    case "Function": {
      const n = staticValue(node.name);
      if (n !== null) out.add(n);
      collectFns(node.body, out); // 巢狀定義
      return;
    }
    case "Command": {
      // 函式可定義於命令替換內（如 echo "$(f(){ … }; f)"）；walk 會列舉其內層呼叫，
      // 故此處亦須掃 Word 內的 $( … ) / <( … ) 腳本，收集其中的函式定義名。
      const words: Word[] = [
        ...(node.name ? [node.name] : []),
        ...node.suffix,
        ...node.prefix.flatMap((a) => (a.value ? [a.value] : [])),
        ...node.redirects.flatMap((r) => (r.target ? [r.target] : [])),
        ...node.redirects.flatMap((r) => (r.body ? [r.body] : [])),
      ];
      for (const w of words) collectFnsInWord(w, out);
      return;
    }
    case "AndOr":
    case "Pipeline":
      for (const m of node.commands) collectFns(m, out);
      return;
    case "Subshell":
    case "BraceGroup":
      collectFnsSeq(node.body.commands, out);
      return;
    case "CompoundList":
      collectFnsSeq(node.commands, out);
      return;
    case "If":
      collectFnsSeq(node.clause.commands, out);
      collectFnsSeq(node.then.commands, out);
      if (node.else) {
        if (node.else.type === "If") collectFns(node.else, out);
        else collectFnsSeq(node.else.commands, out);
      }
      return;
    case "For":
    case "Select":
    case "ArithmeticFor":
      collectFnsSeq(node.body.commands, out);
      return;
    case "While":
      collectFnsSeq(node.clause.commands, out);
      collectFnsSeq(node.body.commands, out);
      return;
    case "Case":
      for (const it of node.items) collectFnsSeq(it.body.commands, out);
      return;
    case "Statement":
      // Statement 層的重導向（如 `{ cat; } <<EOF $(f(){:;};f) EOF` 的 heredoc）會被 walk 以
      // inherited 列舉其 body 內層呼叫；此處同步掃 target/body，函式定義名才不漏。
      for (const r of node.redirects) {
        if (r.target) collectFnsInWord(r.target, out);
        if (r.body) collectFnsInWord(r.body, out);
      }
      collectFns(node.command, out);
      return;
    default:
      // TestCommand / ArithmeticCommand / Coproc：無相關內層函式定義
      return;
  }
}

/** 逐一掃描 Statement[] 序列，含每個 statement 自身的 redirect（繼承 heredoc 等）。 */
function collectFnsSeq(statements: Statement[], out: Set<string>): void {
  for (const s of statements) {
    for (const r of s.redirects) {
      if (r.target) collectFnsInWord(r.target, out);
      if (r.body) collectFnsInWord(r.body, out);
    }
    collectFns(s.command, out);
  }
}

/** 掃描 Word 內的 CommandExpansion / ProcessSubstitution 腳本，遞迴收集函式定義名。 */
function collectFnsInWord(word: Word, out: Set<string>): void {
  if (!word.parts) return;
  for (const part of word.parts) collectFnsInPart(part, out);
}

function collectFnsInPart(part: WordPart, out: Set<string>): void {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    collectFnsSeq(part.script.commands, out);
  } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) collectFnsInPart(child, out);
  }
}
