import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cdRule, diffRule, fileReaderRule, pureUtilRule } from "./coreutils.ts";
import type { RuleContext } from "../types.ts";
import {
  dangerousRoot,
  globMaySelectDangerousRoot,
  resolveGlobPath,
  resolvePath,
  resolvePathValue,
  rootScope,
  type ScopeConfig,
} from "../../engine/scope.ts";
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

const HOME = "/home/me";
const HOME_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: [HOME], files: [] } };
const ROOT_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: ["/"], files: [] } };

/** 可指定 cwd / home / scope，並綁定 glob 相關方法的 RuleContext。 */
function envCtx(
  src: string,
  env: { cwd?: string; home?: string | null; scope?: ScopeConfig } = {},
): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd: CwdState = { kind: "known", path: env.cwd ?? "/proj" };
  const home = env.home === undefined ? HOME : env.home;
  const scope = env.scope ?? { ...rootScope("/proj"), home };
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, cwd, scope),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, home),
    resolveGlobPath: (w) => resolveGlobPath(w, cwd, scope),
    globMaySelectDangerousRoot: (w) => globMaySelectDangerousRoot(w, cwd, home),
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

Deno.test("ls 非遞迴碰根 / cat 碰根 -> 非 deny（tilde 展開後在專案外）", () => {
  // （tilde 展開後在專案外）：shellHome 未知，未加引號的 ~ fail-closed 為 out-of-project -> ask，
  // 不是本測試要驗的「遞迴遍歷」deny，仍屬「非 deny」。
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -l ~")).kind, "ask");
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

Deno.test("head / wc glob: allow", () => {
  for (const src of ["wc -l *.md", "head *.md", "head -n 5 src/*.ts", "wc -l runtime-behavior/*.md"]) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "allow", src);
  }
});

Deno.test("head / wc glob: ask", () => {
  for (
    const src of [
      "wc --files0-from=*.x", // 吃路徑值的旗標，黏寫 glob 不容許
      "head *.md -n /outside/x", // 注入護欄：-n 的值可能被推成檔案
      "head ../*.md",
    ]
  ) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "ask", src);
  }
});

Deno.test("head glob: globstar 選中危險根 → deny", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    assertEquals(fileReaderRule.evaluate(envCtx("head /**/*.md", { scope })).kind, "deny");
  }
});

Deno.test("cat / ls glob: allow", () => {
  for (const src of ["cat src/*.ts", "cat src/**/*.ts", "ls *.md", "ls -la *.md", "ls -lR src"]) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "allow", src);
  }
});

Deno.test("cat / ls glob: ask", () => {
  for (
    const src of [
      "cat ../*.md", // 前綴在範圍外
      "ls .*", // . 開頭 glob 段不合格
      "stat *.md", // 清單外成員
      "cat *.md --x=/../../secret", // 注入護欄：注入 -- 使旗標變檔案
      "ls -la *.md --hide=/../../x",
      "cat /home/me/*.md", // 非遞迴、無注入 → 不觸發閘門，依一般範圍判定
    ]
  ) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "ask", src);
  }
});

Deno.test("cat / ls glob: 危險根 deny（不受讀取放寬影響、不被 ask 搶先）", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    for (
      const src of [
        "ls ?R /", // 注入 -R
        "ls -R /home/me/*",
        "ls -lR /home/me/*",
        "ls -lR /*",
        "cat /home/me/**/*.md", // globstar 視為遞迴
        "ls -lR ~", // 群集遞迴偵測（既有行為收緊）
        "ls -lR /",
      ]
    ) {
      assertEquals(fileReaderRule.evaluate(envCtx(src, { scope })).kind, "deny", src);
    }
  }
});

Deno.test("cat / ls glob: 磁碟根 glob → deny（含 Read(//C:/**) 放行時）", () => {
  const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
  for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
    for (const src of ["ls -R C:/*", "ls -lR C:/*", "cat C:/**/*.md"]) {
      assertEquals(fileReaderRule.evaluate(envCtx(src, { cwd: "D:/proj", scope })).kind, "deny", src);
    }
  }
});

Deno.test({
  name: "cat / ls glob: Windows 上 /c/* → deny（含 Read(//C:/**) 放行時）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
    for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
      for (const src of ["ls -lR /c/*", "cat /c/**/*.md"]) {
        assertEquals(fileReaderRule.evaluate(envCtx(src, { cwd: "D:/proj", scope })).kind, "deny", src);
      }
    }
  },
});
