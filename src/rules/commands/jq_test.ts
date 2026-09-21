import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { jqRule } from "./jq.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

export function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "jq",
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

const v = (src: string) => jqRule.evaluate(ctxOf(src)).kind;
/** 取 ask 的理由字串，用來驗證「哪個 token 被當成什麼」。 */
const why = (src: string) => {
  const r = jqRule.evaluate(ctxOf(src));
  return r.kind === "ask" ? r.reason : "";
};

Deno.test("jq filter is not treated as a path", () => {
  assertEquals(v("jq -r '.[] | select(.type==\"file\") | .name'"), "allow");
  assertEquals(v("jq ."), "allow");
  assertEquals(v("jq '/etc/passwd'"), "allow");
});

Deno.test("jq input files are scope-checked", () => {
  assertEquals(v("jq . data.json"), "allow");
  assertEquals(v("jq . ../outside.json"), "ask");
});

Deno.test("-f makes the FIRST POSITIONAL the program file, wherever -f appears", () => {
  // 路徑檢查先行，故理由字串能證明「哪個 token 被當成 program 檔」。
  // 專案外的 program 檔 → 理由是路徑超範圍，且必須指名該 token
  assertEquals(v("jq -f ../outside.jq data.json"), "ask");
  assertEquals(why("jq -f ../outside.jq data.json").includes("../outside.jq"), true);
  // 旗標寫在位置參數之後也一樣：第一個位置參數才是 program 檔
  assertEquals(why("jq ../outside.jq -f data.json").includes("../outside.jq"), true);
  // -fn 是 -f -n：program 檔仍是第一個位置參數
  assertEquals(why("jq -fn ../outside.jq").includes("../outside.jq"), true);

  // 路徑落在專案內 → 通過路徑檢查，改因「內容不可檢查」而 ask（fail-closed）
  assertEquals(v("jq -f prog.jq data.json"), "ask");
  assertEquals(why("jq -f prog.jq data.json").includes("內容無法檢查"), true);
  assertEquals(v("jq prog.jq --from-file data.json"), "ask");
  assertEquals(v("jq -fn prog.jq"), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -f prog.jq")), false);
});

Deno.test("with -f, the remaining positionals are still checked as input files", () => {
  // data.json 之後的 ../outside.json 是輸入檔，其路徑必須先於 -f 的 fail-closed ask 被回報
  assertEquals(why("jq -f prog.jq ../outside.json").includes("../outside.json"), true);
});

Deno.test("-L accepts an attached value", () => {
  assertEquals(v("jq -L mods '.' data.json"), "allow");
  assertEquals(v("jq -Lmods '.' data.json"), "allow");
  assertEquals(v("jq -L ../outside/mods '.'"), "ask");
  assertEquals(v("jq -L../outside/mods '.'"), "ask");
  // -Ln '.' data.json：`n` 是 -L 的值，`.` 是 filter，data.json 是輸入
  assertEquals(v("jq -Ln '.' data.json"), "allow");
  assertEquals(v("jq -Ln '.' ../outside.json"), "ask");
});

Deno.test("two-value flags scope-check only the file half", () => {
  assertEquals(v("jq --rawfile n data.txt '.'"), "allow");
  assertEquals(v("jq --rawfile n ../outside.txt '.'"), "ask");
  assertEquals(v("jq --slurpfile n ../outside.json '.'"), "ask");
  assertEquals(v("jq --arg name ../outside '.'"), "allow");
  assertEquals(v("jq --argjson n 1 '.'"), "allow");
});

Deno.test("every consumed value must be static", () => {
  assertEquals(v("jq --arg n $V '.'"), "ask");
  assertEquals(v("jq --indent $N '.'"), "ask");
  assertEquals(v("jq --rawfile $N f.txt '.'"), "ask");
  assertEquals(v("jq -L $D '.'"), "ask");
});

Deno.test("--args affects only subsequent positionals", () => {
  assertEquals(v("jq -n '$ARGS.positional' --args ../outside a"), "allow");
  assertEquals(v("jq . ../outside.json --args x"), "ask");
  // 重複 --args：保留第一次的邊界，之後的值仍是資料
  assertEquals(v("jq -n '.' --args ../outside --args x"), "allow");
});

Deno.test("--args cannot hide the -f program file", () => {
  // jq 仍把第一個位置參數當 program 檔讀取，即使 --args 先出現。
  // 理由字串證明它確實被當成路徑檢查，而不是被當成資料字串跳過。
  assertEquals(why("jq --args -f ../outside.jq").includes("../outside.jq"), true);
  assertEquals(v("jq --args -f prog.jq"), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq --args -f prog.jq")), false);
});

Deno.test("jq unknown flags and dynamic tokens ask", () => {
  assertEquals(v("jq --totally-unknown ."), "ask");
  assertEquals(v("jq $FILTER"), "ask");
});

Deno.test("-- terminates option parsing", () => {
  assertEquals(v("jq -- . data.json"), "allow");
  assertEquals(v("jq -- . ../outside.json"), "ask");
});

Deno.test("a filter that loads modules reads files relative to cwd", () => {
  // 實測：jq -n 'include "secret" {search:"."}; s' 會讀出 ./secret.jq 的內容
  assertEquals(v(`jq -n 'include "m" {search:"."}; s'`), "ask");
  assertEquals(v(`jq -n 'import "m" as $x {search:"."}; $x::s'`), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf(`jq -n 'include "m" {search:"."}; s'`)), false);
  // 一般 filter 不受影響
  assertEquals(v("jq -r '.name'"), "allow");
});

Deno.test("jq cwdIndependent requires zero inputs and no path flag", () => {
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name'")), true);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name' a.json")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -f prog.jq")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -L mods '.'")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -n '$ARGS.positional' --args a b")), true);
});
