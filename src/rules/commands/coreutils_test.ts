import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cdRule, diffRule, fileReaderRule, pureUtilRule } from "./coreutils.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
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

Deno.test("fileReader allows in-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat src/a.ts")).kind, "allow");
});

Deno.test("fileReader asks for out-of-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat /etc/passwd")).kind, "ask");
});

Deno.test("fileReader asks for dynamic path", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat $X")).kind, "ask");
});

Deno.test("pureUtil always allows (no file operands)", () => {
  assertEquals(pureUtilRule.evaluate(ctxOf("echo hello world")).kind, "allow");
  assertEquals(pureUtilRule.evaluate(ctxOf("whoami")).kind, "allow");
});

Deno.test("fileReader scope-checks basename path operand", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("basename src/a.ts")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath /etc/passwd")).kind, "ask");
});

Deno.test("cd always allows", () => {
  assertEquals(cdRule.evaluate(ctxOf("cd /anywhere")).kind, "allow");
});

Deno.test("rules expose expected names", () => {
  assertEquals(fileReaderRule.names.includes("cat"), true);
  assertEquals(pureUtilRule.names.includes("echo"), true);
  assertEquals(cdRule.names, ["cd"]);
});

Deno.test("diff --from-file= out-of-project asks", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff --from-file=/etc/passwd readme.md")).kind, "ask");
});

Deno.test("diff out-of-project positional asks", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff readme.md /etc/passwd")).kind, "ask");
});

Deno.test("diff in-project files allows", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff a.txt b.txt")).kind, "allow");
});

Deno.test("ls -R 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R ~")).kind, "deny");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R /")).kind, "deny");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls --recursive $HOME")).kind, "deny");
});

Deno.test("ls 非遞迴碰根 / cat 碰根 -> 非 deny", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -l ~")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("cat /")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R ./sub")).kind, "allow");
});

Deno.test("realpath flags are scope-checked in the separate-value form too", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to ../out a.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-base ../out a.txt")).kind, "ask");
});

Deno.test("wc --files0-from is scope-checked in both forms", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from=list.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from=../out/list.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from ../out/list.txt")).kind, "ask");
});

Deno.test("realpath --relative-to / --relative-base are scope-checked", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to=sub a.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to=../out a.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-base=../out a.txt")).kind, "ask");
});

Deno.test("diff -X / -S are scope-checked in both forms", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff -X ex.txt a.txt b.txt")).kind, "allow");
  assertEquals(diffRule.evaluate(ctxOf("diff -X ../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -X../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff --starting-file=../out a.txt b.txt")).kind, "ask");
  // 群集寫法無法可靠取值 → 保守 ask（含數字短選項的群集）
  assertEquals(diffRule.evaluate(ctxOf("diff -qX../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -qS../out a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -u0X../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -S ../out a.txt b.txt")).kind, "ask");
});

Deno.test("a recursive root deny outranks a path-value ask", () => {
  assertEquals(
    fileReaderRule.evaluate(ctxOf("ls -R -I x --relative-to=../out /")).kind,
    "deny",
  );
});

Deno.test("head / wc non-path flag values are not treated as paths", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head -n 10")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("head -100")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -l")).kind, "allow");
});

Deno.test("head / wc still scope-check their file operands", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head -100 ../out.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -l ../out.txt")).kind, "ask");
});

Deno.test("unknown head / wc flags ask; other members keep legacy behavior", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head --totally-unknown")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -1unknown")).kind, "ask");
  // cat 沒有 spec，走既有路徑：未知旗標照舊被當一般 flag 跳過
  assertEquals(fileReaderRule.evaluate(ctxOf("cat --totally-unknown a.txt")).kind, "allow");
});

Deno.test("which is never cwd-independent; the other pure utils are", () => {
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("which x")), false);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("echo hi")), true);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("pwd")), true);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("whoami")), true);
});

Deno.test("head / wc declare cwd-independence only with no operands", () => {
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("head -100")), true);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("wc -l")), true);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("head -100 a.txt")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("wc --files0-from=list")), false);
  // 未宣告的成員一律 false
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("cat")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("ls")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("tr a b")), false);
});
