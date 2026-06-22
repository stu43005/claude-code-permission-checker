import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { definedFunctionNames, walk } from "./walk.ts";
import type { CwdState } from "../types.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function names(src: string) {
  return walk(parseCommand(src).script, START, ROOT).map((i) => i.name);
}

Deno.test("single command", () => {
  assertEquals(names("cat a.txt"), ["cat"]);
});

Deno.test("pipeline enumerates each segment", () => {
  assertEquals(names("cat a | grep x | wc -l"), ["cat", "grep", "wc"]);
});

Deno.test("&& chain enumerates both", () => {
  assertEquals(names("cd src && cat a"), ["cd", "cat"]);
});

Deno.test("cd threads cwd across && to next command", () => {
  const invs = walk(parseCommand("cd src && cat a.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/proj/src" });
});

Deno.test("cd in subshell does not leak out", () => {
  const invs = walk(parseCommand("( cd /tmp ) ; cat a.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/proj" });
});

Deno.test("command substitution inner command is enumerated", () => {
  assertEquals(names("cat $(ls src)").sort(), ["cat", "ls"]);
});

Deno.test("git -C sets per-command cwd without leaking", () => {
  const invs = walk(parseCommand("git -C sub status ; cat a").script, START, ROOT);
  const git = invs.find((i) => i.name === "git")!;
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(git.cwd, { kind: "known", path: "/proj/sub" });
  assertEquals(cat.cwd, { kind: "known", path: "/proj" });
});

Deno.test("statement-level redirect is inherited by inner command", () => {
  const invs = walk(parseCommand("( cat a ) > out.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.redirects.length >= 1, true);
});

Deno.test("control flow containing cd marks subsequent cwd unknown", () => {
  const invs = walk(
    parseCommand("if true; then cd /tmp; fi ; cat a").script,
    START,
    ROOT,
  );
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "unknown" });
});

Deno.test("dynamic command name yields null name invocation", () => {
  const invs = walk(parseCommand("$CMD a").script, START, ROOT);
  assertEquals(invs[0].name, null);
});

Deno.test("empty / comment-only script yields no invocations", () => {
  assertEquals(walk(parseCommand("# just a comment").script, START, ROOT).length, 0);
});

Deno.test("walk 列舉 heredoc body 內的命令替換", () => {
  assertEquals(names("cat <<EOF\n$(rm -rf x)\nEOF"), ["cat", "rm"]);
  assertEquals(names("cat <<EOF\n$HOME\nEOF"), ["cat"]);          // 純變數 → 無內層指令
  assertEquals(names("cat <<'EOF'\n$(rm)\nEOF"), ["cat"]);        // 引號 → body 不解析
});

