import { assertEquals, assertStringIncludes } from "@std/assert";
import { evaluate } from "./evaluate.ts";
import type { CwdState, Verdict } from "../types.ts";
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { EMPTY_READ_SCOPE } from "../permissions/path_scope.ts";
import { EMPTY_DOMAIN_SCOPE } from "../permissions/domain_scope.ts";

const ROOT = "/proj";
const AT_ROOT: CwdState = { kind: "known", path: "/proj" };

const cases: Array<{ cmd: string; want: Verdict; cwd?: CwdState; note: string }> = [
  // 唯讀 allow
  { cmd: "cat src/a.ts", want: "allow", note: "read in-project" },
  { cmd: "sed -n '30,45p' file", want: "allow", note: "sed print range" },
  { cmd: "awk 'NR>=8940 && NR<=9281' file", want: "allow", note: "awk NR filter" },
  { cmd: "git diff", want: "allow", note: "git read" },
  { cmd: "grep -rn TODO src", want: "allow", note: "grep recursive" },
  // null 裝置
  { cmd: "grep foo file 2>/dev/null", want: "allow", note: "null device" },
  { cmd: "cat a > /dev/null 2>&1", want: "allow", note: "null device + fd dup" },
  // 範圍逸出
  { cmd: "cat /etc/passwd", want: "ask", note: "absolute out" },
  { cmd: "cd /tmp && ls", want: "ask", note: "cd out then ls" },
  { cmd: "cat ../secret", want: "ask", note: "relative escape" },
  { cmd: "sed -n '1,5p' /etc/passwd", want: "ask", note: "flag-cond out" },
  { cmd: "awk 'NR<5' /etc/passwd", want: "ask", note: "awk out" },
  { cmd: "xxd /etc/hosts", want: "ask", note: "xxd out" },
  // 寫入
  { cmd: "sed -i 's/a/b/' file", want: "ask", note: "sed -i" },
  { cmd: "git commit -m x", want: "ask", note: "git write" },
  { cmd: "echo hi > out.txt", want: "ask", note: "redirect write" },
  { cmd: "mkdir foo", want: "ask", note: "not in allowlist" },
  // 動態
  { cmd: "cat $FILE", want: "ask", note: "dynamic path" },
  { cmd: "cat $(ls)", want: "ask", note: "command substitution arg" },
  { cmd: "cat *.txt", want: "ask", note: "glob" },
  { cmd: "cd $X && cat f", want: "ask", note: "unknown cwd then relative" },
  // 組合
  { cmd: "cat a | tee b", want: "ask", note: "pipe with non-allowed tee" },
  { cmd: "cat a && rm b", want: "ask", note: "and-or with write" },
  { cmd: "( cat a; mkdir b )", want: "ask", note: "subshell with write" },
  { cmd: "echo $(rm x)", want: "ask", note: "command substitution inner write" },
  // 旗標寫入破綻
  { cmd: "sed 's/a/b/w out' file", want: "ask", note: "sed s///w" },
  { cmd: "sort -o out.txt file", want: "ask", note: "sort -o" },
  { cmd: "yq -i '.a=1' f.yml", want: "ask", note: "yq -i" },
  { cmd: "xxd in out.bin", want: "ask", note: "xxd positional out" },
  { cmd: "uniq in out.txt", want: "ask", note: "uniq positional out" },
  { cmd: "tree -o t.txt", want: "ask", note: "tree -o" },
  { cmd: "date -s '2020-01-01'", want: "ask", note: "date -s" },
  { cmd: "find . -delete", want: "ask", note: "find -delete" },
  { cmd: "awk '{print > \"out\"}' file", want: "ask", note: "awk redirect" },
  { cmd: "awk -f prog.awk file", want: "ask", note: "awk -f" },
  { cmd: "less file", want: "ask", note: "less excluded" },
  // git 指令級路徑
  { cmd: "git --git-dir=/outside/.git status", want: "ask", note: "git-dir out" },
  { cmd: "git --work-tree=/outside status", want: "ask", note: "work-tree out" },
  { cmd: "git -c core.worktree=/outside status", want: "ask", note: "core.worktree out" },
  { cmd: "git -C src status", want: "allow", note: "git -C in-project" },
  { cmd: "git -C /tmp status", want: "ask", note: "git -C out" },
  // 新增安全修補：環境變數賦值前綴 / grep -f 路徑 / diff --from-file / git grep -O
  { cmd: "LD_PRELOAD=/x cat a", want: "ask", note: "LD_PRELOAD env prefix" },
  { cmd: "grep -f /etc/p x", want: "ask", note: "grep -f out-of-project" },
  { cmd: "diff --from-file=/etc/passwd x", want: "ask", note: "diff --from-file out" },
  { cmd: "git grep -O pager foo", want: "ask", note: "git grep -O pager" },
  // 邊界
  { cmd: "# just a comment", want: "allow", note: "no-op" },
  { cmd: "", want: "allow", note: "empty" },
];

