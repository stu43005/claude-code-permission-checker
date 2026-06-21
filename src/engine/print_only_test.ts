import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isAllPrintOnly, isPrintOnlyForm, wordPrintEligible } from "./print_only.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import type { CwdState } from "../types.ts";

/** 取 `echo …` 第一個引數 Word。 */
function arg0(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

const START: CwdState = { kind: "known", path: "/proj" };
function invs(src: string) {
  return walk(parseCommand(src).script, START, "/proj");
}

Deno.test("wordPrintEligible: 靜態字面 / 命令替換 → 合格", () => {
  assertEquals(wordPrintEligible(arg0('echo hi')), true);
  assertEquals(wordPrintEligible(arg0('echo "$(echo x)"')), true);
  assertEquals(wordPrintEligible(arg0('echo a$(c)b')), true);
});

Deno.test("wordPrintEligible: 變數 / glob / brace / 混合 → 不合格", () => {
  assertEquals(wordPrintEligible(arg0('echo "$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo "$(c)$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo *$(echo x)')), false); // 頂層未引號 glob Literal
  assertEquals(wordPrintEligible(arg0('echo ?$(c)')), false);      // ? glob + 替換 → 不合格
  assertEquals(wordPrintEligible(arg0('echo *.txt')), false);
  assertEquals(wordPrintEligible(arg0('echo {1..5}')), false);     // brace expansion → 動態
  assertEquals(wordPrintEligible(arg0('echo "*"$(c)')), true);     // 引號保護 glob → 合格
});

Deno.test("wordPrintEligible: 未引號前導 tilde 展開 → 不合格；引號/非前導 tilde → 合格", () => {
  assertEquals(wordPrintEligible(arg0("echo ~")), false);
  assertEquals(wordPrintEligible(arg0("echo ~/file")), false);
  assertEquals(wordPrintEligible(arg0("echo ~root")), false);
  assertEquals(wordPrintEligible(arg0("echo ~/$(c)")), false); // 前導 tilde + 替換
  assertEquals(wordPrintEligible(arg0('echo "~"')), true);     // 引號 → 字面
  assertEquals(wordPrintEligible(arg0("echo '~'")), true);     // 單引號 → 字面
  assertEquals(wordPrintEligible(arg0("echo a~b")), true);     // 非前導 → 字面
});

Deno.test("echo print 形態：靜態 / 替換包裝 → true", () => {
  assertEquals(isPrintOnlyForm(invs('echo "結論"')[0]), true);
  assertEquals(isPrintOnlyForm(invs("echo")[0]), true);            // 無引數
});

Deno.test("echo carve-out 收窄：-e 須含反斜線跳脫才放行", () => {
  assertEquals(isPrintOnlyForm(invs('echo -e "a\\tb"')[0]), false); // 真實跳脫 → 行為探測 → 非 print
  assertEquals(isPrintOnlyForm(invs('echo -e "verified"')[0]), true); // 無跳脫 → 仍 print
  assertEquals(isPrintOnlyForm(invs('echo -E "analysis"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('echo -n "fake"')[0]), true);   // -n 不算 carve-out
});

Deno.test("printf print 形態 + carve-out 收窄", () => {
  assertEquals(isPrintOnlyForm(invs('printf "結論：x\\n"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('printf "%s\\n" "結論"')[0]), true);  // %s 純字串 → 仍 print
  assertEquals(isPrintOnlyForm(invs('printf "%%done\\n"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('printf "%05d\\n" 42')[0]), false);   // 數值轉換 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf "%c" 65')[0]), false);
  assertEquals(isPrintOnlyForm(invs('printf -v result ok')[0]), false);   // -v 賦值 → 非 print
});

Deno.test("前置排除：寫檔 / 賦值 / 變數 → 非 print", () => {
  assertEquals(isPrintOnlyForm(invs("echo hi > out.txt")[0]), false);     // 寫入重導向
  assertEquals(isPrintOnlyForm(invs("FOO=1 echo x")[0]), false);          // 賦值前綴
  assertEquals(isPrintOnlyForm(invs('echo "$VAR"')[0]), false);           // 變數
});

Deno.test("isAllPrintOnly 聚合", () => {
  assertEquals(isAllPrintOnly(invs('echo a; echo b')), true);
  assertEquals(isAllPrintOnly(invs('echo a && echo b')), true);
  assertEquals(isAllPrintOnly(invs('(echo fake)')), true);                // subshell 攤平
  assertEquals(isAllPrintOnly(invs('{ echo a; echo b; }')), true);
  assertEquals(isAllPrintOnly(invs('echo "$(echo fake)"')), true);        // 替換包裝
  assertEquals(isAllPrintOnly(invs('echo "pre $(echo x)"')), true);       // 字面+替換 → 仍 print
  assertEquals(isAllPrintOnly(invs('make && echo DONE')), false);         // make 非 print
  assertEquals(isAllPrintOnly(invs('echo "$(date)"')), false);            // inner date 非 print
  assertEquals(isAllPrintOnly(invs('echo "$(cat real)"')), false);        // inner cat 讀檔非 print
  assertEquals(isAllPrintOnly(invs('echo x | grep y')), false);           // grep 非 print
  assertEquals(isAllPrintOnly(invs('echo data | wc -l')), false);         // wc 非 print
  assertEquals(isAllPrintOnly([]), false);                                // 空 → false
});

Deno.test("print-only 邊界：%b 純字串 / -ne 跳脫 / 數值轉換 / process subst / 變數 / --", () => {
  assertEquals(isPrintOnlyForm(invs('printf "%b" "x"')[0]), true);        // %b 純字串 → print
  assertEquals(isPrintOnlyForm(invs('printf -- "結論\\n"')[0]), true);    // -- 後為 format → print
  assertEquals(isPrintOnlyForm(invs('echo -ne "x\\n"')[0]), false);       // -ne + 反斜線 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf "%.2f" 3.14')[0]), false);    // 數值格式 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf -v x "%s" y')[0]), false);    // -v 賦值 → 非 print
  assertEquals(isPrintOnlyForm(invs('echo <(cmd)')[0]), false);           // process subst → 非合格
  assertEquals(isPrintOnlyForm(invs('echo "a$VAR b"')[0]), false);        // 含變數 → 非合格
});

Deno.test("printf 動態/替換型第一引數 → 保守視為非 print（與 echo 不對稱、刻意；落 ask 非 deny）", () => {
  // printf 第一引數為命令替換時 staticValue 為 null，無法靜態確認它不是選項（如 -v），
  // 故 printf 的命令替換包裝**不**比照 echo 硬 deny，而是非 print 形態 → 落 classify（ask）。
  assertEquals(isPrintOnlyForm(invs('printf "$(echo fake)"')[0]), false);
});
