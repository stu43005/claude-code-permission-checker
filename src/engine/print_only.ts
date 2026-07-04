import type { CommandInvocation, CwdState } from "../types.ts";
import type {
  AndOr, ArithmeticExpression, Command, CompoundList, Node, Pipeline, Redirect,
  Script, Statement, TestExpression, Word, WordPart,
} from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { staticValue } from "./word.ts";
import { payloadIsAllStaticPrint, printExprIsStaticString, type Lang } from "./interp_payload.ts";
import { heredocStdinText, isCatPassthrough, isEchoPrintOnly, isPrintfPrintOnly, producerStdout, writtenContent } from "./static_output.ts";
import { applyCd, isCd } from "./cwd.ts";
import { normalizeAbsolute } from "./scope.ts";
import type { PrintDisguiseKind } from "../rules/types.ts";
export { wordPrintEligible } from "./static_output.ts";   // 既有 print_only_test.ts 由 print_only 匯入

/** 整鏈聚合：至少一個指令、且每個葉指令皆 print 形態。 */
export function isAllPrintOnly(invocations: CommandInvocation[]): boolean {
  return invocations.length > 0 && invocations.every(isPrintOnlyForm);
}

/** 單一葉指令是否為「靜態吐字」形態（echo / printf / cat·tac heredoc）。 */
export function isPrintOnlyForm(inv: CommandInvocation): boolean {
  if (inv.name === null) return false;                 // 動態指令名 → 本就 ask
  if (hasWriteRedirect(inv.redirects)) return false;   // 有寫檔副作用 → 非純輸出
  if (inv.assignments.length > 0) return false;        // var=val 前綴 → 可能改變執行
  switch (inv.name) {
    case "echo":
      return isEchoPrintOnly(inv);
    case "printf":
      return isPrintfPrintOnly(inv);
    case "cat":
    case "tac":
      return isCatPassthrough(inv);
    default:
      return false;
  }
}

const INTERP_LANG: Record<string, Lang> = {
  node: "js", nodejs: "js", deno: "js", bun: "js", "ts-node": "js",
  python: "py", python3: "py",
};
// per-language inline-eval / print 旗標
const JS_INLINE = new Set(["-e", "--eval"]);
const PY_INLINE = new Set(["-c"]);
const JS_PRINT = new Set(["-p", "--print"]);   // python/deno 無此語意
const INJECT_FLAGS = new Set([
  "-r", "--require", "--import", "-m", "--preload", "--env-file", "--loader", "--experimental-loader",
]);
// 每個直譯器各自的「已知 nullary（不吃值）良性旗標」小集合；集合外的分離裸旗標 → 保守放棄。
const NULLARY_BY_INTERP: Record<string, Set<string>> = {
  node: new Set(["--no-warnings"]),
  nodejs: new Set(["--no-warnings"]),
  bun: new Set(["--no-warnings"]),
  "ts-node": new Set(["--transpile-only", "--esm", "--no-check", "--no-warnings"]),
  deno: new Set(["--no-check"]),
  python: new Set<string>(),
  python3: new Set<string>(),
};
function isKnownNullary(name: string, fn: string, isDeno: boolean): boolean {
  if (NULLARY_BY_INTERP[name]?.has(fn)) return true;
  // --experimental-* 僅 js 家族（node/bun/ts-node）；--allow-*/-A 僅 deno。
  if ((name === "node" || name === "nodejs" || name === "bun" || name === "ts-node") &&
    fn.startsWith("--experimental-")) return true;
  if (isDeno && (fn.startsWith("--allow-") || fn === "-A")) return true;
  return false;
}
function flagName(tok: string): string {
  const eq = tok.indexOf("=");
  return eq > 0 && tok.startsWith("-") ? tok.slice(0, eq) : tok;
}
function flagValue(tok: string, next: Word | undefined): string | null {
  return tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : (next ? staticValue(next) : null);
}

type InterpForm =
  | { kind: "inline"; payload: string }
  | { kind: "print-expr"; expr: string }
  | { kind: "stdin" }
  | { kind: "script"; entrypoint: string }
  | { kind: "none" };

