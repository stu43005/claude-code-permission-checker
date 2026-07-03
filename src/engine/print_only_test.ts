import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isAllPrintOnly, isPrintOnlyForm, leafCarrier, printDisguiseDeny, wordPrintEligible } from "./print_only.ts";
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

Deno.test("printf carve-out 涵蓋 length modifier / %q / %n / strftime（避免誤 deny）", () => {
  assertEquals(isPrintOnlyForm(invs('printf "%ld\\n" 42')[0]), false);   // long 數值 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf "%lld" 42')[0]), false);     // long long
  assertEquals(isPrintOnlyForm(invs('printf "%hd" 42')[0]), false);      // short
  assertEquals(isPrintOnlyForm(invs('printf "%q\\n" foo')[0]), false);   // bash shell-quote
  assertEquals(isPrintOnlyForm(invs('printf "%(%Y-%m-%d)T"')[0]), false); // strftime 日期
  assertEquals(isPrintOnlyForm(invs('printf "%s\\n" "結論"')[0]), true);  // %s 純字串 → 仍 print（回歸）
  assertEquals(isPrintOnlyForm(invs('printf "%b" "x"')[0]), true);        // %b 純字串 → 仍 print（回歸）
});

Deno.test("cat heredoc passthrough → print；含真實指令/變數 → 非全鏈 print", () => {
  assertEquals(isAllPrintOnly(invs("cat <<EOF\nhello\nEOF")), true);
  assertEquals(isAllPrintOnly(invs("cat <<'EOF'\n$x\nEOF")), true);      // 引號分隔符 → 靜態
  assertEquals(isAllPrintOnly(invs('cat <<<"x"')), true);                // here-string
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$(echo 假)\nEOF")), true); // body 僅替換 + inner echo
  assertEquals(isAllPrintOnly(invs('cat <<<"$(echo 假)"')), true);        // here-string 替換包裝
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$(rm x)\nEOF")), false);   // inner rm 非 print
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$HOME\nEOF")), false);     // body 變數 → cat 非 print
  assertEquals(isAllPrintOnly(invs('cat <<<"$VAR"')), false);             // here-string 變數
  assertEquals(isAllPrintOnly(invs("cat file")), false);                  // 無 heredoc
  assertEquals(isAllPrintOnly(invs("cat -n <<EOF\nx\nEOF")), true);       // 僅旗標、有 heredoc
  assertEquals(isAllPrintOnly(invs("cat f && echo ok")), false);          // cat 讀真檔 → 非全鏈 print
  // 管線：heredoc 在 brace group 內，外層 pipe python（python 非 print）
  // 注意：unbash 以換行終止 heredoc body，故管線須用 brace group 包裝才能正確解析
  assertEquals(isAllPrintOnly(invs("{ cat <<EOF\nx\nEOF\n} | python")), false);
});

Deno.test("cat fd0 重導向順序（最後者勝）+ -- 操作元", () => {
  // 最後是 < README.md → 讀真實檔 → 非 passthrough
  // 注意：unbash 解析 heredoc 時，額外重導向寫在同一行（<<EOF 後面），body 跟在後面
  assertEquals(isAllPrintOnly(invs("cat <<EOF < README.md\nfake\nEOF")), false);
  // 最後是 heredoc → 印 fake → passthrough（print）
  assertEquals(isAllPrintOnly(invs("cat < README.md <<EOF\nfake\nEOF")), true);
  // -- 後 -fixture 為檔名操作元 → 讀真實檔 → 非 passthrough
  assertEquals(isAllPrintOnly(invs("cat -- -fixture <<EOF\nx\nEOF")), false);
});

Deno.test("tac -s/--separator 吃值不誤判為檔案操作元；cat -s 不吃值（, 為檔名）", () => {
  assertEquals(isAllPrintOnly(invs("tac -s , <<EOF\nfake\nEOF")), true);       // 分隔符值 → passthrough → print
  assertEquals(isAllPrintOnly(invs("tac --separator , <<EOF\nx\nEOF")), true);
  assertEquals(isAllPrintOnly(invs("tac --separator=, <<EOF\nx\nEOF")), true); // 黏寫 → 旗標
  assertEquals(isAllPrintOnly(invs("tac -s, <<EOF\nx\nEOF")), true);           // 黏寫短旗標
  assertEquals(isAllPrintOnly(invs("cat -s , <<EOF\nx\nEOF")), false);         // cat -s 無值 → , 為檔名
  assertEquals(isAllPrintOnly(invs("tac file <<EOF\nx\nEOF")), false);         // 真實檔名 → 非 passthrough
});

