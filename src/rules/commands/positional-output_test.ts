import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { uniqRule, xxdRule } from "./positional-output.ts";
import type { CommandRule, RuleContext } from "../types.ts";
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
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

function v(rule: CommandRule, name: string, src: string) {
  return rule.evaluate(ctxOf(name, src)).kind;
}

Deno.test("xxd single input allows", () => {
  assertEquals(v(xxdRule, "xxd", "xxd file"), "allow");
});

Deno.test("xxd -l value then single input allows", () => {
  assertEquals(v(xxdRule, "xxd", "xxd -l 16 file"), "allow");
});

Deno.test("xxd input + output file asks", () => {
  assertEquals(v(xxdRule, "xxd", "xxd in out.bin"), "ask");
});

Deno.test("uniq single input allows", () => {
  assertEquals(v(uniqRule, "uniq", "uniq file"), "allow");
});

Deno.test("uniq input + output asks", () => {
  assertEquals(v(uniqRule, "uniq", "uniq in out.txt"), "ask");
});

Deno.test("uniq -f value then single input allows", () => {
  assertEquals(v(uniqRule, "uniq", "uniq -f 2 file"), "allow");
});

Deno.test("xxd out-of-project input asks", () => {
  assertEquals(v(xxdRule, "xxd", "xxd /etc/hosts"), "ask");
});
