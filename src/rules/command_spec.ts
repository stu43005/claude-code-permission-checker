import type { Word } from "../deps.ts";
import type { RuleContext } from "./types.ts";
import { staticValue } from "../engine/word.ts";
import { isGlobAttachedValue, parseGlobPath } from "../engine/glob.ts";

/**
 * 旗標吃值的方式：
 *  - "none"：不吃值；帶 `=value` 視為未知形式（保守）。
 *  - "required"：一定吃一個值。支援 `--opt value` / `--opt=value` / `-xvalue`。
 *  - "attached-only"：值為選填，且**只接受黏在 `=` 後面**；裸寫時不吃下一個 token
 *    （GNU grep 的 `--color` 即此形態：`grep --color pat f.txt` 不會吃掉 pat）。
 */
export type FlagValueKind = "none" | "required" | "attached-only";

/** 單一旗標的完整描述：一個旗標只在此描述一次。 */
export interface FlagSpec {
  /** 旗標 token（`-x` 或 `--long`）。短旗標與長旗標各自列一筆。 */
  name: string;
  value: FlagValueKind;
  /** 該值是否為會被讀取的路徑（需做範圍檢查）。僅對 "required" 有意義。 */
  valueIsPath?: boolean;
  /**
   * 黏寫值（`--opt=<glob>`）是否容許含 glob 字元。僅適用於值**不是路徑**的 "required" 長旗標
   * （grep 的 --include / --exclude）。形態由 glob.ts 的 isGlobAttachedValue 判定（單段、無反斜線）。
   */
  valueAcceptsGlob?: boolean;
}

/**
 * 位置參數語義：
 *  - "paths"：全部是會被讀取的檔案路徑。
 *  - "pattern-then-paths"：第一個是 pattern（不是路徑），其餘是路徑。
 */
export type PositionalKind = "paths" | "pattern-then-paths";

/**
 * 旗標名 → 其**所有**出現的值（無值旗標記 null）。
 * 保留全部出現而非只留第一個，因為部分指令以**最後一次**為準
 * （`grep -d skip -d recurse` 實際生效的是 recurse）。
 */
export type SeenFlags = Map<string, (string | null)[]>;

export interface CommandSpec {
  flags: FlagSpec[];
  /**
   * 位置參數語義。可為函式，依**已解析的旗標**動態決定
   * （grep：給了 -e / -f 時第一個位置參數從 PATTERN 變回 FILE）。
   * 傳入的 seenFlags 來自同一次解析，故不會與旗標分類漂移。
   */
  positionals: PositionalKind | ((seenFlags: SeenFlags) => PositionalKind);
  /**
   * 是否支援 legacy 數字短旗標（head -100 / tail -200）。
   * 僅在明確開啟時接受，且**整個 token** 必須是 `-` 加數字；`-100x` 視為未知旗標。
   */
  numericShorthand?: boolean;
  /**
   * 此次呼叫是否遞迴遍歷（用於危險根偵測與 cwd 豁免排除）。
   * 傳入同一次解析的 seenFlags，故 `--directories=recurse`、`-d recurse` 等
   * 「靠旗標值才成立」的遞迴形式也能正確判定。
   */
  recursive?: (name: string, seenFlags: SeenFlags) => boolean;
  /**
   * opt-in：接受合格的 glob 路徑操作元（glob.ts 的 parseGlobPath）。只有經旗標注入分析確認
   * 「任何旗標被注入都無害」的固定清單（grep/egrep/fgrep、head、wc）可開啟。
   */
  globOperands?: boolean;
}

export interface ArgvParse {
  /** 需做 resolvePath 的位置參數。 */
  pathOperands: Word[];
  /** 合格的 glob 路徑操作元（需走 resolveGlobPath）；不含於 pathOperands。 */
  globOperands: Word[];
  /** 非路徑的位置參數（pattern 等）。 */
  nonPathOperands: Word[];
  /** 吃路徑值的旗標所帶的值，需做 resolvePathValue。 */
  pathValues: string[];
  /** 第一個未列入 spec、或形式不符的旗標 token；全部正常時為 null。 */
  unknownFlag: string | null;
  /** argv 中是否有任何非靜態 token。 */
  dynamic: boolean;
  /** 此次呼叫是否遞迴遍歷（由 spec 的 recursive 依「已解析的旗標與值」判定）。 */
  isRecursive: boolean;
  /** 已解析到的旗標：name → 其所有出現的值（無值旗標為 null）。供規則做語義判斷。 */
  seenFlags: SeenFlags;
}

/**
 * 每個 RuleContext 只解析一次。classify 對單一葉指令只建構一個 RuleContext，
 * 並把同一個物件傳給 evaluate 與 cwdIndependent，故兩者拿到的是**同一份**解析結果。
 */
