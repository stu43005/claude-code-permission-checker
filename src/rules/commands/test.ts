import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 一元**檔案測試**運算子：其操作元是會被讀取 metadata 的檔案路徑。
 *
 * 刻意排除（實測 bash 5.3.9）：
 *   -a  一元時是 -e 的舊別名、二元時是邏輯 AND（語義由參數個數決定）
 *   -o  一元時測 shell option、二元時是邏輯 OR
 *   -t  操作元是 fd 整數，不是路徑
 *   -n -z        操作元是字串
 *   -v -R        操作元是變數名
 */
const FILE_TEST_OPS = new Set([
  "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-L", "-p",
  "-r", "-s", "-S", "-u", "-w", "-x", "-O", "-G", "-N",
]);

/**
 * `test`：只允許「單一一元檔案測試運算子 + 一個操作元」。
 *
 * 參數個數是 POSIX test 的語義關鍵——實測 `test -f` 回 0，因為單參數時 `-f` 只是
 * 「非空字串」而非運算子。故 argv 必須恰為 2 個 token。
 *
 * `[` 不由本規則涵蓋：`[ -f x ]` 的指令名會被 word.ts 的詞法 glob 偵測判為動態
 * （`[` 是 glob 字元），classify 步驟一即回 ask，規則不會被呼叫。
 */
export const testRule: CommandRule = {
  names: ["test"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (ctx.argv.length !== 2) {
      return ask("test：只支援「單一一元檔案測試運算子 + 一個操作元」形態");
    }
    const op = staticValue(ctx.argv[0]);
    if (op === null || !FILE_TEST_OPS.has(op)) {
      return ask("test：運算子未列入一元檔案測試安全集合");
    }
    if (ctx.resolvePath(ctx.argv[1]) !== "in-project") {
      return ask(`test：路徑超出專案範圍或無法靜態解析（${ctx.argv[1].value}）`);
    }
    return allow();
  },
  // 不宣告 cwdIndependent：操作元為相對路徑時依賴 cwd 解析。
};
