import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { grepRule, rgRule } from "./grep.ts";
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
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
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
  assertEquals(rgRule.evaluate(ctxOf("rg", "rg -A 3 pattern src")).kind, "allow");
});

Deno.test("rule covers aliases", () => {
  assertEquals(grepRule.names.includes("egrep"), true);
  assertEquals(grepRule.names.includes("rg"), false);
  assertEquals(rgRule.names.includes("rg"), true);
});

Deno.test("grep -f out-of-project pattern file asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f /etc/patterns readme.md")).kind, "ask");
});

Deno.test("grep --file= out-of-project asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --file=/etc/x readme.md")).kind, "ask");
});

Deno.test("grep -f in-project pattern file allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f patterns.txt readme.md")).kind, "allow");
});

Deno.test("grep -r / rg 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -r x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -R x ~")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --recursive x $HOME")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rn x /")).kind, "deny");
  assertEquals(rgRule.evaluate(ctxOf("rg", "rg x ~")).kind, "deny");
});

Deno.test("grep 非遞迴碰根 -> 非 deny", () => {
  // `/` 是 PATTERN 不是路徑；`file` 在專案內 → allow（重點是「不是 deny」）
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep / file")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x /")).kind, "ask");
  assertEquals(rgRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");
});

Deno.test("grep 危險根緊跟 -r（被吃值位置）仍 deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo -r /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x -r ~")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo -r $HOME")).kind, "deny");
});

Deno.test("grep PATTERN is not scope-checked", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep /etc/passwd a.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -E 'Retry|backoff'")).kind, "allow");
});

Deno.test("grep files are still scope-checked", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep pat a.txt b.txt")).kind, "allow");
});

Deno.test("with -e / -f every positional is a FILE again", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -e pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --regexp=pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -ie pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f pats.txt ../outside.txt")).kind, "ask");
  // 群集內的 -e 帶黏寫值（含標點 / 數字）也必須算「pattern 由旗標提供」
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rex.y ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -ie1 ../outside.txt")).kind, "ask");
});

Deno.test("--color does not consume the pattern", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color pat ../secret.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color=auto pat a.txt")).kind, "allow");
});

Deno.test("--exclude-from is scope-checked in both forms", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=ex.txt pat a.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=../out.txt pat")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from ../out.txt pat")).kind, "ask");
});

Deno.test("a recursive root deny still wins over a path-value ask", () => {
  assertEquals(
    grepRule.evaluate(ctxOf("grep", "grep -r x / --exclude-from=../out.txt")).kind,
    "deny",
  );
});

Deno.test("unknown grep flags ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --totally-unknown pat")).kind, "ask");
});

Deno.test("value-bearing recursive forms are detected", () => {
  // --directories=recurse / -d recurse 讓 grep 在無操作元時搜尋 cwd
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --directories=recurse x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d recurse x ~")).kind, "deny");
  // 重複出現以最後一次為準
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d skip -d recurse x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d recurse -d skip x /")).kind, "ask");
});

Deno.test("an unknown cluster letter does not lose a recursion flag", () => {
  // -T 未列入旗標表，但 -r 仍須被偵測到，否則既有硬 deny 會降級成 ask
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -Tr x /")).kind, "deny");
});

Deno.test("a recursion flag consumed as a flag value still counts (union with raw scan)", () => {
  // `-r` 在此是 `-e` 的 pattern 值，旗標感知解析不會把它記進 seenFlags；
  // 既有實作靠 raw 掃描判定為遞迴並 deny `/`，此行為必須保留
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -e -r /")).kind, "deny");
});

Deno.test("the pattern flag is detected from the same parse, not a separate scan", () => {
  // `--label -- -e pat` 中的 `--` 是 --label 的值；-e pat 之後 /etc/passwd 仍是 FILE
  assertEquals(
    grepRule.evaluate(ctxOf("grep", "grep --label -- -e pat /etc/passwd")).kind,
    "ask",
  );
});

const HOME = "/home/me";
/** 家目錄被 Read(~/**) 放行 / 磁碟根被 Read(//**) 放行的設定：危險根 deny 不得受其影響。 */
const HOME_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: [HOME], files: [] } };
const ROOT_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: ["/"], files: [] } };

