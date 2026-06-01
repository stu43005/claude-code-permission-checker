import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { awkRule } from "./awk.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "awk",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

Deno.test("awk NR range filter allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk 'NR>=8940 && NR<=9281' file")).kind, "allow");
});

Deno.test("awk print field allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{print $1}' file")).kind, "allow");
});

Deno.test("awk -F filter allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk -F, '$3>100' file")).kind, "allow");
});

Deno.test("awk redirect to file asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{print > \"out\"}' file")).kind, "ask");
});

Deno.test("awk system() asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{system(\"rm x\")}' file")).kind, "ask");
});

Deno.test("awk getline asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{\"cmd\"|getline}' file")).kind, "ask");
});

Deno.test("awk -f progfile asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk -f prog.awk file")).kind, "ask");
});

Deno.test("awk allowed form but out-of-project file asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk 'NR<5' /etc/passwd")).kind, "ask");
});

Deno.test("awk dynamic program asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk $PROG file")).kind, "ask");
});