/** 解析直譯器葉形態。fail-safe：任何不確定 → { kind: "none" } 或 null（非直譯器/動態）。 */
export function recognizeInterpreter(inv: CommandInvocation): { lang: Lang; form: InterpForm } | null {
  if (inv.name === null) return null;
  const name = inv.name;
  let argv = inv.argv;
  const lang = INTERP_LANG[name];
  if (lang === undefined) return null;
  const isDeno = name === "deno";
  // 子指令模式：deno 必為 eval 或 run；bun run 為 run；其餘裸指令為 normal。
  let mode: "normal" | "eval" | "run" = "normal";
  if (name === "deno") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "eval") { mode = "eval"; argv = argv.slice(1); }
    else if (sub === "run") { mode = "run"; argv = argv.slice(1); }
    else return null;
  } else if (name === "bun") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "run") { mode = "run"; argv = argv.slice(1); }
  }
  // run 模式（deno run / bun run）不吃 inline/-e/-p；只認 script/stdin。
  const inlineFlags = mode === "run" ? new Set<string>() : (lang === "py" ? PY_INLINE : JS_INLINE);
  const printFlags = (mode === "normal" && lang === "js" && name !== "deno") ? JS_PRINT : new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null;
    if (v === "-") {
      // deno run - 為 stdin；其餘（bun run -、eval 模式）不特案 → none
      return (mode === "run" && isDeno) ? { lang, form: { kind: "stdin" } } : { lang, form: { kind: "none" } };
    }
    if (!v.startsWith("-")) {
      // eval 模式第一個位置參數為 payload；run/normal 為 script entrypoint
      return mode === "eval"
        ? { lang, form: { kind: "inline", payload: v } }
        : { lang, form: { kind: "script", entrypoint: v } };
    }
    if (v === "--") {
      // POSIX 選項終止符：之後的第一個 token 為位置參數（不視為旗標）
      const next = i + 1 < argv.length ? staticValue(argv[i + 1]) : null;
      if (mode === "eval") {
        return next !== null
          ? { lang, form: { kind: "inline", payload: next } }
          : { lang, form: { kind: "none" } };
      } else {
        return next !== null
          ? { lang, form: { kind: "script", entrypoint: next } }
          : { lang, form: { kind: "stdin" } };
      }
    }
    const fn = flagName(v);
    if (inlineFlags.has(fn)) {
      const val = flagValue(v, argv[i + 1]);
      return val === null ? null : { lang, form: { kind: "inline", payload: val } };
    }
    if (printFlags.has(fn)) {
      const val = flagValue(v, argv[i + 1]);
      return val === null ? null : { lang, form: { kind: "print-expr", expr: val } };
    }
    if (INJECT_FLAGS.has(fn)) return { lang, form: { kind: "none" } };
    if (v.includes("=")) { i++; continue; }
    if (isKnownNullary(name, fn, isDeno)) { i++; continue; }
    return { lang, form: { kind: "none" } };   // 分離未知裸旗標 → 保守放棄
  }
  // 掃完無位置參數：eval 無 payload → none；否則可能配 heredoc → stdin
  return mode === "eval" ? { lang, form: { kind: "none" } } : { lang, form: { kind: "stdin" } };
}

// 直譯器葉 fd0 的靜態 heredoc/here-string 文字沿用 static_output 的 heredocStdinText（同一還原規則：
// isHeredocPrintEligible 合格判定、`<<<` 補換行、`<<-` 去 tab、結構化 body（含 $()）→ null）。

