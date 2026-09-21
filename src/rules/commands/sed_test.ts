import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { sedRule } from "./sed.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "sed",
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

Deno.test("sed -n print range allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '30,45p' file")).kind, "allow");
});

Deno.test("sed delete to stdout allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '/foo/d' file")).kind, "allow");
});

Deno.test("sed substitution allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/g' file")).kind, "allow");
});

Deno.test("sed -i asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -i.bak asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i.bak 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -f scriptfile asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -f prog.sed file")).kind, "ask");
});

Deno.test("sed s///w write flag asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/w out' file")).kind, "ask");
});

Deno.test("sed w command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n 'w out' file")).kind, "ask");
});

Deno.test("sed e exec command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '1e cat /etc/passwd' file")).kind, "ask");
});

Deno.test("sed allowed form but out-of-project file asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '1,5p' /etc/passwd")).kind, "ask");
});

Deno.test("sed with no static program (dynamic) asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed $PROG file")).kind, "ask");
});

const v = (src: string) => sedRule.evaluate(ctxOf(src)).kind;

Deno.test("unknown sed flags ask", () => {
  assertEquals(v("sed --totally-unknown 'p'"), "ask");
  assertEquals(v("sed -Z 'p'"), "ask");
});

Deno.test("sed -f is caught in every form", () => {
  assertEquals(v("sed -f prog.sed a.txt"), "ask");
  assertEquals(v("sed -fprog.sed a.txt"), "ask");
  assertEquals(v("sed -nfprog.sed a.txt"), "ask"); // 群集 + 黏寫
  assertEquals(v("sed --file=prog.sed a.txt"), "ask");
});

Deno.test("multiple -e expressions are all scanned for side effects", () => {
  assertEquals(v("sed -e 'p' -e 'w out.txt' f.txt"), "ask"); // 第二段寫檔
  assertEquals(v("sed -e 'p' -e '1d' f.txt"), "allow");
});

Deno.test("a separate-value flag does not swallow the program", () => {
  // --line-length 80 之後才是程式碼；若旗標表不一致，80 會被當程式、'w out' 被當輸入檔
  assertEquals(v("sed --line-length 80 'w out' f.txt"), "ask"); // 程式含 w → 寫檔
  assertEquals(v("sed --line-length 80 'p' f.txt"), "allow");
  assertEquals(v("sed -l 80 'p'"), "allow");
});

Deno.test("sed cwdIndependent requires zero input paths and known flags", () => {
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '600,750p'")), true); // 基準集用法
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/g'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p' a.txt")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed --totally-unknown 'p'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -nfprog.sed p")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -i 's/a/b/'")), false);
});

Deno.test("a substitution cannot smuggle a second command past the allowlist", () => {
  // 正則版會因回溯跨越未跳脫的 `/` 而把整段當成一個 s///；逐字掃描不會。
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/;1,2w out.txt'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed 's/a/b/;/x/r secret.txt'`)), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/;s/c/d/'")), false); // 兩條替換也不在白名單
  // 合法的單一替換仍豁免，含非 `/` 分隔符與跳脫的分隔符
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's|a|b|g'")), true);
  // String.raw 才能讓反斜線原樣送進 shell 字串；模板字面值的 `\/` 會退化成 `/`
  assertEquals(sedRule.cwdIndependent!(ctxOf(String.raw`sed 's/a\/b/c/'`)), true);
});

Deno.test("addressed read / write commands never get the exemption", () => {
  // 既有的 programHasSideEffect 是 denylist，漏判這兩種帶位址的形式；
  // 豁免改用 allowlist，故它們一定不豁免（evaluate 的既有判定不在本次變更範圍）。
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed '/x/r secret.txt'`)), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed '1,2w out.txt'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed '/x/e cmd'`)), false);
  // s/// 帶 w 旗標同樣不在白名單內
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/w out.txt'")), false);
});