for (const c of cases) {
  Deno.test(`evaluate: ${c.note} -> ${c.want}  [${c.cmd}]`, () => {
    const d = evaluate(c.cmd, ROOT, c.cwd ?? AT_ROOT);
    assertEquals(d.verdict, c.want, `${c.cmd}: ${d.reason}`);
  });
}

Deno.test("trusted extension example: a custom allow rule would allow", () => {
  // 信任擴充以加入 allowlist 規則為之（見 allowlist_test）；此處確認 cat allow
  assertEquals(evaluate("cat README.md", ROOT, AT_ROOT).verdict, "allow");
});

function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
}

Deno.test("evaluate: settings allow upgrades a single ask command", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("npm test --silent", ROOT, AT_ROOT, rules).verdict, "allow");
});

Deno.test("evaluate: compound builtin-allow + settings-allow -> allow", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("git diff && npm test", ROOT, AT_ROOT, rules).verdict, "allow");
});

Deno.test("evaluate: compound with one un-allowed command -> ask (weakest link)", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("git diff && rm x", ROOT, AT_ROOT, rules).verdict, "ask");
});

Deno.test("evaluate: no rules arg keeps current behavior", () => {
  assertEquals(evaluate("npm test", ROOT, AT_ROOT).verdict, "ask");
});

function vd(src: string, rules?: PermissionRules) {
  return rules
    ? evaluate(src, ROOT, AT_ROOT, rules).verdict
    : evaluate(src, ROOT, AT_ROOT).verdict;
}

Deno.test("閘②整鏈 print-only → deny（不可由 Bash(echo *) 升級）", () => {
  assertEquals(vd('echo "結論是 X"'), "deny");
  assertEquals(vd('printf "%s\\n" "結論"'), "deny");
  assertEquals(vd("cat <<EOF\nfake\nEOF"), "deny");
  assertEquals(vd("echo a; echo b"), "deny");
  assertEquals(vd('echo "$(echo fake)"'), "deny");
  assertEquals(vd('echo -e "verified"'), "deny");
  assertEquals(vd('echo "結論是 X"', rulesOf({ allow: ["Bash(echo *)"] })), "deny"); // echo 不可升級
  assertEquals(vd('printf "%s\\n" "結論"', rulesOf({ allow: ["Bash(printf *)"] })), "deny"); // printf 不可升級
});

Deno.test("閘② print-only 不被後置函式定義降級；前置真實/no-op 葉指令使其落他閘", () => {
  // 呼叫在前、定義在後，且鏈中無其他葉指令 → 整鏈仍只有 echo "fake" → 閘② deny
  assertEquals(vd('echo "fake"; echo(){ :; }'), "deny");
  // `if false; …` 會讓 walk 額外列舉 `false` 葉指令 → 非整鏈 print；且 echo 被（dead 分支）函式定義
  // 遮蔽 → 落閘③ ask。靜態分析無法判定分支不可達，保守 ask（安全、非靜默 allow）。
  assertEquals(vd("if false; then echo(){ :; }; fi; echo fake"), "ask");
});

Deno.test("非整鏈 print → 不 deny", () => {
  assertEquals(vd("make && echo DONE"), "ask");
  assertEquals(vd('echo -e "a\\tb"'), "allow");                 // carve-out
  assertEquals(vd('printf "%05d\\n" 42'), "ask");               // carve-out（printf 非 allowlist）
});

Deno.test("heredoc body 命令替換經逐一分類（含繼承）；寫檔 heredoc 非 deny", () => {
  // body 內 rm 逐一分類 → ask；且 Bash(cat *) 無法升級 rm（自身與繼承 heredoc 皆然）
  assertEquals(vd("cat <<EOF\n$(rm -rf x)\nEOF"), "ask");
  assertEquals(vd("cat <<EOF\n$(rm -rf x)\nEOF", rulesOf({ allow: ["Bash(cat *)"] })), "ask");
  assertEquals(vd("{ cat; } <<EOF\n$(rm -rf x)\nEOF"), "ask");
  assertEquals(vd("{ cat; } <<EOF\n$(rm -rf x)\nEOF", rulesOf({ allow: ["Bash(cat *)"] })), "ask");
  // 內層 git log 為唯讀子指令 → allow；純變數 heredoc 無命令執行 → allow
  assertEquals(vd("cat <<EOF\n$(git log)\nEOF"), "allow");
  assertEquals(vd("cat <<EOF\n$HOME\nEOF"), "allow");
  // 寫檔 heredoc：`>` 寫入重導向 → 非 print 形態 → 中央寫入規則 ask（非 deny）
  assertEquals(vd("cat > /tmp/x <<EOF\nfake\nEOF"), "ask");
});

