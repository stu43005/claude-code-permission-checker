import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { evalSubstitutionWord, resultIsUsable } from "./subst_eval.ts";
import type { CwdState } from "../types.ts";

const CWD: CwdState = { kind: "known", path: "/proj" };

function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("framework: 未註冊的指令名不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(uname -a)"'), CWD), null);
});

Deno.test("framework: 未加引號的 substitution 一律不求值", () => {
  // bash 對未加引號的展開做 word splitting 與空值移除，語義與單一字串不同
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo foo)"), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo -n)"), CWD), null);
});

Deno.test("framework: 混合 word 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo foo)/sub"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "pre$(echo foo)"'), CWD), null);
});

Deno.test("framework: 內層有 pipeline / 多 statement / 重導向 / 賦值前綴皆不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a | tr a b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a; echo b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a > /tmp/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(FOO=1 echo a)"'), CWD), null);
});

Deno.test("framework: 動態 argv 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo $X)"'), CWD), null);
});

Deno.test("framework: argv 含未加引號 tilde 不求值", () => {
  // 外層 substitution 的雙引號不會抑制內層的 tilde expansion
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/"src")"'), CWD), null);
});

Deno.test("framework: 非 substitution 的 word 回 null", () => {
  assertEquals(evalSubstitutionWord(wordOf("cd /proj/src"), CWD), null);
});

Deno.test("framework: 結果過濾述詞", () => {
  // 現有求值器本身都不產生換行，故直接對述詞斷言，確保這兩條過濾規則有被執行到
  assertEquals(resultIsUsable("/proj/src"), true);
  assertEquals(resultIsUsable(""), false);
  assertEquals(resultIsUsable("a\nb"), false);
  assertEquals(resultIsUsable("a\r\nb"), false);
});

Deno.test("dirname: 邊界語義", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b/)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a//b)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname a)"'), CWD), ".");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname ./a)"'), CWD), ".");
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(dirname '')"`), CWD), ".");
});

Deno.test("dirname: 多操作元與旗標不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b /c/d)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname -z /a/b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname)"'), CWD), null);
});

Deno.test("basename: 邊界語義與後綴", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b/)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename a)"'), CWD), "a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b.txt .txt)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -s .txt /a/b.txt)"'), CWD), "b");
});

Deno.test("basename: -a / -z / 操作元過多不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -a /a/b /c/d)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -z /a/b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b .b extra)"'), CWD), null);
});

Deno.test("pwd: 回當前 cwd；帶旗標或 cwd unknown 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), CWD), "/proj");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd -P)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), { kind: "unknown" }), null);
});

Deno.test("echo: 無旗標且操作元不含反斜線才求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo /a/b)"'), CWD), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a b)"'), CWD), "a b");
});

Deno.test("echo: 任何以 - 開頭的 token 與含反斜線的操作元都不求值", () => {
  // -n 在 POSIX mode + xpg_echo 下會被當成操作元輸出（`echo -n x` → `-n x`），
  // 兩個 shell 選項都是執行期狀態，靜態無從區分它是旗標還是字面
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -n /a/b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo -e /a/b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -- /a/b)"'), CWD), null);
  // xpg_echo 為 on 時 bash 預設就解釋反斜線，該狀態同樣靜態不可知
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo '/a\tb')"`), CWD), null);
});

Deno.test("printf: 只求值 '%s' 單一操作元與無 % 無反斜線的純字面", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' /a/b)"`), CWD), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf /a/b)"`), CWD), "/a/b");
});

Deno.test("framework: 加引號但求值為空字串 → null", () => {
  // 與未加引號的 `cd $(echo -n)` 不同：這個通過了引號檢查，真正測到空結果過濾
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -n)"'), CWD), null);
});

Deno.test("framework: 內層加引號的字面 ~ 可求值（引號抑制展開）", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(echo '~')"`), CWD), "~");
});

Deno.test("dirname / basename: 反斜線與磁碟前綴的操作元不求值", () => {
  // GNU coreutils 在 Windows / Cygwin 上也把 `\` 當分隔符，本實作只處理 `/`；
  // 算錯會把一個錯誤的路徑當成 known cwd 交給後續範圍判定，故寧可放棄求值
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(dirname 'C:\Windows\System32')"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(basename 'C:\Windows\System32')"`), CWD), null);
  // 磁碟前綴：GNU 會保留前綴並禁止從磁碟根移除後綴（`basename C: :` → `C:`），
  // 而 `/`-only 的字串切法會得到 `C`，被當成專案內的相對目錄
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(basename 'C:' ':')"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(dirname 'C:/Windows')"`), CWD), null);
});

Deno.test("framework: 求值結果含換行 → null（經由真實求值器）", () => {
  // 引號內的實際換行進入 echo 的操作元，走完求值器後才被結果過濾擋下，
  // 藉此確認 evalSubstitutionWord 確實有套用 resultIsUsable
  assertEquals(evalSubstitutionWord(wordOf("cd \"$(echo 'a\nb')\""), CWD), null);
});

Deno.test("framework: 求值為空字串 → null（經由真實求值器）", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(echo '')"`), CWD), null);
});

Deno.test("printf: 其餘形態不求值", () => {
  // 格式字串永遠解釋反斜線，即使不含 %
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '/a\tb')"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '%s\n' /a/b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' a b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%b' a)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf -v x '%s' a)"`), CWD), null);
});
