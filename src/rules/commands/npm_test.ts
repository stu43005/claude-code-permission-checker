import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { npmRule } from "./npm.ts";
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

Deno.test("npm: view 帶 registry package spec → allow", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it version")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view marked")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm info markdown-it@14.3.0")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view @scope/pkg@1.2.3")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --json")).kind, "allow");
});

Deno.test("npm: ping / whoami / --version → allow", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm ping")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm whoami")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm --version")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm -v")).kind, "allow");
});

Deno.test("npm: 無操作元的 view 會檢視當前專案 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --json")).kind, "ask");
});

Deno.test("npm: 會輸出本機專案內容的子指令 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm ls")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm outdated")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm explain markdown-it")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm root")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm prefix")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm pkg get name")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm config get registry")).kind, "ask");
});

Deno.test("npm: 有副作用的子指令 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm install")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm version 1.2.3")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm docs markdown-it")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm publish")).kind, "ask");
});

Deno.test("npm: 非 registry spec 的操作元 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view /outside/dir")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ./x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ../x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view file:./x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view https://example.com/x.tgz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view C:/x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ~/x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view -notaflag")).kind, "ask");
});

Deno.test("npm: 帶 tarball 副檔名的裸名會被當成本地檔 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tgz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tar.gz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tar")).kind, "ask");
});

Deno.test("npm: 版本後綴也必須合法（否則是本地目錄 spec）", () => {
  // npm-package-arg 把 `pkg@..` 解析成指向上層目錄的本地 spec
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@..")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@.")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@. "')).kind, "ask"); // 尾隨空白
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@.hidden")).kind, "ask"); // 以 . 開頭是本地目錄
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@@bad")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf('npm view "not a package"')).kind, "ask");
  // 合法的 range / tag 仍放行，含帶空白的 range
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@latest")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@^1.2.3"')).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@>=1.0.0 <2.0.0"')).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@1.0.0 - 2.0.0"')).kind, "allow");
  // 底線與中段的 `..` 都是合法 tag 字元
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@release_candidate")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@release..candidate")).kind, "allow");
});

Deno.test("npm: 旗標後接被 npm 吃掉的值會使操作元消失 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view --json true")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --offline false")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --color always")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --no-color always")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --version false")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view -v false")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --json")).kind, "allow");
});

Deno.test("npm: 安全吃值旗標缺值、空值或被旗標當成值 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp=")).kind, "ask");
  // 關鍵：--otp 不得把後面的危險旗標當成自己的值而讓它躲過檢查
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp --cache=/outside")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp --registry=http://evil")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp 123456")).kind, "allow");
});

Deno.test("npm: 危險旗標 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --prefix /outside")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --userconfig /outside/.npmrc")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --registry http://evil")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it -g")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it -w ws")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --script-shell /bin/sh")).kind, "ask");
});

Deno.test("npm: 未知旗標與動態 token → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --totally-new-flag")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view $X")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm $SUB markdown-it")).kind, "ask");
});
