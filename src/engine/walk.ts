import type {
  ArithmeticExpression,
  Command,
  Node,
  Redirect,
  Script,
  Statement,
  TestExpression,
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
      for (const w of node.wordlist) enumerateInnerScripts(w, cwd, out);
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "While": {
      walkSequence(node.clause.commands, cwd, out, inherited, false);
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "ArithmeticFor": {
      enumerateArithmetic(node.initialize, cwd, out);
      enumerateArithmetic(node.test, cwd, out);
      enumerateArithmetic(node.update, cwd, out);
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "Case": {
      enumerateInnerScripts(node.word, cwd, out);
      for (const item of node.items) {
        for (const p of item.pattern) enumerateInnerScripts(p, cwd, out);
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
    case "ArithmeticCommand": {
      enumerateArithmetic(node.expression, cwd, out);
      return cwd;
    }
    case "TestCommand": {
      if (node.expression) enumerateTest(node.expression, cwd, out);
      return cwd;
    }
    case "Coproc": {
      if (node.name) enumerateInnerScripts(node.name, cwd, out);
      for (const r of node.redirects) {
        if (r.target) enumerateInnerScripts(r.target, cwd, out);
        if (r.body) enumerateInnerScripts(r.body, cwd, out);
      }
      walkNode(node.body, cwd, out, [...inherited, ...node.redirects], false);
      return cwd;
    }
    // Function 定義本體當下不執行。
    case "Function":
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

/** 遞迴遍歷算術運算式樹，列舉其中 ArithmeticCommandExpansion 內層 Script（算術內的 $(…) 仍會執行）。 */
function enumerateArithmetic(expr: ArithmeticExpression | undefined, cwd: CwdState, out: CommandInvocation[]): void {
  if (!expr) return;
  switch (expr.type) {
    case "ArithmeticCommandExpansion":
      if (expr.script) walkSequence(expr.script.commands, cwd, out, [], false);
      return;
    case "ArithmeticBinary":
      enumerateArithmetic(expr.left, cwd, out);
      enumerateArithmetic(expr.right, cwd, out);
      return;
    case "ArithmeticUnary":
      enumerateArithmetic(expr.operand, cwd, out);
      return;
    case "ArithmeticTernary":
      enumerateArithmetic(expr.test, cwd, out);
      enumerateArithmetic(expr.consequent, cwd, out);
      enumerateArithmetic(expr.alternate, cwd, out);
      return;
    case "ArithmeticGroup":
      enumerateArithmetic(expr.expression, cwd, out);
      return;
    case "ArithmeticWord":
      return;
  }
}

/** 遞迴遍歷 `[[ … ]]` test 運算式樹，對運算元 Word 列舉內層命令替換。 */
function enumerateTest(expr: TestExpression, cwd: CwdState, out: CommandInvocation[]): void {
  switch (expr.type) {
    case "TestUnary":
      enumerateInnerScripts(expr.operand, cwd, out);
      return;
    case "TestBinary":
      enumerateInnerScripts(expr.left, cwd, out);
      enumerateInnerScripts(expr.right, cwd, out);
      return;
    case "TestLogical":
      enumerateTest(expr.left, cwd, out);
      enumerateTest(expr.right, cwd, out);
      return;
    case "TestNot":
      enumerateTest(expr.operand, cwd, out);
      return;
    case "TestGroup":
      enumerateTest(expr.expression, cwd, out);
      return;
  }
}

function walkPart(part: WordPart, cwd: CwdState, out: CommandInvocation[]): void {
  if (
    (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") &&
    part.script
  ) {
    walkSequence(part.script.commands, cwd, out, [], false);
  } else if (part.type === "ArithmeticExpansion") {
    enumerateArithmetic(part.expression, cwd, out);
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
      // 函式自身掛載的 redirect（如 heredoc body 內 `$(g(){…};g)`）也可能定義函式；
      // 與 Command/Statement case 一致地掃描，保守收集（gate③ over-collect 為安全方向）。
      for (const r of node.redirects) {
        if (r.target) collectFnsInWord(r.target, out);
        if (r.body) collectFnsInWord(r.body, out);
      }
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
      for (const w of node.wordlist) collectFnsInWord(w, out);
      collectFnsSeq(node.body.commands, out);
      return;
    case "ArithmeticFor":
      collectFnsInArithmetic(node.initialize, out);
      collectFnsInArithmetic(node.test, out);
      collectFnsInArithmetic(node.update, out);
      collectFnsSeq(node.body.commands, out);
      return;
    case "While":
      collectFnsSeq(node.clause.commands, out);
      collectFnsSeq(node.body.commands, out);
      return;
    case "Case":
      collectFnsInWord(node.word, out);
      for (const it of node.items) {
        for (const p of it.pattern) collectFnsInWord(p, out);
        collectFnsSeq(it.body.commands, out);
      }
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
    case "ArithmeticCommand":
      collectFnsInArithmetic(node.expression, out);
      return;
    case "TestCommand":
      if (node.expression) collectFnsInTest(node.expression, out);
      return;
    case "Coproc":
      if (node.name) collectFnsInWord(node.name, out);
      for (const r of node.redirects) {
        if (r.target) collectFnsInWord(r.target, out);
        if (r.body) collectFnsInWord(r.body, out);
      }
      collectFns(node.body, out);
      return;
    default:
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

function collectFnsInArithmetic(expr: ArithmeticExpression | undefined, out: Set<string>): void {
  if (!expr) return;
  switch (expr.type) {
    case "ArithmeticCommandExpansion":
      if (expr.script) collectFnsSeq(expr.script.commands, out);
      return;
    case "ArithmeticBinary":
      collectFnsInArithmetic(expr.left, out);
      collectFnsInArithmetic(expr.right, out);
      return;
    case "ArithmeticUnary":
      collectFnsInArithmetic(expr.operand, out);
      return;
    case "ArithmeticTernary":
      collectFnsInArithmetic(expr.test, out);
      collectFnsInArithmetic(expr.consequent, out);
      collectFnsInArithmetic(expr.alternate, out);
      return;
    case "ArithmeticGroup":
      collectFnsInArithmetic(expr.expression, out);
      return;
    case "ArithmeticWord":
      return;
  }
}

function collectFnsInTest(expr: TestExpression, out: Set<string>): void {
  switch (expr.type) {
    case "TestUnary":
      collectFnsInWord(expr.operand, out);
      return;
    case "TestBinary":
      collectFnsInWord(expr.left, out);
      collectFnsInWord(expr.right, out);
      return;
    case "TestLogical":
      collectFnsInTest(expr.left, out);
      collectFnsInTest(expr.right, out);
      return;
    case "TestNot":
      collectFnsInTest(expr.operand, out);
      return;
    case "TestGroup":
      collectFnsInTest(expr.expression, out);
      return;
  }
}

function collectFnsInPart(part: WordPart, out: Set<string>): void {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    collectFnsSeq(part.script.commands, out);
  } else if (part.type === "ArithmeticExpansion") {
    collectFnsInArithmetic(part.expression, out);
  } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) collectFnsInPart(child, out);
  }
}

/** 是否存在任一「可執行位置」的函式定義（node-based；忽略函式名可否靜態還原）。鏡射 collectFns 走訪。 */
export function hasExecutableFunctionDefinition(script: Script): boolean {
  return seqHasFn(script.commands);
}

function seqHasFn(statements: Statement[]): boolean {
  return statements.some((s) =>
    s.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(s.command)
  );
}

function nodeHasFn(node: Node): boolean {
  switch (node.type) {
    case "Function":
      return true;
    case "Command": {
      const words: Word[] = [
        ...(node.name ? [node.name] : []),
        ...node.suffix,
        ...node.prefix.flatMap((a) => (a.value ? [a.value] : [])),
        ...node.redirects.flatMap((r) => (r.target ? [r.target] : [])),
        ...node.redirects.flatMap((r) => (r.body ? [r.body] : [])),
      ];
      return words.some(wordHasFn);
    }
    case "AndOr":
    case "Pipeline":
      return node.commands.some(nodeHasFn);
    case "Subshell":
    case "BraceGroup":
      return seqHasFn(node.body.commands);
    case "CompoundList":
      return seqHasFn(node.commands);
    case "If":
      return seqHasFn(node.clause.commands) || seqHasFn(node.then.commands) ||
        (node.else ? (node.else.type === "If" ? nodeHasFn(node.else) : seqHasFn(node.else.commands)) : false);
    case "For":
    case "Select":
      return node.wordlist.some(wordHasFn) || seqHasFn(node.body.commands);
    case "While":
      return seqHasFn(node.clause.commands) || seqHasFn(node.body.commands);
    case "ArithmeticFor":
      return arithHasFn(node.initialize) || arithHasFn(node.test) || arithHasFn(node.update) ||
        seqHasFn(node.body.commands);
    case "Case":
      return wordHasFn(node.word) ||
        node.items.some((it) => it.pattern.some(wordHasFn) || seqHasFn(it.body.commands));
    case "Statement":
      return node.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(node.command);
    case "ArithmeticCommand":
      return arithHasFn(node.expression);
    case "TestCommand":
      return node.expression ? testHasFn(node.expression) : false;
    case "Coproc":
      return (node.name ? wordHasFn(node.name) : false) ||
        node.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) ||
        nodeHasFn(node.body);
    default:
      return false;
  }
}

function wordHasFn(word: Word | undefined): boolean {
  if (!word?.parts) return false;
  return word.parts.some(partHasFn);
}
function partHasFn(part: WordPart): boolean {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    return seqHasFn(part.script.commands);
  }
  if (part.type === "ArithmeticExpansion") return arithHasFn(part.expression);
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") return part.parts.some(partHasFn);
  return false;
}
function arithHasFn(expr: ArithmeticExpression | undefined): boolean {
  if (!expr) return false;
  switch (expr.type) {
    case "ArithmeticCommandExpansion":
      return expr.script ? seqHasFn(expr.script.commands) : false;
    case "ArithmeticBinary":
      return arithHasFn(expr.left) || arithHasFn(expr.right);
    case "ArithmeticUnary":
      return arithHasFn(expr.operand);
    case "ArithmeticTernary":
      return arithHasFn(expr.test) || arithHasFn(expr.consequent) || arithHasFn(expr.alternate);
    case "ArithmeticGroup":
      return arithHasFn(expr.expression);
    default:
      return false;
  }
}
function testHasFn(expr: TestExpression): boolean {
  switch (expr.type) {
    case "TestUnary":
      return wordHasFn(expr.operand);
    case "TestBinary":
      return wordHasFn(expr.left) || wordHasFn(expr.right);
    case "TestLogical":
      return testHasFn(expr.left) || testHasFn(expr.right);
    case "TestNot":
      return testHasFn(expr.operand);
    case "TestGroup":
      return testHasFn(expr.expression);
    default:
      return false;
  }
}

const ALIAS_BUILTINS = new Set(["alias", "unalias"]);

/** 是否存在 alias 類名稱重定義（含 builtin/command 包裝；-v/-V 查詢不算）。 */
export function hasAliasRedefinition(invocations: CommandInvocation[]): boolean {
  return invocations.some((i) => {
    const eff = unwrapDispatcher(i.name, i.argv);
    if (eff === null) return false;
    if (ALIAS_BUILTINS.has(eff.name)) return true;
    if (eff.name === "shopt") return shoptEnablesAliases(eff.argv);
    return false;
  });
}

function unwrapDispatcher(name: string | null, argv: Word[]): { name: string; argv: Word[] } | null {
  if (name === null) return null;
  if (name !== "builtin" && name !== "command") return { name, argv };
  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null;
    if (v === "-v" || v === "-V") return null;          // 查詢：不執行 → 非 alias 重定義
    if (v === "--") {                                    // 選項終止符：其後第一個 token 即有效名（不論是否 -）
      const rest = argv.slice(i + 1);
      const nm = rest.length > 0 ? staticValue(rest[0]) : null;
      return nm === null ? null : unwrapDispatcher(nm, rest.slice(1));
    }
    if (v.startsWith("-")) { i++; continue; }
    return unwrapDispatcher(v, argv.slice(i + 1));       // 遞迴解多層
  }
  return null;
}

function shoptEnablesAliases(argv: Word[]): boolean {
  const vals = argv.map((w) => staticValue(w));
  return vals.includes("-s") && vals.includes("expand_aliases");
}
