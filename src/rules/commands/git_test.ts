import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { gitRule } from "./git.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "git",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

function v(src: string) {
  return gitRule.evaluate(ctxOf(src)).kind;
}

Deno.test("read subcommands allow", () => {
  assertEquals(v("git status"), "allow");
  assertEquals(v("git log --oneline"), "allow");
  assertEquals(v("git diff HEAD~1"), "allow");
  assertEquals(v("git show abc123"), "allow");
});

Deno.test("write subcommands ask", () => {
  assertEquals(v("git commit -m x"), "ask");
  assertEquals(v("git push"), "ask");
  assertEquals(v("git checkout main"), "ask");
});

Deno.test("global path options before read subcommand still allow at rule level", () => {
  assertEquals(v("git -C sub status"), "allow");
  assertEquals(v("git -c core.pager=cat log"), "allow");
});

Deno.test("branch list allows, branch -d asks", () => {
  assertEquals(v("git branch"), "allow");
  assertEquals(v("git branch -d feature"), "ask");
});

Deno.test("config read allows, config set asks", () => {
  assertEquals(v("git config --get user.name"), "allow");
  assertEquals(v("git config user.name Bob"), "ask");
});

Deno.test("stash list allows, stash push asks", () => {
  assertEquals(v("git stash list"), "allow");
  assertEquals(v("git stash"), "ask");
  assertEquals(v("git stash push"), "ask");
});

Deno.test("remote -v allows, remote add asks", () => {
  assertEquals(v("git remote -v"), "allow");
  assertEquals(v("git remote add origin url"), "ask");
});

Deno.test("unknown / dynamic subcommand asks", () => {
  assertEquals(v("git frobnicate"), "ask");
  assertEquals(v("git $SUB"), "ask");
});

Deno.test("git grep -O / --open-files-in-pager asks (arbitrary pager exec)", () => {
  assertEquals(v("git grep -O pager foo"), "ask");
  assertEquals(v("git grep --open-files-in-pager=touch foo"), "ask");
});

Deno.test("git diff --output= asks (writes file)", () => {
  assertEquals(v("git diff --output=x"), "ask");
});

Deno.test("git grep without -O still allows", () => {
  assertEquals(v("git grep foo"), "allow");
});

Deno.test("git log still allows (no dangerous flags)", () => {
  assertEquals(v("git log"), "allow");
});