Deno.test("heredoc body 不做 glob/brace 展開：字面 glob/brace 仍算靜態 → print；變數/算術 → 非 print", () => {
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n*.txt static\nEOF")), true);        // *.txt 字面
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n*.txt $(echo fake)\nEOF")), true);  // 字面 glob + 替換
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n{1..5} literal\nEOF")), true);      // brace 字面
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$HOME\nEOF")), false);              // 變數 → 非 print（回歸）
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$((1+1))\nEOF")), false);           // 算術 → 非 print
});

Deno.test("tac 動態分隔符值 → 非 print（避免 false deny）；靜態分隔符仍 print", () => {
  assertEquals(isAllPrintOnly(invs('tac -s "$SEP" <<EOF\nfake\nEOF')), false);     // 動態分隔符 → 非 print
  assertEquals(isAllPrintOnly(invs('tac --separator "$X" <<EOF\nx\nEOF')), false); // 動態 → 非 print
  assertEquals(isAllPrintOnly(invs("tac -s , <<EOF\nfake\nEOF")), true);           // 靜態分隔符 → 仍 print（回歸）
});

Deno.test("已接受邊界：\$(<file) 讀檔簡寫 / fd 複製 heredoc → 非全鏈 print（不誤 deny / 安全退回 ask）", () => {
  // $(<file)：unbash 將內層表示為 name=null 指令 → 非 print → 不被 deny（正確：讀真實檔）
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$(<README.md)\nEOF")), false);
  assertEquals(invs("cat <<EOF\n$(<README.md)\nEOF").some((i) => i.name === null), true);
  // fd 複製 heredoc：未模擬 fd 鏈 → 非 passthrough → 漏判 deny 但安全退回 ask
  assertEquals(isAllPrintOnly(invs("cat 3<<EOF\nx\nEOF <&3")), false);
});

const LC_CWD = { kind: "known", path: "/proj" } as const;
function lc(src: string) { return leafCarrier(walk(parseCommand(src).script, LC_CWD, "/proj")[0]); }

Deno.test("leafCarrier: shell 靜態吐字", () => {
  assertEquals(lc("echo hi"), "shell");
  assertEquals(lc("printf '%s\\n' hi"), "shell");
  assertEquals(lc("cat <<'EOF'\nhi\nEOF"), "shell");
  assertEquals(lc("ls"), null);
});

Deno.test("leafCarrier: 直譯器 inline（A）per-language", () => {
  assertEquals(lc(`node -e 'console.log("fake")'`), "interp");
  assertEquals(lc(`python -c 'print("x")'`), "interp");
  assertEquals(lc(`node -p '"fake"'`), "interp");
  assertEquals(lc(`deno eval 'console.log("x")'`), "interp");
  assertEquals(lc(`node -e 'console.log(1+1)'`), null);
  assertEquals(lc(`node -p '1+1'`), null);
  assertEquals(lc(`node -c 'console.log("x")'`), null);   // node 無 -c → 非 inline
  assertEquals(lc(`python -e 'print("x")'`), null);       // python 無 -e
  assertEquals(lc(`node --no-warnings -e 'console.log("x")'`), "interp");
  assertEquals(lc(`node --title -e 'console.log("x")'`), null);        // 分離未知旗標 → 放棄
  assertEquals(lc(`node --require ./p.js -e 'console.log("x")'`), null);
  assertEquals(lc(`node --require=./p.js -e 'console.log("x")'`), null); // =value 注入
  assertEquals(lc(`X=1 node -e 'console.log("x")'`), null);            // 賦值前綴
});

