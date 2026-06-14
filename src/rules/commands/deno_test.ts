import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { denoRule } from "./deno.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "deno",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

function v(src: string) {
  return denoRule.evaluate(ctxOf(src)).kind;
}

Deno.test("deno check / lint / info allow", () => {
  assertEquals(v("deno check src/main.ts"), "allow");
  assertEquals(v("deno lint"), "allow");
  assertEquals(v("deno lint src/main.ts"), "allow");
  assertEquals(v("deno info"), "allow");
  assertEquals(v("deno info jsr:@std/http/file-server"), "allow");
});

Deno.test("deno lint --fix asks (改寫原始碼)", () => {
  assertEquals(v("deno lint --fix"), "ask");
  assertEquals(v("deno lint --fix src/main.ts"), "ask");
  assertEquals(v("deno lint src/main.ts --fix"), "ask");
});

Deno.test("deno lint 唯讀旗標仍 allow", () => {
  assertEquals(v("deno lint --json"), "allow");
  assertEquals(v("deno lint --rules"), "allow");
  assertEquals(v("deno lint --compact src/main.ts"), "allow");
});

Deno.test("deno lint 含動態 token 的旗標 asks", () => {
  assertEquals(v("deno lint $FLAG"), "ask");
});

Deno.test("deno test / run / task / compile / eval ask", () => {
  assertEquals(v("deno test"), "ask");
  assertEquals(v("deno test --allow-env src/x_test.ts"), "ask");
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