Deno.test("walk 列舉繼承（外層掛載）heredoc body / here-string 替換", () => {
  assertEquals(names("{ cat; } <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names("( cat ) <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names("while read; do cat; done <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names('{ cat; } <<<"$(rm)"').includes("rm"), true); // 繼承 here-string target
});

Deno.test("walk here-string target 替換仍被列舉（回歸）", () => {
  assertEquals(names('cat <<<"$(rm)"').includes("rm"), true);
});

Deno.test("walk 繼承 heredoc body 替換只列舉一次（compound 多葉、內部 cd 不重複/不改 cwd）", () => {
  const ns = names("{ cd sub; cat; } <<EOF\n$(rm x)\nEOF");
  assertEquals(ns.filter((n) => n === "rm").length, 1); // 只列舉一次
});

Deno.test("walk pipeline/巢狀成員上的 compound here-string 替換被列舉（修補安全遺漏）", () => {
  assertEquals(names('{ cat; } <<<"$(rm)" | grep x').includes("rm"), true);
  assertEquals(names('a | { b; } <<<"$(rm)"').includes("rm"), true);
});

Deno.test("walk 函式定義的延後 redirect 在定義時不列舉（回歸鎖定）", () => {
  assertEquals(names("f() { cat; } <<EOF\n$(rm)\nEOF").includes("rm"), false);
});

function fns(src: string) {
  return [...definedFunctionNames(parseCommand(src).script)].sort();
}

Deno.test("definedFunctionNames 收集函式定義名（含巢狀）", () => {
  assertEquals(fns("date(){ sleep 5; }; date"), ["date"]);
  assertEquals(fns("pwd(){ echo x; }; pwd"), ["pwd"]);
  assertEquals(fns("{ f(){ :; }; }; f"), ["f"]);
  assertEquals(fns("if true; then g(){ :; }; fi"), ["g"]);
  assertEquals(fns("echo hi"), []);
});

Deno.test("definedFunctionNames 涵蓋命令替換內的函式定義（含繼承 heredoc）", () => {
  // walk 會列舉 $() 內層的 date 呼叫；定義名也須被收集，閘③ 才能攔成 ask
  assertEquals(fns('echo "$(date(){ rm x; }; date)"'), ["date"]);
  // 繼承（Statement 層）heredoc body 內的定義也須收集
  assertEquals(fns("{ cat; } <<EOF\n$(f(){ :; }; f)\nEOF"), ["f"]);
  // 命令替換內、再經繼承 heredoc body 定義的函式名也須收集（與 walk 的 walkSequence 一致）
  assertEquals(
    fns("echo $( { cat; } <<EOF\n$(g(){ :; }; g)\nEOF\n)"),
    ["g"],
  );
  // 函式自身的 heredoc redirect body 內定義的函式名也須收集（與 Command/Statement case 一致）
  assertEquals(fns("f(){ :; } <<EOF\n$(g(){ :; }; g)\nEOF"), ["f", "g"]);
});

Deno.test("walk 列舉算術展開內的命令替換（argv / 標準算術指令 / for / 三元 / 一元 / 群組 / heredoc）", () => {
  assertEquals(names("echo $(( $(rm x) + 1 ))"), ["echo", "rm"]);
  assertEquals(names("(( $(rm x) + 1 ))"), ["rm"]);
  assertEquals(names("for (( i=$(rm x); i<1; i++ )); do :; done").includes("rm"), true);
  assertEquals(names("echo $(( $(rm a) > $(rm b) ? $(rm c) : $(rm d) ))").filter((n) => n === "rm").length, 4);
  assertEquals(names("echo $(( -$(rm u) ))").includes("rm"), true);
  assertEquals(names("echo $(( ($(rm g)) ))").includes("rm"), true);
  assertEquals(names("cat <<EOF\n$(( $(rm x) + 1 ))\nEOF").includes("rm"), true);
});

Deno.test("walk 列舉 [[ … ]] test 與 coproc 內的命令替換 / 指令", () => {
  assertEquals(names("[[ -n $(rm x) ]]"), ["rm"]);
  assertEquals(names("[[ $(rm a) == $(rm b) ]]").filter((n) => n === "rm").length, 2);
  assertEquals(names("coproc $(rm x)").includes("rm"), true);
  assertEquals(names("coproc name { cat; }").includes("cat"), true);
});

Deno.test("definedFunctionNames 涵蓋算術 / test / coproc 內的函式定義", () => {
  assertEquals(fns("echo $(( $(f(){ :; }; f) + 1 ))"), ["f"]);
  assertEquals(fns("[[ -n $(g(){ :; }; g) ]]"), ["g"]);
  assertEquals(fns("coproc name { h(){ :; }; h; }"), ["h"]);
});

Deno.test("walk 列舉 for/select/case header 位置的命令替換", () => {
  assertEquals(names("for x in $(rm a) $(rm b); do :; done").filter((n) => n === "rm").length, 2);
  assertEquals(names("select x in $(rm x); do :; done").includes("rm"), true);
  assertEquals(names("case $(rm w) in foo) :;; esac").includes("rm"), true);
  assertEquals(names("case foo in $(rm p)) :;; esac").includes("rm"), true);  // pattern position
});

Deno.test("definedFunctionNames 涵蓋 for/select/case header 內的函式定義", () => {
  assertEquals(fns("for x in $(f(){ :; }; f); do :; done"), ["f"]);
  assertEquals(fns("case $(g(){ :; }; g) in foo) :;; esac"), ["g"]);
});