Deno.test("leafCarrier: 直譯器 heredoc-stdin（B）", () => {
  assertEquals(lc(`node <<'EOF'\nconsole.log("x")\nEOF`), "interp");
  assertEquals(lc(`python <<'EOF'\nprint("x")\nEOF`), "interp");
  assertEquals(lc(`deno run - <<'EOF'\nconsole.log("x")\nEOF`), "interp");   // deno run - 為 stdin
  assertEquals(lc(`bun <<'EOF'\nconsole.log("x")\nEOF`), "interp");          // 裸 bun heredoc
  assertEquals(lc(`bun -e 'console.log("x")'`), "interp");
  assertEquals(lc(`ts-node -e 'console.log("x")'`), "interp");
  assertEquals(lc(`node`), null);
  assertEquals(lc(`node < real.js`), null);                                 // fd0 為檔案 → 非靜態 heredoc
  assertEquals(lc(`python < f.py`), null);
  assertEquals(lc(`node <<EOF\n$(ls)\nEOF`), null);                          // 未引號 $() body → 不可具體還原 → 非載具
  assertEquals(lc(`bun run - <<'EOF'\nconsole.log("x")\nEOF`), null);        // bun run - 不特案
});

Deno.test("leafCarrier: 非 deno 的 --allow-* 為未知旗標 → 放棄；deno --allow-* 為 nullary", () => {
  assertEquals(lc(`node --allow-read -e 'console.log("x")'`), null);         // node 無 --allow-read → 放棄
  assertEquals(lc(`deno run --allow-read - <<'EOF'\nconsole.log("x")\nEOF`), "interp"); // deno --allow-read nullary
});

Deno.test("leafCarrier: run 子指令不吃 inline；未知/注入旗標放棄", () => {
  assertEquals(lc(`deno run -e 'console.log("x")'`), null);   // run 模式：-e 非 inline（-e 被當 script 前的未知旗標）
  assertEquals(lc(`bun run -e 'console.log("x")'`), null);
  assertEquals(lc(`bun run -p '"x"'`), null);
  assertEquals(lc(`node --unknown-flag val -e 'console.log("x")'`), null);   // 未知分離旗標 → 放棄
  assertEquals(lc(`node --import=./m.mjs -e 'console.log("x")'`), null);     // =value 注入
  assertEquals(lc(`node --experimental-loader=./l.mjs -e 'console.log("x")'`), null);
  assertEquals(lc(`node --env-file=.env -e 'console.log("x")'`), null);
  assertEquals(lc(`python -m pytest -c 'print("x")'`), null);               // -m 注入
});

Deno.test("leafCarrier: 已知 nullary 為 per-interpreter（別家的旗標 → 放棄）", () => {
  assertEquals(lc(`node --esm -e 'console.log("x")'`), null);        // --esm 非 node nullary → 放棄
  assertEquals(lc(`python --no-warnings -c 'print("x")'`), null);    // --no-warnings 非 python nullary → 放棄
  assertEquals(lc(`ts-node --esm -e 'console.log("x")'`), "interp"); // --esm 是 ts-node nullary → 仍偵測
  assertEquals(lc(`node --no-warnings -e 'console.log("x")'`), "interp"); // node 自家 nullary
});

function pd(src: string): string | null {
  const hit = printDisguiseDeny(parseCommand(src).script, LC_CWD);
  return hit ? hit.kind : null;
}

Deno.test("printDisguiseDeny: 純 shell / 混載具 → deny", () => {
  assertEquals(pd("echo a; echo b"), "shell-print");
  assertEquals(pd(`echo a; node -e 'console.log("b")'`), "interp-inline");
  assertEquals(pd("for x in a b; do echo 假; done"), "shell-print");
});

Deno.test("printDisguiseDeny: 整鏈洗白 → 不 deny", () => {
  assertEquals(pd(`ls; node -e 'console.log("假")'`), null);
  assertEquals(pd("ls; echo 假"), null);
  assertEquals(pd("pwd; echo 假"), null);
  assertEquals(pd("true && echo 已驗證"), null);
  assertEquals(pd("mkdir build && echo done"), null);
  assertEquals(pd("echo 假; ls"), null);
  assertEquals(pd(`node -e 'console.log("x")'; ls`), null);
});