Deno.test("閘① 字面 sleep → deny（不受遮蔽/賦值/重導向/升級影響）", () => {
  assertEquals(vd("sleep 5"), "deny");
  assertEquals(vd("sleep"), "deny");
  assertEquals(vd("sleep 0.5"), "deny");
  assertEquals(vd("sleep 5 && make"), "deny");
  assertEquals(vd("sleep 2; echo waiting"), "deny");
  assertEquals(vd("FOO=1 sleep 5"), "deny");
  assertEquals(vd("sleep 5 > out"), "deny");
  assertEquals(vd('echo "$(sleep 5)"'), "deny");
  assertEquals(vd("while true; do sleep 1; done"), "deny");
  assertEquals(vd("for i in 1 2; do sleep 1; done"), "deny");
  assertEquals(vd("sleep 1", rulesOf({ allow: ["Bash(sleep *)"] })), "deny"); // 不可升級
  assertEquals(vd("sleep(){ :; }; sleep 5"), "deny");           // 遮蔽不豁免
  assertEquals(vd("sleep 5; sleep(){ :; }"), "deny");
});

Deno.test("閘① sleep deny 理由透過 pollingDenyReason 傳出", () => {
  const d = evaluate("sleep 5", ROOT, AT_ROOT);
  assertEquals(d.verdict, "deny");
  assertStringIncludes(d.reason, "ScheduleWakeup");
});

Deno.test("閘③ 函式遮蔽 → ask（不可升級）", () => {
  assertEquals(vd("date(){ sleep 5; }; date"), "ask");
  assertEquals(vd("pwd(){ echo fake; }; pwd"), "ask");
  assertEquals(vd("waiter(){ sleep 5; }; waiter"), "ask");
  assertEquals(vd("date(){ sleep 5; }; date", rulesOf({ allow: ["Bash(date *)"] })), "ask");
  assertEquals(vd('echo "$(date(){ rm x; }; date)"'), "ask");   // 替換內定義 + 呼叫
  assertEquals(vd("f(){ :; }; ls -la"), "allow");               // ls 未被遮蔽
  // 刻意保守：同名函式定義即使在呼叫之後（或 dead 分支），仍 ask（over-ask 為安全方向、非 bug）
  assertEquals(vd("ls -la; ls(){ :; }"), "ask");   // 定義在呼叫後
  assertEquals(vd("ls(){ :; }; ls -la"), "ask");   // 定義在呼叫前
  // 對照：異名函式不影響合法指令
  assertEquals(vd("ls -la; cd(){ :; }"), "allow");
});

Deno.test("算術 / test / coproc 內的隱藏指令不再被靜默放行（critical 修補）", () => {
  assertEquals(vd("echo $(( $(rm x) + 1 ))"), "ask");          // rm 現可見 → ask（非 allow）
  assertEquals(vd("echo $(( $(sleep 1) + 1 ))"), "deny");      // 閘① 字面 sleep
  assertEquals(vd("(( $(rm x) ))"), "ask");
  assertEquals(vd("[[ -n $(rm x) ]]"), "ask");
  assertEquals(vd("cat <<EOF\n$(( $(rm x) + 1 ))\nEOF"), "ask");
  assertEquals(vd("echo $(( $(cat /etc/passwd) + 1 ))"), "ask"); // 外部讀取現可見 → ask
});

Deno.test("for/select/case header 內的隱藏指令不再被靜默放行（critical 修補）", () => {
  assertEquals(vd("for x in $(rm x); do git diff; done"), "ask");      // rm 現可見 → ask
  assertEquals(vd("select x in $(rm x); do git diff; done"), "ask");
  assertEquals(vd("case $(rm x) in *) git diff;; esac"), "ask");
  assertEquals(vd("for x in $(sleep 1); do :; done"), "deny");         // 閘① 字面 sleep
  assertEquals(vd("case $(cat /etc/passwd) in *) :;; esac"), "ask");   // 外部讀取現可見
});

Deno.test("已接受繞道：巢狀直譯器 / exec wrapper / 等價等待原語 預設 ask；廣域 allow 可升級", () => {
  // 預設（無對應 permissions.allow）→ ask（葉指令名非 allowlist）
  assertEquals(vd("bash -c 'echo fake'"), "ask");
  assertEquals(vd("eval 'echo fake'"), "ask");
  assertEquals(vd("python -c 'import time; time.sleep(5)'"), "ask");
  assertEquals(vd("read -t 5"), "ask");
  assertEquals(vd("timeout 5 sleep 10"), "ask");
  assertEquals(vd("env sleep 5"), "ask");
  assertEquals(vd("command echo fake"), "ask");
  // 既有升級層：使用者自設廣域 allow → allow（使用者自負；本功能不硬擋）
  assertEquals(vd("bash -c 'echo fake'", rulesOf({ allow: ["Bash(bash *)"] })), "allow");
  assertEquals(vd("timeout 5 sleep 10", rulesOf({ allow: ["Bash(timeout *)"] })), "allow");
});
