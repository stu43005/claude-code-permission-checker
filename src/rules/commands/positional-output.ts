import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, type FlagMatcher, positionals } from "../flags.ts";

const XXD_VALUE_FLAGS: FlagMatcher[] = [exact("-s", "-l", "-c", "-g", "-o", "-seek")];
const UNIQ_VALUE_FLAGS: FlagMatcher[] = [
  exact("-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars", "--group", "--all-repeated"),
];

/** `cmd [INPUT [OUTPUT]]`：≥2 個位置參數代表有輸出檔 → ask；否則檢查輸入路徑。 */
function positionalOutputRule(names: string[], valueFlags: FlagMatcher[]): CommandRule {
  return {
    names,
    evaluate(ctx: RuleContext): RuleVerdict {
      const pos = positionals(ctx.argv, valueFlags);
      if (pos.length >= 2) {
        return ask(`${ctx.name}：第二個位置參數為輸出檔（會寫檔）`);
      }
      if (pos.length === 1 && ctx.resolvePath(pos[0]) !== "in-project") {
        return ask(`${ctx.name}：輸入路徑超出專案範圍或無法解析（${pos[0].value}）`);
      }
      return allow();
    },
  };
}

export const xxdRule = positionalOutputRule(["xxd"], XXD_VALUE_FLAGS);
export const uniqRule = positionalOutputRule(["uniq"], UNIQ_VALUE_FLAGS);