Deno.test("printDisguiseDeny: WRITE→EXEC(a)", () => {
  assertEquals(pd(`cat > /tmp/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode /tmp/x.mjs`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > f; node f`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > fixture.js; node runner.js fixture.js`), null);       // P=argv
  assertEquals(pd(`printf 'x\\n' > fixture.py; python runner.py fixture.py`), null);               // python P=argv
  assertEquals(pd(`echo 'x' > f.ts; deno run runner.ts f.ts`), null);                              // deno P=argv
  assertEquals(pd(`echo 'console.log("x")' > fixture.js; node --loader fixture.js runner.js`), null); // P=旗標值
  assertEquals(pd(`echo 'x' > cfg.json; ts-node --project cfg.json runner.ts`), null);             // ts-node 吃值旗標
  assertEquals(pd(`echo 'x' > im.json; deno run --import-map im.json runner.ts`), null);           // deno 吃值旗標
  assertEquals(pd(`echo 'console.log("f")' > x.mjs; node --experimental-default-type=module x.mjs`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > x.ts; ts-node --transpile-only x.ts`), "write-exec"); // 已知 nullary
  assertEquals(pd(`echo 'console.log("f")' > x.ts; deno run --allow-read x.ts`), "write-exec");    // deno --allow-read nullary
});

Deno.test("printDisguiseDeny: cat-readback 邊界 + config over-deny + 控制流", () => {
  assertEquals(pd(`cat >> q <<'EOF'\nx\nEOF\ncat q`), null);                    // append → 非 WRITE
  assertEquals(pd(`if c; then cat > q <<'EOF'\nx\nEOF\nfi; cat q`), null);      // 跨控制流
  assertEquals(pd(`cat > config.yaml <<'EOF'\nk: v\nEOF\ncat config.yaml`), "cat-readback"); // accepted over-deny
  assertEquals(pd(`if command -v node; then node -e 'console.log("f")'; else echo 假; fi`), null); // guard 非載具
  assertEquals(pd(`if true; then echo 假; fi`), null);                          // clause true 非載具
});

Deno.test("printDisguiseDeny: WRITE→EXEC(b) cat 讀回", () => {
  assertEquals(pd(`cat > /tmp/q.txt <<'EOF'\ndead\nEOF\ncat /tmp/q.txt`), "cat-readback");
  assertEquals(pd(`printf 'x\\n' > q; tac q`), "cat-readback");
  assertEquals(pd(`cat > q <<'EOF'\nx\nEOF\necho hi; cat q`), null);   // 非緊鄰
  assertEquals(pd(`cat > a <<'EOF'\nx\nEOF\ncat b`), null);            // 非同檔
});

Deno.test("printDisguiseDeny: setup 豁免 / false / ! true", () => {
  // heredoc 之後以換行分隔下一指令（`&&` 接在 heredoc 終止行後非法；換行序列同樣傳遞 prevWrite）
  assertEquals(pd(`mkdir -p /tmp && cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(pd(`cd /tmp; cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(pd("false && cat > x && node x"), null);              // false 非 setup/載具 → (a) 失敗
  assertEquals(pd(`! true\ncat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), null); // 否定 true 為非載具葉 → (a) 失敗
});

Deno.test("printDisguiseDeny: pipe（D）", () => {
  assertEquals(pd(`echo 'console.log(1)' | node`), "pipe");
  assertEquals(pd("grep x f | node"), null);
  assertEquals(pd("echo a | cat | node"), null);                      // 三段 → 不配對
  assertEquals(pd("echo 'console.log(1)' | node < real.js"), null);   // fd0 蓋過
  assertEquals(pd("echo 'console.log(1)' | node > out"), null);       // 消費端 stdout 轉走
  assertEquals(pd("node"), null);
  assertEquals(pd("echo 'console.log(1)' | node &"), null);           // 背景 → 跳過 pipe
  assertEquals(pd("{ echo 'console.log(1)' | node; } &"), null);      // 背景複合 → 內層 pipe 亦跳過
  assertEquals(pd("{ echo a | echo b; } > out"), null);               // 整體重導向 → 葉非載具（不誤 deny）
});

Deno.test("printDisguiseDeny: 注入旗標 EXEC → 不配對", () => {
  assertEquals(pd(`echo 'console.log("f")' > x; node --require=./p.js x`), null); // 注入 → EXEC 非 script
  assertEquals(pd(`echo 'console.log("f")' > x; node --require ./p.js x`), null);
});

Deno.test("printDisguiseDeny: 直譯器輸出被轉走 → 非載具、不 deny", () => {
  assertEquals(pd(`node -e 'console.log("x")' > out`), null);        // stdout 寫檔 → 非 stdout 吐字
  assertEquals(pd(`{ node -e 'console.log("x")'; } > out`), null);   // 整體重導向繼承
  assertEquals(pd(`cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x > out`), null); // 複合 EXEC 輸出轉走
  assertEquals(pd(`cat > q <<'EOF'\ndead\nEOF\ncat q > out`), null);              // cat 讀回輸出轉走
});