/** 直譯器葉的 stdout 是否被 fd1 重導向轉走（→ 非「印到 stdout」吐字，不算載具）。 */
function interpStdoutDiverted(inv: CommandInvocation): boolean {
  return inv.redirects.some((r) =>
    (r.operator === ">" || r.operator === ">>" || r.operator === ">|" ||
      r.operator === "&>" || r.operator === "&>>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
}

/** 葉載具：shell 靜態吐字 → "shell"；直譯器 inline/stdin → "interp"；否則 null。 */
export function leafCarrier(inv: CommandInvocation): "shell" | "interp" | null {
  if (isPrintOnlyForm(inv)) return "shell";
  if (inv.assignments.length > 0) return null;
  if (interpStdoutDiverted(inv)) return null;   // 直譯器輸出寫檔/轉走 → 非 stdout 吐字
  const r = recognizeInterpreter(inv);
  if (r === null) return null;
  if (r.form.kind === "inline") return payloadIsAllStaticPrint(r.form.payload, r.lang) ? "interp" : null;
  if (r.form.kind === "print-expr") return printExprIsStaticString(r.form.expr, r.lang) ? "interp" : null;
  if (r.form.kind === "stdin") {
    const body = heredocStdinText(inv.redirects);
    return body !== null && payloadIsAllStaticPrint(body, r.lang) ? "interp" : null;
  }
  return null;
}

type Role = "leaf" | "write-exec" | "pipe" | "setup" | "none";
const SETUP_NAMES = new Set(["mkdir", "cd", "true", ":"]);

interface Leaf {
  inv: CommandInvocation;
  cmd: Command;
  role: Role;
  carrier: "shell" | "interp" | null;
}
interface WriteRef {
  leaf: Leaf;
  path: string;
  content: string | null;
  cwd: CwdState;
}

/** 聚合入口：單一自足走訪（鏡射 walk.ts）、兩階段。回命中 kind 或 null。 */
export function printDisguiseDeny(script: Script, initialCwd: CwdState): { kind: PrintDisguiseKind } | null {
  const leaves: Leaf[] = [];
  let hasWriteExecComposite = false;

  // 序列：thread cwd + prevWrite；` ` / `;` / `&&` 連接的 sibling 傳遞 prev；背景/控制流重置。
  // bg：外層是否處於背景（`&`/coproc）——背景時整個子序列停用 pipe 配對、不傳 adjacency。
  const seq = (statements: Statement[], startCwd: CwdState, inherited: Redirect[], persistent: boolean, bg: boolean): CwdState => {
    let cwd = startCwd;
    let prev: WriteRef | null = null;
    for (const stmt of statements) {
      for (const r of stmt.redirects) enumRedirect(r, cwd);        // 繼承 heredoc 內 $()
      const merged = [...inherited, ...stmt.redirects];
      if (bg || stmt.background === true) {
        node(stmt.command, cwd, merged, false, true, null);        // 背景：不參與 adjacency、跳過 pipe 配對
        prev = null;
        continue;
      }
      const r = node(stmt.command, cwd, merged, false, false, prev);
      if (persistent) cwd = r.cwd;
      prev = r.prev;
    }
    return cwd;
  };

  // 回 { cwd, prev }。bg=true → 停用 pipe 配對；negated 傳給單成員否定 Pipeline。
  const node = (n: Node, cwd: CwdState, inherited: Redirect[], negated: boolean, bg: boolean, prev: WriteRef | null): { cwd: CwdState; prev: WriteRef | null } => {
    switch (n.type) {
      case "Command": {
        const cmd = n as Command;
        const inv = toInv(cmd, cwd, inherited);
        const leaf = classify(inv, cmd, negated, prev);
        leaves.push(leaf);
        descendCmdSubstitutions(cmd, cwd);
        const nextPrev = detectWrite(inv, cmd, cwd, leaf);
        const nextCwd = isCd(cmd) ? applyCd(cmd, cwd) : cwd;
        return { cwd: nextCwd, prev: nextPrev };
      }
      case "AndOr": {
        const ao = n as AndOr;
        let cur = cwd;
        let p = prev;
        for (let k = 0; k < ao.commands.length; k++) {
          if (k > 0 && ao.operators[k - 1] === "||") p = null;      // || 重置 adjacency
          const r = node(ao.commands[k], cur, inherited, negated, bg, p);
          cur = r.cwd;
          p = r.prev;
        }
        return { cwd: cur, prev: p };
      }
      case "Pipeline": {
        detectPipe(n as Pipeline, cwd, inherited, bg);
        return { cwd, prev: null };
      }
      case "Subshell":
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd, prev: null };
      case "BraceGroup":
        return { cwd: seq(n.body.commands, cwd, inherited, true, bg), prev: null };
      case "CompoundList":
        return { cwd: seq((n as CompoundList).commands, cwd, inherited, true, bg), prev: null };
      case "If":
        seq(n.clause.commands, cwd, inherited, false, bg);
        seq(n.then.commands, cwd, inherited, false, bg);
        if (n.else) n.else.type === "If" ? node(n.else, cwd, inherited, false, bg, null) : seq(n.else.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "For":
      case "Select":
        for (const w of n.wordlist) descendWord(w, cwd);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "While":
        seq(n.clause.commands, cwd, inherited, false, bg);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "ArithmeticFor":
        descendArith(n.initialize, cwd);
        descendArith(n.test, cwd);
        descendArith(n.update, cwd);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "Case":
        descendWord(n.word, cwd);
        for (const it of n.items) {
          for (const p of it.pattern) descendWord(p, cwd);
          seq(it.body.commands, cwd, inherited, false, bg);
        }
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "ArithmeticCommand":
        descendArith(n.expression, cwd);
        return { cwd, prev: null };
      case "TestCommand":
        if (n.expression) descendTest(n.expression, cwd);
        return { cwd, prev: null };
      case "Coproc":
        if (n.name) descendWord(n.name, cwd);
        for (const r of n.redirects) enumRedirect(r, cwd);
        node(n.body, cwd, [...inherited, ...n.redirects], false, true, null);   // coproc 非同步 → 跳過 pipe 配對
        return { cwd, prev: null };
      case "Statement": {
        const st = n as Statement;
        for (const r of st.redirects) enumRedirect(r, cwd);
        if (st.background === true) { node(st.command, cwd, [...inherited, ...st.redirects], false, true, null); return { cwd, prev: null }; }
        return node(st.command, cwd, [...inherited, ...st.redirects], negated, bg, prev);
      }
      default:
        return { cwd, prev: null };
    }
  };

  // 控制流後：僅當子樹含 cd 才標 unknown（與 walk.ts 一致）。
  const afterControlFlow = (cwd: CwdState, n: Node): CwdState =>
    cwd.kind === "known" && subtreeContainsCd(n) ? { kind: "unknown" } : cwd;

  const detectPipe = (pl: Pipeline, cwd: CwdState, inherited: Redirect[], bg: boolean): void => {
    const members = pl.commands;
    if (members.length === 1) { node(members[0], cwd, inherited, pl.negated === true, bg, null); return; }
    // 恰兩段、非背景、無整體 pipeline（繼承）重導向 → 嘗試配對；否定不影響資料流、照常判。
    const canPair = members.length === 2 && !bg && inherited.length === 0;
    if (canPair) {
      const prod = members[0].type === "Command" ? members[0] as Command : null;
      const cons = members[1].type === "Command" ? members[1] as Command : null;
      if (prod && cons) {
        const consInv = toInv(cons, cwd, []);
        const source = producerStdout(prod);
        const r = recognizeInterpreter(consInv);
        const clean = consInv.assignments.length === 0 && r !== null && r.form.kind === "stdin" &&
          !hasFd0Override(consInv) && !interpStdoutDiverted(consInv);   // 消費端 stdout 亦不可被轉走
        if (source !== null && clean && payloadIsAllStaticPrint(source, r.lang)) {
          leaves.push({ inv: toInv(prod, cwd, []), cmd: prod, role: "pipe", carrier: null });
          leaves.push({ inv: consInv, cmd: cons, role: "pipe", carrier: null });
          descendCmdSubstitutions(prod, cwd);   // 兩端 word 內 $()/<() 仍納入覆蓋葉集
          descendCmdSubstitutions(cons, cwd);
          return;
        }
      }
    }
    // 不配對：各段當一般葉；保留 inherited（整體 pipeline 重導向使葉成非載具）、negated、bg。
    for (const m of members) node(m, cwd, inherited, pl.negated === true, bg, null);
  };

  seq(script.commands, initialCwd, [], true, false);

  // 階段 2
  if (leaves.length === 0) return null;
  let sawCarrier = false;
  for (const lf of leaves) {
    const covered = lf.role === "leaf" || lf.role === "write-exec" || lf.role === "pipe" ||
      (lf.role === "setup" && hasWriteExecComposite);
    if (!covered) return null;
    if (lf.carrier !== null || lf.role === "write-exec" || lf.role === "pipe") sawCarrier = true;
  }
  if (!sawCarrier) return null;
  return { kind: pickKind() };

  // ── 內部 helper ──
  function classify(inv: CommandInvocation, cmd: Command, negated: boolean, prev: WriteRef | null): Leaf {
    const exec = matchExec(inv, prev);
    if (exec !== null) {
      prev!.leaf.role = "write-exec";
      hasWriteExecComposite = true;
      return { inv, cmd, role: "write-exec", carrier: null };
    }
    const carrier = leafCarrier(inv);
    if (carrier) return { inv, cmd, role: "leaf", carrier };
    if (!negated && inv.name !== null && SETUP_NAMES.has(inv.name) && inv.assignments.length === 0) {
      return { inv, cmd, role: "setup", carrier: null };
    }
    return { inv, cmd, role: "none", carrier: null };
  }

  function matchExec(inv: CommandInvocation, prev: WriteRef | null): "interp" | "cat" | null {
    if (prev === null || prev.content === null || inv.assignments.length > 0) return null;
    if (interpStdoutDiverted(inv)) return null;   // EXEC/讀回 stdout 被轉走 → 非 stdout 吐字，不配對
    const r = recognizeInterpreter(inv);
    if (r && r.form.kind === "script") {
      if (!sameFile(r.form.entrypoint, inv.cwd, prev.path, prev.cwd)) return null;
      return payloadIsAllStaticPrint(prev.content, r.lang) ? "interp" : null;
    }
    if ((inv.name === "cat" || inv.name === "tac") && !hasFd0Override(inv)) {   // cat 讀回：無 fd0 覆蓋
      const op = soleReadOperand(inv);
      if (op !== null && sameFile(op, inv.cwd, prev.path, prev.cwd)) return "cat";
    }
    return null;
  }

  function detectWrite(inv: CommandInvocation, cmd: Command, cwd: CwdState, leaf: Leaf): WriteRef | null {
    if (inv.name === null || inv.assignments.length > 0) return null;
    if (!["cat", "tac", "echo", "printf"].includes(inv.name)) return null;
    const p = soleTruncWrite(inv.redirects);
    if (p === null) return null;
    return { leaf, path: p, content: writtenContent(cmd), cwd };
  }

  function pickKind(): PrintDisguiseKind {
    if (leaves.some((l) => l.role === "write-exec" && weIsInterp(l))) return "write-exec";
    if (leaves.some((l) => l.role === "write-exec")) return "cat-readback";
    if (leaves.some((l) => l.role === "pipe")) return "pipe";
    if (leaves.some((l) => l.carrier === "interp")) return "interp-inline";
    return "shell-print";
  }
  function weIsInterp(l: Leaf): boolean {
    const r = recognizeInterpreter(l.inv);
    return r !== null && r.form.kind === "script";
  }

  // $()/<() 列舉：Command 的所有 word（name/suffix/prefix 值/redirect target·body）
  function descendCmdSubstitutions(cmd: Command, cwd: CwdState): void {
    if (cmd.name) descendWord(cmd.name, cwd);
    for (const w of cmd.suffix) descendWord(w, cwd);
    for (const a of cmd.prefix) if (a.value) descendWord(a.value, cwd);
    for (const r of cmd.redirects) enumRedirect(r, cwd);
  }
  function enumRedirect(r: Redirect, cwd: CwdState): void {
    if (r.target) descendWord(r.target, cwd);
    if (r.body) descendWord(r.body, cwd);
  }
  function descendWord(w: Word, cwd: CwdState): void {
    if (!w.parts) return;
    for (const part of w.parts) descendPart(part, cwd);
  }
  function descendPart(part: WordPart, cwd: CwdState): void {
    if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
      seq(part.script.commands, cwd, [], false, false);   // 內層葉（prev/cwd 不外洩）
    } else if (part.type === "ArithmeticExpansion") {
      descendArith(part.expression, cwd);
    } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
      for (const child of part.parts) descendPart(child, cwd);
    }
  }
  function descendArith(expr: ArithmeticExpression | undefined, cwd: CwdState): void {
    if (!expr) return;
    switch (expr.type) {
      case "ArithmeticCommandExpansion": if (expr.script) seq(expr.script.commands, cwd, [], false, false); return;
      case "ArithmeticBinary": descendArith(expr.left, cwd); descendArith(expr.right, cwd); return;
      case "ArithmeticUnary": descendArith(expr.operand, cwd); return;
      case "ArithmeticTernary": descendArith(expr.test, cwd); descendArith(expr.consequent, cwd); descendArith(expr.alternate, cwd); return;
      case "ArithmeticGroup": descendArith(expr.expression, cwd); return;
      default: return;
    }
  }
  function descendTest(expr: TestExpression, cwd: CwdState): void {
    switch (expr.type) {
      case "TestUnary": descendWord(expr.operand, cwd); return;
      case "TestBinary": descendWord(expr.left, cwd); descendWord(expr.right, cwd); return;
      case "TestLogical": descendTest(expr.left, cwd); descendTest(expr.right, cwd); return;
      case "TestNot": descendTest(expr.operand, cwd); return;
      case "TestGroup": descendTest(expr.expression, cwd); return;
      default: return;
    }
  }
}

