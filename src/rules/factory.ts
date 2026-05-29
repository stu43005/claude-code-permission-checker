import type { CommandRule, RuleContext, RuleVerdict } from "./types.ts";
import { allow, ask } from "./types.ts";
import { type FlagMatcher, hasAnyFlag, positionals } from "./flags.ts";

export interface FlagGatedReaderOptions {
  names: string[];
  /** 命中任一即 ask（寫入 / 副作用 flag）。 */
  askFlags?: FlagMatcher[];
  /** 會吃掉下一 token 當值的 flag（供位置參數抽取正確跳過）。 */
  valueFlags?: FlagMatcher[];
  /** ask 時的說明（含指令名）。 */
  askReason?: (name: string) => string;
}

/**
 * 通用唯讀規則：命中 askFlags → ask；否則對位置參數逐一 resolvePath，
 * 任一 out-of-project / dynamic → ask，全部 in-project 才 allow。
 */
export function flagGatedReader(opts: FlagGatedReaderOptions): CommandRule {
  const askFlags = opts.askFlags ?? [];
  const valueFlags = opts.valueFlags ?? [];
  return {
    names: opts.names,
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      for (const arg of positionals(ctx.argv, valueFlags)) {
        const scope = ctx.resolvePath(arg);
        if (scope !== "in-project") {
          return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
        }
      }
      return allow();
    },
  };
}
