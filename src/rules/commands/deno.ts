import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 使用者授信、自動允許的 deno 子指令（皆不執行任意使用者碼）：
 * - check：型別檢查
 * - lint：靜態檢查（但 `--fix` 會改寫原始碼，需 ask，見下）
 * - info：顯示模組 / 快取資訊（唯讀）
 * 會執行任意碼的子指令（run / task / test / compile / eval / repl / install / serve …）一律 ask；
 * `test` 會執行測試碼，故不在此列。
 */
const ALLOWED_SUBCOMMANDS = new Set<string>(["check", "lint", "info"]);

/** lint 命中即 ask 的旗標：`--fix` 會改寫原始碼（副作用）。 */
function isLintWriteFlag(token: string): boolean {
  return token === "--fix" || token.startsWith("--fix=");
}

export const denoRule: CommandRule = {
  names: ["deno"],
  evaluate(ctx: RuleContext): RuleVerdict {
    // 子指令 = 第一個非旗標 token（跳過子指令前的全域旗標）
    for (let i = 0; i < ctx.argv.length; i++) {
      const t = staticValue(ctx.argv[i]);
      if (t === null) return ask("deno：含動態 token，無法靜態判定子指令");
      if (t.startsWith("-")) continue;
      if (!ALLOWED_SUBCOMMANDS.has(t)) {
        return ask(`deno ${t}：此子指令未自動允許（可能執行任意碼或變更）`);
      }
      // lint 的 `--fix` 會改寫原始碼，需 ask；動態 token 無法判定 → 一律 ask。
      if (t === "lint") {
        for (let j = i + 1; j < ctx.argv.length; j++) {
          const f = staticValue(ctx.argv[j]);
          if (f === null) return ask("deno lint：含動態 token，無法靜態判定旗標");
          if (isLintWriteFlag(f)) return ask("deno lint：`--fix` 會改寫原始碼");
        }
      }
      return allow();
    }
    return ask("deno：未指定子指令");
  },
};
