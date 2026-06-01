import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 使用者授信、自動允許的 deno 子指令。
 * 注意：`deno test` 會執行測試碼，屬使用者明確授信的範圍；其餘會執行任意碼的
 * 子指令（run / task / compile / eval / repl / install / serve …）一律 ask。
 */
const ALLOWED_SUBCOMMANDS = new Set<string>(["check", "test", "lint"]);

export const denoRule: CommandRule = {
  names: ["deno"],
  evaluate(ctx: RuleContext): RuleVerdict {
    // 子指令 = 第一個非旗標 token（跳過子指令前的全域旗標）
    for (const arg of ctx.argv) {
      const t = staticValue(arg);
      if (t === null) return ask("deno：含動態 token，無法靜態判定子指令");
      if (t.startsWith("-")) continue;
      return ALLOWED_SUBCOMMANDS.has(t)
        ? allow()
        : ask(`deno ${t}：僅 check / test / lint 自動允許`);
    }
    return ask("deno：未指定子指令");
  },
};
