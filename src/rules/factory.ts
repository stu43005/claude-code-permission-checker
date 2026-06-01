import type { CommandRule, RuleContext, RuleVerdict } from "./types.ts";
import { allow, ask } from "./types.ts";
import { type FlagMatcher, hasAnyFlag, positionals } from "./flags.ts";
import { type PathScope } from "../engine/scope.ts";
import { staticValue } from "../engine/word.ts";

export interface FlagGatedReaderOptions {
  names: string[];
  /** 命中任一即 ask（寫入 / 副作用 flag）。 */
  askFlags?: FlagMatcher[];
  /** 會吃掉下一 token 當值的 flag（供位置參數抽取正確跳過）。 */
  valueFlags?: FlagMatcher[];
  /** 吃路徑值的 flag（需做範圍檢查）。 */
  pathValueFlags?: string[];
  /** ask 時的說明（含指令名）。 */
  askReason?: (name: string) => string;
}

/**
 * 檢查吃路徑值的 flag（pathValueFlags）：若路徑超出專案範圍或無法解析則 ask。
 * 支援 `--flag value`、`--flag=value`、`-f value`、`-fvalue`（短旗標緊接值）格式。
 */
function checkPathValueFlags(ctx: RuleContext, names: string[]): RuleVerdict | null {
  if (names.length === 0) return null;
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null || !t.startsWith("-")) continue;
    for (const name of names) {
      let scope: PathScope | null = null;
      if (t === name) {
        const next = argv[i + 1];
        scope = next ? ctx.resolvePath(next) : "dynamic";
        i++;
      } else if (t.startsWith(name + "=")) {
        scope = ctx.resolvePathValue(t.slice(name.length + 1));
      } else if (name.length === 2 && !name.startsWith("--") && t.startsWith(name) && t.length > 2) {
        scope = ctx.resolvePathValue(t.slice(2));
      }
      if (scope !== null) {
        if (scope !== "in-project") {
          return ask(`${ctx.name}：${name} 的路徑值超出專案範圍或無法解析`);
        }
        break;
      }
    }
  }
  return null;
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
      const pathFlagVerdict = checkPathValueFlags(ctx, opts.pathValueFlags ?? []);
      if (pathFlagVerdict) return pathFlagVerdict;
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
