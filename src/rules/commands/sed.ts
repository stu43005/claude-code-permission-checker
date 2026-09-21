import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import type { Word } from "../../deps.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/** sed 的已知旗標。未列入者一律 ask，故新版 sed 新增的旗標不會被誤放行。 */
const NO_VALUE = new Set([
  "-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate",
  "-u", "--unbuffered", "-z", "--null-data", "--posix", "--debug", "--sandbox",
  "--help", "--version",
]);
const ONE_VALUE = new Set(["-e", "--expression", "-l", "--line-length"]);
/** 會就地寫檔或載入不可見腳本；任何形式（含群集、黏寫）出現即 ask。 */
const UNSAFE = new Set(["-i", "--in-place", "-f", "--file"]);

interface SedScan {
  /** 程式碼片段串接；無法靜態取得時為 null。 */
  program: string | null;
  /** 需做範圍檢查的輸入檔。 */
  inputs: Word[];
  /** 第一個未知旗標。 */
  unknownFlag: string | null;
  /** 是否出現 -i / -f（含群集與黏寫形式）。 */
  unsafe: boolean;
  /** 是否含動態 token。 */
  dynamic: boolean;
}

const CACHE = new WeakMap<RuleContext, SedScan>();

/** 每個 RuleContext 只掃描一次；evaluate 與 cwdIndependent 讀同一份結果。 */
function scanSed(ctx: RuleContext): SedScan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doScanSed(ctx);
  CACHE.set(ctx, r);
  return r;
}

function doScanSed(ctx: RuleContext): SedScan {
  const argv = ctx.argv;
  const exprs: string[] = [];
  const positional: Word[] = [];
  let unknownFlag: string | null = null;
  let unsafe = false;
  let dynamic = false;
  let explicitExpr = false;
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
      if (UNSAFE.has(name)) { unsafe = true; continue; }
      if (NO_VALUE.has(name)) { if (eq !== -1) unknownFlag ??= name; continue; }
      if (ONE_VALUE.has(name)) {
        let value = inline;
        if (value === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; continue; }
        }
        if (name === "--expression") { exprs.push(value); explicitExpr = true; }
        continue;
      }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：-i / -f 一旦出現，同 token 剩餘字元歸該旗標，無須再掃
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (UNSAFE.has(short)) { unsafe = true; ate = true; break; }
      if (NO_VALUE.has(short)) continue;
      if (ONE_VALUE.has(short)) {
        const rest = t.slice(k + 1);
        let value: string | null = rest;
        if (rest === "") {
          i++;
          if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; ate = true; break; }
        }
        if (short === "-e" && value !== null) { exprs.push(value); explicitExpr = true; }
        ate = true;
        break;
      }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 未給 -e 時，第一個位置參數是程式碼，其餘是輸入檔；給了 -e 時全部位置參數都是輸入檔。
  let program: string | null;
  let inputs: Word[];
  if (explicitExpr) {
    program = exprs.join("\n");
    inputs = positional;
  } else if (positional.length === 0) {
    program = null;
    inputs = [];
  } else {
    program = staticValue(positional[0]);
    inputs = positional.slice(1);
  }

  return { program, inputs, unknownFlag, unsafe, dynamic };
}

/**
 * sed 程式（隱含第一個非 flag 引數 + 所有 -e）中，下列構造代表寫檔 / 執行：
 * 獨立的 w / W / e / r / R 指令，或 s///… 旗標含 w 或 e。
 * 採保守正則偵測；命中或無法靜態取得程式即 ask。
 */
