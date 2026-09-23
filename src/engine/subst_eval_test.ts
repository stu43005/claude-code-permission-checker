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

const WIN_ONLY = { ignore: Deno.build.os !== "windows" };

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 純轉換旗標求值為操作元原樣",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t unix 'D:/proj')"`), CWD), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath 'D:/proj')"`), CWD), "D:/proj");
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 查檔案系統的旗標不求值",
  fn() {
    // -d / -t dos / -s 都是 DOS 8.3 短名，-l 是長名還原，皆需查檔案系統
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -d 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t dos 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -s 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -l 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -M 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 系統目錄旗標與讀檔旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -D)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -S)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -f list.txt)"`), CWD), null);
    // 輸出形式與 normalizeAbsolute 不保證等價
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -U 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -r /d/proj)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -p /a:/b)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: -a 需要 known cwd；操作元必須恰一個",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), CWD), "sub");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), { kind: "unknown" }), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u a b)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 只有磁碟形式與相對路徑可求值（mount 對映不等價）",
  fn() {
    // 磁碟形式：normalizeAbsolute 認得，等價
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w 'C:\\proj')"`), CWD), "C:\\proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u sub/dir)"`), CWD), "sub/dir");
    // 非磁碟形式的絕對路徑由 MSYS2 mount 表決定實際位置
    // （實測 cygpath -m /usr/bin → C:/Program Files/Git/usr/bin）
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /usr/bin)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /mingw64/bin)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u /tmp)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: -C / -i 可求值；吃值旗標缺值或值無效 → null",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -C UTF8 -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -i -u /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj -C)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj -t)"`), CWD), null);
    // cygpath 會拒絕無效的 codepage，不會輸出路徑
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -C bogus -m /d/proj)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 互斥的輸出格式旗標 → null",
  fn() {
    // cygpath 會拒絕執行，不輸出任何路徑；照樣回傳操作元等於憑空造出 cd 目標
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u -w 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m -t unix 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 反斜線開頭與無分隔符的磁碟前綴 → null",
  fn() {
    // `\d\proj` 在 Windows 是「當前磁碟機根」的絕對路徑，但 applyPath 會當成相對路徑
    assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(cygpath -u '\d\proj')"`), CWD), null);
    // `C:Windows` 是「C 磁碟機的當前目錄」語義，cygpath 會補上分隔符解析成 C:/Windows，
    // 而 applyPath 會把它接到 cwd 之後 → 兩者不同
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a -u 'C:Windows')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 未知旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -Z 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 含 .. 段的操作元 → null",
  fn() {
    // MSYS 先折疊 `..` 再套 mount 表，方向與 normalizeAbsolute 相反
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m '/d/../tmp')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m '/d/..')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m '/d/../d/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w 'C:/a/../b')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(cygpath -w 'C:\a\..\b')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'sub/../x')"`), CWD), null);
    // 檔名中的 `..` 不是獨立段，不受影響
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m '/d/a..b')"`), CWD), "/d/a..b");
  },
});

Deno.test({
  ignore: Deno.build.os === "windows",
  name: "cygpath: 非 Windows 平台一律不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD), null);
  },
});
