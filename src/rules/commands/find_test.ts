import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { findRule } from "./find.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "find",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

Deno.test("find search in-project allows", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -name '*.ts'")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find src tests -type f")).kind, "allow");
});

Deno.test("find -delete asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -delete")).kind, "ask");
});

Deno.test("find -exec asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -exec rm {} ;")).kind, "ask");
});

Deno.test("find -fprintf asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -fprintf out '%p'")).kind, "ask");
});

Deno.test("find out-of-project start path asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find /etc -name passwd")).kind, "ask");
});
