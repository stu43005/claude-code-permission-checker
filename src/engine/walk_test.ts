import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
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