// ── module-level helpers ──
// 子樹是否含 cd（鏡射 walk.ts containsCd）。
function subtreeContainsCd(node: Node): boolean {
  switch (node.type) {
    case "Command": return isCd(node as Command);
    case "AndOr":
    case "Pipeline": return node.commands.some(subtreeContainsCd);
    case "Subshell":
    case "BraceGroup": return node.body.commands.some((s: Statement) => subtreeContainsCd(s.command));
    case "CompoundList": return (node as CompoundList).commands.some((s) => subtreeContainsCd(s.command));
    case "If": return node.clause.commands.some((s) => subtreeContainsCd(s.command)) ||
      node.then.commands.some((s) => subtreeContainsCd(s.command)) ||
      (node.else ? (node.else.type === "If" ? subtreeContainsCd(node.else) : node.else.commands.some((s) => subtreeContainsCd(s.command))) : false);
    case "For":
    case "Select":
    case "ArithmeticFor": return node.body.commands.some((s: Statement) => subtreeContainsCd(s.command));
    case "While": return node.clause.commands.some((s) => subtreeContainsCd(s.command)) ||
      node.body.commands.some((s) => subtreeContainsCd(s.command));
    case "Case": return node.items.some((it) => it.body.commands.some((s) => subtreeContainsCd(s.command)));
    case "Statement": return subtreeContainsCd((node as Statement).command);
    default: return false;
  }
}
function toInv(cmd: Command, cwd: CwdState, inherited: Redirect[]): CommandInvocation {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: [...inherited, ...cmd.redirects],
    cwd,
  };
}
function soleTruncWrite(redirects: CommandInvocation["redirects"]): string | null {
  const fd1 = redirects.filter((r) =>
    (r.operator === ">" || r.operator === ">|" || r.operator === ">>" || r.operator === "&>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
  if (fd1.length !== 1) return null;
  const r = fd1[0];
  if (r.operator !== ">" && r.operator !== ">|") return null;
  return r.target ? staticValue(r.target) : null;
}
function soleReadOperand(inv: CommandInvocation): string | null {
  const ops: string[] = [];
  let afterDoubleDash = false;
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    if (!afterDoubleDash && v === "--") { afterDoubleDash = true; continue; }  // POSIX 選項終止符
    if (!afterDoubleDash && v.startsWith("-")) continue;                        // 旗標
    ops.push(v);
  }
  return ops.length === 1 ? ops[0] : null;
}
function hasFd0Override(inv: CommandInvocation): boolean {
  return inv.redirects.some((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
}
function sameFile(a: string, ca: CwdState, b: string, cb: CwdState): boolean {
  const ra = resolveForCompare(a, ca);
  const rb = resolveForCompare(b, cb);
  return ra !== null && ra === rb;
}
function resolveForCompare(p: string, cwd: CwdState): string | null {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return normalizeAbsolute(p);
  if (cwd.kind === "known") return normalizeAbsolute(cwd.path + "/" + p);
  return "REL:" + p;
}
