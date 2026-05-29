import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { grepRule } from "./grep.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
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
