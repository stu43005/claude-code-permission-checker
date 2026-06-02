import { assertEquals } from "@std/assert";
import { matchesAny, matchesPattern, parseBashRule } from "./matcher.ts";

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
