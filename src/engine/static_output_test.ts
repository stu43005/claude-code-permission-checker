import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { catTacText, echoText, printfText, producerStdout, writtenContent } from "./static_output.ts";

function cmd(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("echoText: 靜態 → 字串；動態/carve-out/~展開 → null", () => {
  assertEquals(echoText(cmd("echo hello world")), "hello world\n");
  assertEquals(echoText(cmd("echo -n hi")), "hi");
  assertEquals(echoText(cmd('echo "$VAR"')), null);
  assertEquals(echoText(cmd('echo -e "a\\tb"')), null);   // -e + 反斜線 → 探測 carve-out
  assertEquals(echoText(cmd("echo ~")), null);            // ~ 家目錄展開 → 非靜態
  assertEquals(printfText(cmd("printf '%s\\n' ~")), null);
  assertEquals(catTacText(cmd("cat <<<~")), null);        // here-string ~ 展開 → 非靜態
});

Deno.test("printfText: 裸 %s/%b → 還原；數值/帶寬度轉換 → null", () => {
  assertEquals(printfText(cmd("printf '%s\\n' hi")), "hi\n");
  assertEquals(printfText(cmd("printf '%s%s' a b")), "ab");     // 循環套用
  assertEquals(printfText(cmd("printf '%d' 5")), null);         // 數值
  assertEquals(printfText(cmd("printf '%10s\\n' hi")), null);   // 帶寬度 → 無法精確還原
});

Deno.test("catTacText: cat 原序、tac 行反轉；here-string 補換行、<<- 去 tab", () => {
  assertEquals(catTacText(cmd("cat <<'EOF'\nA\nB\nEOF")), "A\nB\n");
  assertEquals(catTacText(cmd("tac <<'EOF'\nA\nB\nEOF")), "B\nA\n");
  assertEquals(catTacText(cmd("cat <<<hi")), "hi\n");           // here-string 補換行
  assertEquals(catTacText(cmd("cat file.txt")), null);
});

Deno.test("producerStdout: stdout 被轉走 → null；純 stdout → 字串", () => {
  assertEquals(producerStdout(cmd("echo hi")), "hi\n");
  assertEquals(producerStdout(cmd("echo hi > f")), null);          // 寫檔
  assertEquals(producerStdout(cmd("echo hi >/dev/null")), null);   // null 裝置：stdout 不進 pipe
  assertEquals(producerStdout(cmd("echo hi >&2")), null);          // 轉 stderr
});

Deno.test("catTacText / writtenContent: 含 $() 的 heredoc body → null（無法具體還原）", () => {
  assertEquals(catTacText(cmd("cat <<EOF\n$(ls)\nEOF")), null);
  assertEquals(writtenContent(cmd("cat > f <<EOF\n$(ls)\nEOF")), null);
  assertEquals(writtenContent(cmd("cat > f <<'EOF'\n$(ls)\nEOF")), "$(ls)\n");  // 引號 → 字面
});

Deno.test("writtenContent: 寫檔內容（忽略寫入重導向）", () => {
  assertEquals(writtenContent(cmd("echo 'console.log(1)' > f")), "console.log(1)\n");
  assertEquals(writtenContent(cmd("cat > f <<'EOF'\nX\nEOF")), "X\n");
  assertEquals(writtenContent(cmd("tac > f <<'EOF'\nA\nB\nEOF")), "B\nA\n");
});
