import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import type { Word } from "../../deps.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * jq 1.8.1：`jq [options] <jq filter> [file...]`。
 * jq 的 filter 語言沒有寫檔或執行外部程式的構造，故只需正確分辨哪些 token 是路徑。
 */
const NO_VALUE_LONG = new Set([
  "--null-input", "--raw-input", "--slurp", "--compact-output", "--raw-output",
  "--raw-output0", "--join-output", "--ascii-output", "--sort-keys", "--color-output",
  "--monochrome-output", "--tab", "--unbuffered", "--stream", "--stream-errors",
  "--seq", "--args", "--jsonargs", "--exit-status", "--binary", "--version",
  "--build-configuration", "--help",
  // --from-file 是布林：它不吃檔名，只把「第一個位置參數」的語義改成 program 檔路徑
  "--from-file",
]);
const NO_VALUE_SHORT = new Set([
  "n", "R", "s", "c", "r", "j", "a", "S", "C", "M", "e", "b", "V", "h",
  "f", // -f 同 --from-file：布林
]);
const ONE_NON_PATH = new Set(["--indent"]);
/** 吃一個路徑值；短形式接受黏寫（`-Lmods` 等於 `-L mods`）。 */
const ONE_PATH = new Set(["-L", "--library-path"]);
const TWO_NON_PATH = new Set(["--arg", "--argjson"]);
/** 吃兩個值，第二個是路徑。 */
const TWO_SECOND_PATH = new Set(["--slurpfile", "--rawfile"]);

interface JqScan {
  /** 需做範圍檢查的路徑：program 檔（-f 時的第一個位置參數）＋ 輸入檔。 */
  paths: Word[];
  /** filter 字串（未由 -f 提供時）；無法靜態取得或由 -f 提供時為 null。 */
  filter: string | null;
  /** program 是否由 -f / --from-file 從檔案載入（其內容本工具讀不到）。 */
  programFromFile: boolean;
  /** 吃路徑值的旗標帶的值（字串）。 */
  pathValues: string[];
  /** 是否用過任何吃路徑的旗標，或 -f（program 檔本身就是路徑）。 */
  pathFlagUsed: boolean;
  /** 第一個未知旗標；全部已知回 null。 */
  unknownFlag: string | null;
  /** 是否含動態 token（含被旗標消費的值）。 */
  dynamic: boolean;
}

const CACHE = new WeakMap<RuleContext, JqScan>();

/** 每個 RuleContext 只掃描一次；evaluate 與 cwdIndependent 讀同一份結果。 */
function scan(ctx: RuleContext): JqScan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doScan(ctx);
  CACHE.set(ctx, r);
  return r;
}

