import type { CommandRule, RuleContext, RuleVerdict } from "./types.ts";
import { allow, ask, deny, recursiveRootDenyReason } from "./types.ts";
import { type FlagMatcher, hasAnyFlag, positionals } from "./flags.ts";
import { type PathScope } from "../engine/scope.ts";
import { staticValue } from "../engine/word.ts";
import type { Word } from "../deps.ts";
import { type ArgvParse, type CommandSpec, parseArgv } from "./command_spec.ts";
import { hasGlobstarSegment, mayExpandToOption } from "../engine/glob.ts";

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
  /** 回 true 表示此次呼叫會遞迴遍歷；遍歷根命中危險根時 deny。 */
  recursive?: (name: string, argv: Word[]) => boolean;
  /**
   * 選填：改由 CommandSpec 驅動 argv 分類（每個旗標只描述一次）。
   * 提供 spec 時，valueFlags / pathValueFlags 不再使用，並可 opt-in cwd 豁免述詞。
   * 未提供時，行為與既有完全相同。
   */
  spec?: (name: string, argv: Word[]) => CommandSpec | undefined;
  /** opt-in：spec 解析後無路徑操作元 / 路徑值、非遞迴、旗標全已知時視為 cwd 無關。 */
  cwdIndependentWhenNoPaths?: boolean;
  /** 上述 opt-in 的例外名單（隱含以 cwd 為操作對象者，如 ls）。 */
  cwdDependentNames?: string[];
  /**
   * 述詞的額外前置條件；回 false 即不豁免。供有 askFlags 的規則補上同一條件。
   * 參數是 parseArgv 的結果（與 evaluate 同一份快取），**不是** RuleContext —— 傳 ctx 會
   * 誘使實作重掃 argv，正是單一解析契約要避免的。
   */
  cwdIndependentExtraGuard?: (parse: ArgvParse) => boolean;
}

/**
 * 旗標注入護欄允許旗標 token 使用的字元。排除 `/` `\` `:` `~` 後，被注入旗標吞掉原旗標而使其
 * 生效時，任何黏寫值（`--file=x`、`-fx`）都只能指向 cwd 內的某個檔名。
 */
const SAFE_OPTION_TOKEN = /^[A-Za-z0-9_=.,+-]+$/;

/**
 * glob 危險根閘門（spec 與 legacy 兩條路徑共用），必須先於任何可能回 ask 的檢查。
 * 遞迴（明確旗標、被注入的 -r/-R、或 globstar）時，glob 可能選中磁碟根 / 家目錄根 → 硬 deny；
 * 有注入風險時，其餘 argv 指向危險根者也 deny（注入的遞迴旗標會作用在它們身上）。
 * 不受任何讀取範圍放寬影響，以維持「遞迴遍歷磁碟根/家目錄根 = 硬 deny」。
 */
export function globRootGate(ctx: RuleContext, globWords: Word[], isRecursive: boolean): RuleVerdict | null {
  if (globWords.length === 0) return null;
  const injectable = globWords.some(mayExpandToOption);
  const globstar = globWords.some(hasGlobstarSegment);
  if (!(isRecursive || injectable || globstar)) return null;
  for (const w of globWords) {
    if (ctx.globMaySelectDangerousRoot?.(w) ?? true) return deny(recursiveRootDenyReason(ctx.name, w.value));
  }
  if (injectable) {
    for (const w of ctx.argv) {
      if (!globWords.includes(w) && ctx.isDangerousRoot(w)) return deny(recursiveRootDenyReason(ctx.name, w.value));
    }
  }
  return null;
}

/**
 * 旗標注入護欄（spec 與 legacy 兩條路徑共用）。有「可能展開成旗標」的 glob 時，被注入的旗標可改變
 * 任何其他 token 的解讀（PATTERN 變檔案、`--` 使旗標變檔案、吃值旗標吞掉下一 token），故其餘每個
 * token 都必須能當成路徑且落在範圍內；以 `-` 開頭者另須只含安全字元。
 */
export function injectionGuard(ctx: RuleContext, globWords: Word[]): RuleVerdict | null {
  if (!globWords.some(mayExpandToOption)) return null;
  for (const w of ctx.argv) {
    if (globWords.includes(w)) continue;
    const reason = `${ctx.name}：glob 可能展開成旗標，${w.value} 可能被當成檔案讀取且超出範圍`;
    if (ctx.resolvePath(w) !== "in-project") return ask(reason);
    const t = staticValue(w);
    if (t !== null && t.startsWith("-") && !SAFE_OPTION_TOKEN.test(t)) return ask(reason);
  }
  return null;
}

/** spec 驅動的判定；與 cwdIndependent 共用 parseArgv 的同一份快取結果。 */
function evaluateWithSpec(ctx: RuleContext, spec: CommandSpec): RuleVerdict {
  const p = parseArgv(ctx, spec);
  // 遞迴根 deny 必須先於任何路徑 ask，否則既有硬 deny 會被降級成 ask。
  // 危險根可能藏在被 value-flag 吃掉的位置，故掃描全部 argv token。
  if (p.isRecursive) {
    for (const w of ctx.argv) {
      if (ctx.isDangerousRoot(w)) return deny(recursiveRootDenyReason(ctx.name, w.value));
    }
  }
  const gate = globRootGate(ctx, p.globOperands, p.isRecursive);
  if (gate) return gate;
  if (p.dynamic) return ask(`${ctx.name}：含動態 token，無法靜態判定`);
  if (p.unknownFlag !== null) {
    return ask(`${ctx.name}：未列入安全集合的旗標 ${p.unknownFlag}`);
  }
  for (const v of p.pathValues) {
    if (ctx.resolvePathValue(v) !== "in-project") {
      return ask(`${ctx.name}：旗標的路徑值超出專案範圍或無法解析（${v}）`);
    }
  }
  for (const arg of p.pathOperands) {
    if (ctx.resolvePath(arg) !== "in-project") {
      return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
    }
  }
  for (const arg of p.globOperands) {
    if ((ctx.resolveGlobPath?.(arg) ?? "dynamic") !== "in-project") {
      return ask(`${ctx.name}：glob 路徑超出專案範圍或無法靜態解析（${arg.value}）`);
    }
  }
  return injectionGuard(ctx, p.globOperands) ?? allow();
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
      const spec = opts.spec?.(ctx.name, ctx.argv);
      if (spec) return evaluateWithSpec(ctx, spec);
      // 遞迴根 deny 必須先於任何路徑 ask，否則新增路徑值檢查會把既有硬 deny 降級成 ask。
      // 危險根可能藏在被 value-flag 吃掉的 token 位置，故掃描全部 argv、不限 positionals。
      const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;
      if (isRecursive) {
        for (const w of ctx.argv) {
          if (ctx.isDangerousRoot(w)) {
            return deny(recursiveRootDenyReason(ctx.name, w.value));
          }
        }
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
    cwdIndependent: opts.cwdIndependentWhenNoPaths
      ? (ctx: RuleContext) => {
        if ((opts.cwdDependentNames ?? []).includes(ctx.name)) return false;
        const spec = opts.spec?.(ctx.name, ctx.argv);
        if (!spec) return false; // 無 spec → 不豁免（default-deny）
        const p = parseArgv(ctx, spec); // 與 evaluate 同一份快取結果
        if (opts.cwdIndependentExtraGuard && !opts.cwdIndependentExtraGuard(p)) return false;
        return !p.isRecursive && !p.dynamic && p.unknownFlag === null &&
          p.pathOperands.length === 0 && p.pathValues.length === 0 && p.globOperands.length === 0;
      }
      : undefined,
  };
}
