import { assertEquals } from "@std/assert";
import { parseCommand } from "../engine/parse.ts";
import { walk } from "../engine/walk.ts";
import type { CwdState } from "../types.ts";
import { matchesAny, matchesPattern, parseBashRule, reconstructCommand } from "./matcher.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

/** 取單一指令的第一筆 invocation。 */
function firstInv(src: string) {
  return walk(parseCommand(src).script, START, ROOT)[0];
}

Deno.test("parseBashRule: :* -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(npm test:*)"), { kind: "prefix-boundary", prefix: "npm test" });
});

Deno.test("parseBashRule: space-star -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(ls *)"), { kind: "prefix-boundary", prefix: "ls" });
});

Deno.test("parseBashRule: trailing star no space -> prefix-loose", () => {
  assertEquals(parseBashRule("Bash(ls*)"), { kind: "prefix-loose", prefix: "ls" });
});

Deno.test("parseBashRule: no star -> exact", () => {
  assertEquals(parseBashRule("Bash(git status)"), { kind: "exact", text: "git status" });
});

Deno.test("parseBashRule: non-Bash tool -> null", () => {
  assertEquals(parseBashRule("Read(./x)"), null);
});

Deno.test("parseBashRule: mid-star -> null", () => {
  assertEquals(parseBashRule("Bash(git * --x)"), null);
  assertEquals(parseBashRule("Bash(git * status:*)"), null);
});

Deno.test("parseBashRule: empty inner -> null", () => {
  assertEquals(parseBashRule("Bash()"), null);
});

Deno.test("parseBashRule: empty prefix (matches all) -> null", () => {
  assertEquals(parseBashRule("Bash(*)"), null);
  assertEquals(parseBashRule("Bash(:*)"), null);
  assertEquals(parseBashRule("Bash( *)"), null);
});

Deno.test("parseBashRule: not Bash(...) shape -> null", () => {
  assertEquals(parseBashRule("Bash(ls"), null);
  assertEquals(parseBashRule("npm test"), null);
});

Deno.test("matchesPattern: prefix-boundary matches prefix and prefix+space, not glued", () => {
  const p = parseBashRule("Bash(ls *)")!;
  assertEquals(matchesPattern("ls", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
  assertEquals(matchesPattern("lsof", p), false);
});

Deno.test("matchesPattern: prefix-loose matches glued", () => {
  const p = parseBashRule("Bash(ls*)")!;
  assertEquals(matchesPattern("lsof", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
});

Deno.test("matchesPattern: exact matches only equal", () => {
  const p = parseBashRule("Bash(git status)")!;
  assertEquals(matchesPattern("git status", p), true);
  assertEquals(matchesPattern("git status --short", p), false);
});

Deno.test("matchesAny: true if any pattern matches", () => {
  const pats = [parseBashRule("Bash(git status)")!, parseBashRule("Bash(npm test:*)")!];
  assertEquals(matchesAny("npm test --silent", pats), true);
  assertEquals(matchesAny("rm -rf x", pats), false);
});

Deno.test("reconstructCommand: name + static argv joined by single space", () => {
  assertEquals(reconstructCommand(firstInv("git diff --stat")), "git diff --stat");
});

Deno.test("reconstructCommand: quoted arg is de-quoted, single-space joined", () => {
  assertEquals(reconstructCommand(firstInv('grep "foo bar" f')), "grep foo bar f");
});

Deno.test("reconstructCommand: dynamic argv (variable) -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $FILE")), null);
});

Deno.test("reconstructCommand: command substitution arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $(ls)")), null);
});

Deno.test("reconstructCommand: unquoted glob arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat *.txt")), null);
});

Deno.test("reconstructCommand: assignment prefix -> null", () => {
  assertEquals(reconstructCommand(firstInv("FOO=bar cat a")), null);
});

Deno.test("reconstructCommand: dynamic command name -> null", () => {
  assertEquals(reconstructCommand(firstInv("$CMD a")), null);
});
