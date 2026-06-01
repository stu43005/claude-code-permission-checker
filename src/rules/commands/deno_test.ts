import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { denoRule } from "./deno.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "deno",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

function v(src: string) {
  return denoRule.evaluate(ctxOf(src)).kind;
}

Deno.test("deno check / test / lint allow", () => {
  assertEquals(v("deno check src/main.ts"), "allow");
  assertEquals(v("deno test"), "allow");
  assertEquals(v("deno test --allow-env src/x_test.ts"), "allow");
  assertEquals(v("deno lint"), "allow");
});

Deno.test("deno run / task / compile / eval ask", () => {
  assertEquals(v("deno run x.ts"), "ask");
  assertEquals(v("deno task build"), "ask");
  assertEquals(v("deno compile src/main.ts"), "ask");
  assertEquals(v("deno eval 'console.log(1)'"), "ask");
});

Deno.test("deno with no subcommand asks", () => {
  assertEquals(v("deno --version"), "ask");
  assertEquals(v("deno"), "ask");
});

Deno.test("deno with dynamic subcommand asks", () => {
  assertEquals(v("deno $SUB"), "ask");
});