function doScan(ctx: RuleContext): JqScan {
  const argv = ctx.argv;
  const positional: Word[] = [];
  const pathValues: string[] = [];
  let pathFlagUsed = false;
  let unknownFlag: string | null = null;
  let dynamic = false;
  let fromFile = false;
  /** --args / --jsonargs 出現之後才生效，故記下它出現時已有幾個位置參數。 */
  let argsModeFrom = -1;
  let optionsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") { positional.push(argv[i]); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (NO_VALUE_LONG.has(name)) {
        if (inline !== null) { unknownFlag ??= name; continue; }
        if (name === "--from-file") fromFile = true;
        // 重複出現時保留**第一次**的邊界；之後的值一律是資料，不會變回檔案
        if ((name === "--args" || name === "--jsonargs") && argsModeFrom < 0) {
          argsModeFrom = positional.length;
        }
        continue;
      }
      if (ONE_NON_PATH.has(name) || ONE_PATH.has(name)) {
        let value = inline;
        if (value === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; continue; }
        }
        if (ONE_PATH.has(name)) { pathValues.push(value); pathFlagUsed = true; }
        continue;
      }
      if (TWO_NON_PATH.has(name) || TWO_SECOND_PATH.has(name)) {
        // 第一個值：inline 或下一 token
        let first = inline;
        if (first === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          first = staticValue(argv[i]);
          if (first === null) dynamic = true;
        }
        // 第二個值：一定是下一 token
        i++;
        if (i >= argv.length) { unknownFlag ??= name; break; }
        const second = staticValue(argv[i]);
        if (second === null) dynamic = true;
        else if (TWO_SECOND_PATH.has(name)) { pathValues.push(second); pathFlagUsed = true; }
        continue;
      }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：`-f` 是布林；`-L` 吃值且接受黏寫（-Lmods）
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (NO_VALUE_SHORT.has(c)) { if (c === "f") fromFile = true; continue; }
      const short = `-${c}`;
      if (ONE_PATH.has(short)) {
        const rest = t.slice(k + 1);
        let value: string | null = rest;
        if (rest === "") {
          i++;
          if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; ate = true; break; }
        }
        if (value !== null) { pathValues.push(value); pathFlagUsed = true; }
        ate = true;
        break;
      }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 位置參數語義：
  //  - 無 -f：第一個是 filter（不是路徑），其餘是輸入檔；
  //  - 有 -f：第一個是 program **檔案路徑**，其餘是輸入檔；
  //  - --args / --jsonargs 之後出現的位置參數是字串，不是檔案。
  //
  // 關鍵：program 檔的判定**不受 argsMode 影響**。`jq --args -f prog.jq` 中 --args 先出現，
  // 但 jq 仍把第一個位置參數當 program 檔讀取，故它必須無條件納入路徑檢查。
  // filter 僅在「未給 -f」時才是第一個位置參數的內容
  const filter = !fromFile && positional.length > 0 ? staticValue(positional[0]) : null;

  const paths: Word[] = [];
  if (fromFile) {
    if (positional.length > 0) { paths.push(positional[0]); pathFlagUsed = true; }
    // -f 本身即代表「要讀一個 program 檔」，即使該位置參數缺席也標記
    pathFlagUsed = true;
  }
  // 輸入檔：跳過第一個位置參數（filter 或 program 檔），並止於 argsMode 生效處
  const inputStart = 1;
  const inputEnd = argsModeFrom >= 0 ? Math.max(argsModeFrom, inputStart) : positional.length;
  for (let k = inputStart; k < inputEnd; k++) paths.push(positional[k]);

  return { paths, filter, programFromFile: fromFile, pathValues, pathFlagUsed, unknownFlag, dynamic };
}

/**
 * filter 是否含會讀檔的模組構造。
 * `include "m" {search:"."};` 與 `import "m" as $x {search:"."};` 會以 cwd（或 search
 * 指定的目錄）為基準載入 `m.jq` —— 實測 `jq -n 'include "secret" {search:"."}; s'`
 * 確實讀到並輸出了 ./secret.jq 的內容。本工具無法靜態確認其目標落在專案內，故一律 ask。
 * 採保守詞法比對，寧可誤 ask。
 */
function filterReadsModules(filter: string): boolean {
  return /\b(include|import)\b/.test(filter);
}

export const jqRule: CommandRule = {
  names: ["jq"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const r = scan(ctx);
    if (r.dynamic) return ask("jq：含動態 token，無法靜態判定");
    if (r.unknownFlag !== null) return ask(`jq：未列入安全集合的旗標 ${r.unknownFlag}`);
    if (r.filter !== null && filterReadsModules(r.filter)) {
      return ask("jq：filter 含 include / import，會以 cwd 為基準載入 .jq 模組檔");
    }
    // 路徑檢查先行，使理由字串能區分「路徑超範圍」與「路徑合法但內容不可檢查」，
    // 也讓「哪個位置參數被當成 program 檔」可由理由驗證。
    for (const v of r.pathValues) {
      if (ctx.resolvePathValue(v) !== "in-project") {
        return ask(`jq：旗標的路徑值超出專案範圍或無法解析（${v}）`);
      }
    }
    for (const p of r.paths) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`jq：路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    // -f 由檔案載入 program，本工具讀不到其內容，無法執行上面的 include / import 掃描。
    // 落在專案內的 prog.jq 仍可 include 專案外的模組 → fail-closed。
    if (r.programFromFile) {
      return ask("jq：-f 的 program 檔內容無法檢查是否含 include / import");
    }
    return allow();
  },
  /**
   * filter 不是路徑；無任何路徑（含 program 檔）、未用到吃路徑的旗標、
   * 且 filter 不含會讀檔的 include / import 時，與 cwd 無關。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scan(ctx);
    if (r.dynamic || r.unknownFlag !== null || r.programFromFile) return false;
    if (r.filter !== null && filterReadsModules(r.filter)) return false;
    return r.paths.length === 0 && !r.pathFlagUsed;
  },
};
