import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import type { CwdState } from "../types.ts";
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}

function onlyWith(src: string, rules: PermissionRules) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules);
}

function only(src: string) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT);
}

Deno.test("dynamic command name asks", () => {
  assertEquals(only("$CMD a").kind, "ask");
});

Deno.test("not-in-allowlist asks", () => {
  assertEquals(only("rm -rf x").kind, "ask");
});

Deno.test("known-out-of-project cwd asks before rule", () => {
  const invs = walk(parseCommand("cd /tmp && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT).kind, "ask");
});

Deno.test("write redirect asks", () => {
  assertEquals(only("echo hi > out.txt").kind, "ask");
});

Deno.test("read-only in-project allows", () => {
  assertEquals(only("cat src/a.ts").kind, "allow");
});

Deno.test("null-device redirect still allows", () => {
  assertEquals(only("grep x f 2>/dev/null").kind, "allow");
});

Deno.test("LD_PRELOAD env assignment prefix asks", () => {
  assertEquals(only("LD_PRELOAD=/tmp/x.so cat a").kind, "ask");
});

Deno.test("FOO=bar env assignment prefix asks", () => {
  assertEquals(only("FOO=bar cat a").kind, "ask");
});

Deno.test("settings allow upgrades ask -> allow", () => {
  assertEquals(onlyWith("npm test x", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("builtin allow stays allow regardless of rules", () => {
  assertEquals(onlyWith("cat src/a.ts", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("deny blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("ask rule blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], ask: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("no rules arg behaves as before (npm asks)", () => {
  assertEquals(only("npm test").kind, "ask");
});