const CACHE = new WeakMap<RuleContext, ArgvParse>();

export function parseArgv(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const result = doParse(ctx, spec);
  CACHE.set(ctx, result);
  return result;
}

function doParse(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const find = (name: string) => spec.flags.find((f) => f.name === name);
  const argv = ctx.argv;
  const positional: Word[] = [];
  const pathValues: string[] = [];
  /**
   * 已解析到的旗標 → 其**所有**出現的值（無值旗標記一個 null）。
   * 必須保留全部而非只留第一個：`grep -d skip -d recurse` 中生效的是**後者**，
   * 只留第一個會漏判遞迴、進而錯誤豁免。
   */
  const seenFlags = new Map<string, (string | null)[]>();
  const see = (name: string, value: string | null) => {
    const arr = seenFlags.get(name);
    if (arr) arr.push(value);
    else seenFlags.set(name, [value]);
  };
  let unknownFlag: string | null = null;
  let dynamic = false;
  let optionsDone = false;
  const globs = new Set<Word>();

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) {
      const w = argv[i];
      // `--include=*.md`：值不是路徑、且 glob 只會展開成同一旗標的不同值 → 記為該旗標，不標 dynamic
      if (!optionsDone) {
        const globFlag = spec.flags.find((s) =>
          s.value === "required" && s.valueAcceptsGlob === true && isGlobAttachedValue(w, s.name)
        );
        if (globFlag) { see(globFlag.name, null); continue; }
      }
      if (spec.globOperands && parseGlobPath(w) !== null) {
        positional.push(w);
        globs.add(w);
        continue;
      }
      dynamic = true;
      continue;
    }

    if (optionsDone || !t.startsWith("-") || t === "-") { positional.push(argv[i]); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      const f = find(name);
      if (!f) { unknownFlag ??= name; continue; }
      if (f.value === "none") {
        if (inline !== null) unknownFlag ??= name;
        else see(name, null);
        continue;
      }
      if (f.value === "attached-only") { see(name, inline); continue; } // 裸寫不吃下一 token
      let value = inline;
      if (value === null) {
        i++;
        if (i >= argv.length) { unknownFlag ??= name; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; continue; }
      }
      see(name, value);
      if (f.valueIsPath) pathValues.push(value);
      continue;
    }

    // legacy 數字短旗標：整個 token 必須是 `-` 加數字
    if (spec.numericShorthand && /^-[0-9]+$/.test(t)) continue;

    // 短旗標群集：逐字母；吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      const f = find(short);
      if (!f) {
        unknownFlag ??= short;
        // 未知字母不中止遞迴偵測：把群集剩餘的每個字母都記進 seenFlags，
        // 否則 `grep -Tr x /`（-T 未列入）會漏掉 -r，使既有的硬 deny 降級成 ask。
        for (let m = k; m < t.length; m++) see(`-${t[m]}`, null);
        ate = true;
        break;
      }
      if (f.value === "none") {
        // `-b=1` 這種形式不合法，保守視為未知
        if (t[k + 1] === "=") { unknownFlag ??= short; ate = true; break; }
        see(short, null);
        continue;
      }
      if (f.value === "attached-only") {
        // 與長旗標分支同一契約：值只接受黏在 `=` 之後；裸寫不吃值、繼續掃群集。
        if (t[k + 1] === "=") { see(short, t.slice(k + 2)); ate = true; break; }
        see(short, null);
        continue;
      }
      const rest = t.slice(k + 1);
      let value: string | null = rest;
      if (rest === "") {
        i++;
        if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; ate = true; break; }
      }
      see(short, value);
      if (f.valueIsPath && value !== null) pathValues.push(value);
      ate = true;
      break;
    }
    if (ate) continue;
  }

  const kind = typeof spec.positionals === "function"
    ? spec.positionals(seenFlags)
    : spec.positionals;
  let pathOperands = positional;
  let nonPathOperands: Word[] = [];
  if (kind === "pattern-then-paths" && positional.length > 0) {
    nonPathOperands = positional.slice(0, 1);
    pathOperands = positional.slice(1);
  }

  // glob 落在非路徑位置（grep 的 PATTERN）→ 展開結果會改變 PATTERN / FILE 分界，無法靜態判定
  if (nonPathOperands.some((w) => globs.has(w))) dynamic = true;
  const globOperands = pathOperands.filter((w) => globs.has(w));
  pathOperands = pathOperands.filter((w) => !globs.has(w));

  return {
    pathOperands,
    globOperands,
    nonPathOperands,
    pathValues,
    unknownFlag,
    dynamic,
    isRecursive: spec.recursive?.(ctx.name, seenFlags) ?? false,
    seenFlags,
  };
}
