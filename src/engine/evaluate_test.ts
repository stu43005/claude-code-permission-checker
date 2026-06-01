import { assertEquals } from "@std/assert";
import { evaluate } from "./evaluate.ts";
import type { CwdState, Verdict } from "../types.ts";

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
