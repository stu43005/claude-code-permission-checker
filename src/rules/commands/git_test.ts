import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { gitRule } from "./git.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import { evaluate } from "../../engine/evaluate.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "git",
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
  assertEquals(v("git -c core.pager=cat log"), "ask"); // core.pager can execute arbitrary programs
});

Deno.test("git -c with unsafe config key asks (arbitrary exec)", () => {
  assertEquals(v("git -c diff.external=touch diff"), "ask");
  assertEquals(v("git -c core.pager=cat log"), "ask");
});

Deno.test("git -c with safe config keys allows", () => {
  assertEquals(v("git -c color.ui=false log"), "allow");
  assertEquals(v("git -c core.quotepath=false status"), "allow");
  assertEquals(v("git -c core.worktree=sub status"), "allow");
});

Deno.test("git diff --ext-diff asks (external diff driver exec)", () => {
  assertEquals(v("git diff --ext-diff"), "ask");
});

Deno.test("git show -c is combined-diff flag (after subcommand), not global config", () => {
  assertEquals(v("git show -c HEAD"), "allow");
});

Deno.test("git --exec-path asks (prepends PATH, can hijack pager -> arbitrary exec)", () => {
  assertEquals(v("git --exec-path=/evil log"), "ask");
  assertEquals(v("git --exec-path=/evil status"), "ask");
  assertEquals(v("git -p --exec-path=/evil log"), "ask");
  assertEquals(v("git --exec-path log"), "ask"); // value-less query form
});

Deno.test("benign global value options before read subcommand still allow", () => {
  assertEquals(v("git --namespace=foo log"), "allow");
  assertEquals(v("git --super-prefix=foo/ status"), "allow");
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

// ── New tests for global option allowlist ──────────────────────────────────

Deno.test("git --config-env asks (injects config from env var -> arbitrary exec)", () => {
  assertEquals(v("git --config-env=core.pager=EVIL log"), "ask");
  assertEquals(v("git --config-env core.pager=EVIL log"), "ask");
});

Deno.test("git --exec-path (bare, no value) asks", () => {
  // --exec-path with no value is a query form; still dangerous (can hijack)
  assertEquals(v("git --exec-path log"), "ask");
});

Deno.test("git unknown global option asks", () => {
  assertEquals(v("git --frobnicate log"), "ask");
  assertEquals(v("git --upload-pack=/tmp/x fetch"), "ask");
});

Deno.test("git safe valueless global options allow with read subcommands", () => {
  assertEquals(v("git -p log"), "allow");
  assertEquals(v("git --no-pager status"), "allow");
  assertEquals(v("git --paginate diff"), "allow");
  assertEquals(v("git --literal-pathspecs status"), "allow");
  assertEquals(v("git --no-literal-pathspecs status"), "allow");
  assertEquals(v("git --glob-pathspecs status"), "allow");
  assertEquals(v("git --noglob-pathspecs status"), "allow");
  assertEquals(v("git --icase-pathspecs status"), "allow");
  assertEquals(v("git --no-optional-locks status"), "allow");
  assertEquals(v("git --bare status"), "allow");
  assertEquals(v("git --no-replace-objects log"), "allow");
});

Deno.test("git safe value global options (space form) allow with read subcommands", () => {
  assertEquals(v("git --namespace foo log"), "allow");
  assertEquals(v("git --super-prefix x/ status"), "allow");
});

Deno.test("git safe value global options (= form) allow with read subcommands", () => {
  assertEquals(v("git --namespace=foo log"), "allow");
  assertEquals(v("git --super-prefix=x/ status"), "allow");
  assertEquals(v("git --attr-source=file log"), "allow");
});

Deno.test("git -C in-project subdir allows at rule level", () => {
  assertEquals(v("git -C sub status"), "allow");
});

Deno.test("git log -p (subcommand flag, not global) still allows", () => {
  assertEquals(v("git log -p"), "allow");
});

Deno.test("git show -c HEAD (subcommand flag, not global -c) still allows", () => {
  assertEquals(v("git show -c HEAD"), "allow");
});

Deno.test("git -p log (global --paginate short form before subcommand) allows", () => {
  assertEquals(v("git -p log"), "allow");
});

Deno.test("git --no-pager status allows", () => {
  assertEquals(v("git --no-pager status"), "allow");
});

Deno.test("git -C /tmp status asks (out-of-project path, via full pipeline)", () => {
  // cwd.ts range check handles this via classify.ts, not the git rule itself.
  // Use the full evaluate() pipeline to confirm end-to-end behavior.
  const cwd = { kind: "known" as const, path: "/proj" };
  assertEquals(evaluate("git -C /tmp status", "/proj", cwd).verdict, "ask");
});
