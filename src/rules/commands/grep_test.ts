import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { grepRule } from "./grep.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("grep in-project allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo bar.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rn TODO src")).kind, "allow");
});

Deno.test("grep reading out-of-project file asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep root /etc/passwd")).kind, "ask");
});

Deno.test("rg -A value skipped, in-project allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg -A 3 pattern src")).kind, "allow");
});

Deno.test("rule covers aliases", () => {
  assertEquals(grepRule.names.includes("egrep"), true);
  assertEquals(grepRule.names.includes("rg"), true);
});

Deno.test("grep -f out-of-project pattern file asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f /etc/patterns readme.md")).kind, "ask");
});

Deno.test("grep --file= out-of-project asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --file=/etc/x readme.md")).kind, "ask");
});

Deno.test("grep -f in-project pattern file allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f patterns.txt readme.md")).kind, "allow");
});

Deno.test("grep -r / rg 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -r x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -R x ~")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --recursive x $HOME")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rn x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg x ~")).kind, "deny");
});

Deno.test("grep 非遞迴碰根 -> 非 deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep / file")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x /")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");
});

Deno.test("grep 危險根緊跟 -r（被吃值位置）仍 deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo -r /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x -r ~")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo -r $HOME")).kind, "deny");
});
