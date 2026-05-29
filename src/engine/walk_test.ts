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