/** 可指定 cwd / home / scope，並綁定 glob 相關方法的 RuleContext。 */
function envCtx(
  name: string,
  src: string,
  env: { cwd?: string; home?: string | null; scope?: ScopeConfig } = {},
): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd: CwdState = { kind: "known", path: env.cwd ?? "/proj" };
  const home = env.home === undefined ? HOME : env.home;
  const scope = env.scope ?? { ...rootScope("/proj"), home };
  return {
    name,
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

Deno.test("grep glob: allow", () => {
  for (
    const src of [
      "grep -n x *.md sub/*.md",
      "grep -rn x --include=*.md .",
      'grep -rn "Nginx 5xx" --include=*.md .',
      'grep -n "careTreatment\\|WebApi\\|webapi" *.md runtime-behavior/*.md',
      'grep "a\\|b" *.md',
      "grep -m 5 x *.md",
      "grep -rn x *.md",
      "grep /outside/secret ./*.md", // 有字面前綴、不會注入 → 不套用注入護欄
    ]
  ) {
    assertEquals(grepRule.evaluate(envCtx("grep", src)).kind, "allow", src);
  }
});

Deno.test("grep glob: ask", () => {
  for (
    const src of [
      "grep *.md f", // glob 在 PATTERN 位置
      "grep -e *.md f", // glob 作為獨立 token 旗標值
      "grep -f *.x f",
      "grep x ../*.md", // 前綴在範圍外
      "grep x /home/m?/a.md", // 非遞迴、無注入 → 不觸發危險根閘門，依一般範圍判定
      // 注入護欄
      "grep /outside/secret *.md",
      "grep *.md -e /outside",
      "grep -e . ?? --label=/../../secret",
      "grep /outside/secret -- *.md", // 護欄不看 --
      "grep -n x *.md --include=*.md", // 裸 glob + 非靜態旗標值
      "grep ?e -e --file=/outside/secret ./safe.txt",
      "grep ?e -e -f/outside/secret ./safe.txt",
      "grep ?e -e --file=C:secret ./safe.txt",
    ]
  ) {
    assertEquals(grepRule.evaluate(envCtx("grep", src)).kind, "ask", src);
  }
});

Deno.test("grep glob: 危險根 deny（不受讀取放寬影響、不被 ask 搶先）", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    for (
      const src of [
        "grep x ?r ~", // 注入 -r
        "grep -r x /home/m?",
        "grep -r x /*",
        "grep x /home/me/**/*.md", // globstar 視為遞迴
      ]
    ) {
      assertEquals(grepRule.evaluate(envCtx("grep", src, { scope })).kind, "deny", src);
    }
    assertEquals(grepRule.evaluate(envCtx("grep", "grep -r x m?", { cwd: "/home", scope })).kind, "deny");
  }
});

Deno.test("grep glob: 磁碟根 glob → deny（含 Read(//C:/**) 放行時）", () => {
  const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
  for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
    for (const src of ["grep -r x C:/*", "grep x C:/**/*.md"]) {
      assertEquals(grepRule.evaluate(envCtx("grep", src, { cwd: "D:/proj", scope })).kind, "deny", src);
    }
  }
});

Deno.test({
  name: "grep glob: Windows 上 /c/* → deny（含 Read(//C:/**) 放行時）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
    for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
      for (const src of ["grep -r x /c/*", "grep x /c/**/*.md"]) {
        assertEquals(grepRule.evaluate(envCtx("grep", src, { cwd: "D:/proj", scope })).kind, "deny", src);
      }
    }
  },
});

Deno.test("grep glob: 未提供 glob 方法的 RuleContext → fail-closed ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -n x src/*.md")).kind, "ask");
});

Deno.test("grep glob: 任何參數位置的 globstar 選中危險根 → deny", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    assertEquals(grepRule.evaluate(envCtx("grep", "grep /home/me/**/*.md file", { scope })).kind, "deny");
    assertEquals(grepRule.evaluate(envCtx("grep", "grep -e /home/me/**/*.md file", { scope })).kind, "deny");
  }
  assertEquals(grepRule.evaluate(envCtx("grep", "grep x src/**/*.md")).kind, "allow");
});