function programHasSideEffect(program: string): boolean {
  // s/.../.../<flags> 內若含 w 或 e 旗標
  if (/s([^\sa-zA-Z0-9])(?:\\.|[^\\])*?\1(?:\\.|[^\\])*?\1[a-z0-9]*[we]/.test(program)) {
    return true;
  }
  // 獨立的 w/W/e/r/R 指令（行首、分號、或位址後出現），保守偵測
  if (/(^|[;\n{])\s*[0-9$/]*\s*[wWeRr]\b/.test(program)) return true;
  if (/(^|[;\n{])\s*[wWeRr]\s/.test(program)) return true;
  return false;
}

/**
 * cwd 豁免專用的**保守**程式驗證器：只認兩種確定不碰檔案系統的形態。
 *
 * 為什麼不沿用 `programHasSideEffect`：它是 denylist，會漏掉帶位址的形式——
 * `/x/r secret.txt`（讀檔）與 `1,2w out.txt`（寫檔）都不會被它命中，因為其位址字元類
 * 只涵蓋 `[0-9$/]`，遇到 `x` 或 `,` 就中止比對。evaluate 沿用它（維持既有行為、不在本次
 * 變更範圍），但**豁免不能建立在 denylist 上**：一旦跳過 cwd 檢查，漏判就等於放行
 * 專案外的讀寫。此處改用 allowlist，形態不符即不豁免（evaluate 的判定不受影響）。
 *
 * 認可的兩種形態（可用 `;` 串接、可有前後空白）：
 *  1. 行號 / 範圍 + `p` 或 `d`（如 `600,750p`、`1d`、`3,5p;9p`）——純選取輸出；
 *  2. 單一 `s///` 替換，旗標僅限 `g` / `i` / `I` / `p` / 數字——不含會寫檔或執行的 `w` / `e`。
 */
function programSafeForExemption(program: string): boolean {
  const p = program.trim();
  // 形態 1：行號 / 範圍 + p 或 d，可用 `;` 串接。字元集僅數字、逗號、p/d、`;` 與空白，
  // 不可能夾帶檔名或其他指令。
  if (/^(?:\d+(?:,\d+)?\s*[pd]\s*;?\s*)+$/.test(p)) return true;
  return isPureSubstitution(p);
}

/**
 * 形態 2：**單一** s/// 替換，旗標僅限 g / i / I / p / 數字。
 *
 * 以逐字掃描而非正則實作：正則的 `(?:\\.|[^\\])*?` 允許在回溯時跨越未跳脫的
 * 分隔符，於是 `s/a/b/;1,2w out.txt` 這種「替換後面再接一條寫檔指令」會被整段當成一個替換而
 * 誤放行。改為數出**未跳脫分隔符的實際位置**，要求恰好三個、且第三個之後只剩允許的旗標字元，
 * 就不可能夾帶第二條指令。
 */
function isPureSubstitution(p: string): boolean {
  if (p.length < 4 || p[0] !== "s") return false;
  const delim = p[1];
  // 分隔符不可是空白、英數或反斜線（sed 本身也不接受）
  if (/[\sa-zA-Z0-9\\]/.test(delim)) return false;
  const positions: number[] = [];
  for (let i = 1; i < p.length; i++) {
    if (p[i] === "\\") { i++; continue; } // 跳過被跳脫的字元
    if (p[i] === delim) positions.push(i);
  }
  if (positions.length !== 3) return false;
  return /^[giIp0-9]*$/.test(p.slice(positions[2] + 1));
}

export const sedRule: CommandRule = {
  names: ["sed"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const r = scanSed(ctx);
    if (r.unsafe) return ask("sed：-i / -f 可就地寫檔或載入不可見腳本");
    if (r.unknownFlag !== null) return ask(`sed：未列入安全集合的旗標 ${r.unknownFlag}`);
    if (r.dynamic) return ask("sed：含動態 token，無法靜態判定");
    if (r.program === null) return ask("sed：無法靜態取得程式內容");
    if (programHasSideEffect(r.program)) {
      return ask("sed：程式含寫檔 / 執行構造（w/W/e/r 或 s///we）");
    }
    for (const p of r.inputs) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`sed：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
  /**
   * 程式碼已與輸入路徑分離；無輸入路徑、旗標全已知、無 -i/-f，
   * **且程式形態落在極保守的白名單內**時，與 cwd 無關。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scanSed(ctx);
    if (r.unsafe || r.unknownFlag !== null || r.dynamic) return false;
    if (r.program === null || programHasSideEffect(r.program)) return false;
    if (!programSafeForExemption(r.program)) return false;
    return r.inputs.length === 0;
  },
};
