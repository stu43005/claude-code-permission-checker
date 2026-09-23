import type { Command, Script, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { hasUnquotedLeadingTilde } from "./tilde.ts";

/**
 * 單一指令的靜態求值器。必須是純函式、不碰檔案系統、不丟例外。
 * 任何「輸出可能取決於檔案系統狀態、環境變數或執行期 shell 選項」的情形一律回 null。
 */
export interface SubstEvaluator {
  names: string[];
  /**
   * @param argv 呼叫端已確認全部靜態、且無未加引號 tilde 的引數字串
   * @param cwd  該指令執行時的 cwd（unknown 時需要 cwd 的求值器應回 null）
   */
  evaluate(argv: string[], cwd: CwdState): string | null;
}

/** 去掉尾端斜線（但單一 "/" 保留）。 */
function stripTrailingSlashes(s: string): string {
  let out = s;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** GNU dirname 語義（純字串，不碰檔案系統）。 */
function dirnameOf(value: string): string {
  const s = stripTrailingSlashes(value);
  const idx = s.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return stripTrailingSlashes(s.slice(0, idx));
}

/** GNU basename 語義（純字串，不碰檔案系統）。 */
function basenameOf(value: string, suffix?: string): string {
  const s = stripTrailingSlashes(value);
  if (s === "/") return "/";
  const idx = s.lastIndexOf("/");
  let base = idx === -1 ? s : s.slice(idx + 1);
  if (suffix && suffix !== base && base.endsWith(suffix)) {
    base = base.slice(0, -suffix.length);
  }
  return base;
}

/**
 * 本實作只處理 POSIX 形態的路徑。兩類操作元一律放棄求值，因為算錯的結果會被當成
 * known cwd 用於後續範圍判定：
 *
 *  1. 含 `\`：GNU coreutils 在 Windows / Cygwin 上也把 `\` 當分隔符
 *     （`dirname 'C:\Windows\System32'` → `C:\Windows`），照 `/`-only 邏輯會算成 `.`。
 *  2. 含磁碟前綴（`C:` / `C:/…`）：GNU 在支援磁碟機的平台上會保留該前綴並禁止從磁碟根
 *     移除後綴（`basename C: :` → `C:`），而 `/`-only 的字串切法會得到 `C`。
 */
function isUnsupportedPathForm(value: string): boolean {
  return value.includes("\\") || /^[A-Za-z]:/.test(value);
}

const dirnameEvaluator: SubstEvaluator = {
  names: ["dirname"],
  evaluate(argv) {
    // 旗標（含 -z/--zero）與多操作元一律放棄：-z 改用 NUL 分隔、多操作元逐行輸出
    if (argv.length !== 1) return null;
    if (argv[0].startsWith("-")) return null;
    if (isUnsupportedPathForm(argv[0])) return null;
    return dirnameOf(argv[0]);
  },
};

const basenameEvaluator: SubstEvaluator = {
  names: ["basename"],
  evaluate(argv) {
    if (argv.some(isUnsupportedPathForm)) return null;
    // `basename -s SUFFIX NAME`
    if (argv.length === 3 && argv[0] === "-s") {
      if (argv[2].startsWith("-")) return null;
      return basenameOf(argv[2], argv[1]);
    }
    // `basename NAME` / `basename NAME SUFFIX`
    if (argv.length === 1 || argv.length === 2) {
      if (argv.some((a) => a.startsWith("-"))) return null;
      return basenameOf(argv[0], argv[1]);
    }
    return null;
  },
};

const pwdEvaluator: SubstEvaluator = {
  names: ["pwd"],
  evaluate(argv, cwd) {
    if (argv.length !== 0) return null; // -P 會解 symlink，需碰檔案系統
    if (cwd.kind !== "known") return null;
    return cwd.path;
  },
};

const echoEvaluator: SubstEvaluator = {
  names: ["echo"],
  evaluate(argv) {
    // 連 `-n` 都不接受。bash 在 POSIX mode 且 `xpg_echo` 為 on 時會把 `-n` 當成**操作元**
    // 輸出（`echo -n x` → `-n x`），而這兩個 shell 選項都是執行期狀態、靜態不可知。
    // 求值器的契約是「輸出可能取決於執行期 shell 選項就回 null」，故只接受無旗標形態。
    const operands = argv;
    if (operands.length === 0) return null;
    for (const o of operands) {
      // 任一以 `-` 開頭的 token 一律放棄：它可能是旗標（`-e` 會改變跳脫處理），
      // 也可能因 shell 選項而變成字面操作元。兩種解讀的輸出不同，靜態無從區分。
      if (o.startsWith("-")) return null;
      // 含反斜線時，輸出取決於執行期的 xpg_echo shopt（靜態不可知）→ 放棄
      if (o.includes("\\")) return null;
    }
    return operands.join(" ");
  },
};

const printfEvaluator: SubstEvaluator = {
  names: ["printf"],
  evaluate(argv) {
    if (argv.length === 0) return null;
    const fmt = argv[0];
    // 格式字串永遠解釋反斜線（即使不含 %），故含反斜線一律放棄
    if (fmt.includes("\\")) return null;
    if (fmt.startsWith("-")) return null; // -v var 會賦值而非輸出
    if (fmt === "%s") {
      if (argv.length !== 2) return null; // 格式會重複套用到所有參數
      if (argv[1].includes("\\")) return null;
      return argv[1];
    }
    if (!fmt.includes("%") && argv.length === 1) return fmt;
    return null;
  },
};

/**
 * cygpath 可靜態求值的旗標。
 * 不吃值：-u -w -m -a -i
 * 吃值：  -t <type>（僅 unix|windows|mixed）、-C <codepage>
 * 其餘一律不求值——詳見下方 evaluate 內的分類註解。
 */
const CYGPATH_VALUELESS = new Set(["-u", "-w", "-m", "-a", "-i"]);
const CYGPATH_WITH_VALUE = new Set(["-t", "-C"]);
const CYGPATH_SAFE_TYPES = new Set(["unix", "windows", "mixed"]);

/** 互斥的輸出格式旗標：同時給多個時 cygpath 會拒絕執行，不會輸出任何路徑。 */
const CYGPATH_OUTPUT_MODES = new Set(["-u", "-w", "-m", "-t"]);
/** -C 接受的 codepage 值（其餘值 cygpath 會報錯）。 */
const CYGPATH_CODEPAGES = new Set(["ANSI", "OEM", "UTF8"]);

const cygpathEvaluator: SubstEvaluator = {
  names: ["cygpath"],
  evaluate(argv, cwd) {
    // cygpath 只存在於 Cygwin/MSYS2；求值所依賴的「/d/x ≡ D:/x」也只在 Windows 成立
    // （normalizeAbsolute 的磁碟機正規化以 Deno.build.os 鎖定）。
    if (Deno.build.os !== "windows") return null;

    let needsKnownCwd = false;
    let outputModes = 0;
    const operands: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (!t.startsWith("-")) {
        operands.push(t);
        continue;
      }
      if (CYGPATH_OUTPUT_MODES.has(t)) outputModes++;
      if (CYGPATH_VALUELESS.has(t)) {
        if (t === "-a") needsKnownCwd = true; // 相對路徑以行程 cwd 展開
        continue;
      }
      if (CYGPATH_WITH_VALUE.has(t)) {
        i++;
        if (i >= argv.length) return null;
        // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）；未知類型 cygpath 會報錯
        if (t === "-t" && !CYGPATH_SAFE_TYPES.has(argv[i])) return null;
        // -C 的值必須是 cygpath 認得的 codepage，否則它會報錯而非輸出路徑
        if (t === "-C" && !CYGPATH_CODEPAGES.has(argv[i].toUpperCase())) return null;
        continue;
      }
      // 其餘一律不求值：
      //   -d / -s / -l  短名與長名還原，需查檔案系統（-d 對不存在路徑 exit 2）
      //   -M            回報 binary/text，需查檔案系統
      //   -D -H -O -P -S -W -F -A  輸出系統目錄，與輸入無關
      //   -f / -o       從檔案或 stdin 讀取操作元／選項
      //   -U / -r / -p  輸出形式（/proc/cygdrive、\\?\、PATH 列表）與 normalizeAbsolute 不保證等價
      return null;
    }

    if (operands.length !== 1) return null;
    if (needsKnownCwd && cwd.kind !== "known") return null;
    // 輸出格式旗標互斥：`cygpath -u -w x` 會被 cygpath 拒絕、不輸出路徑，
    // 若這裡照樣回傳操作元，等於憑空造出一個並不存在的 cd 目標。
    if (outputModes > 1) return null;
    // 只有磁碟形式與相對路徑可回原樣：-u/-w/-m 對它們只改變磁碟機與斜線的書寫形式，
    // 而呼叫端的 applyPath 隨即 normalizeAbsolute，D:/x、D:\x、/d/x 會正規化成同一字串。
    // 其餘絕對路徑會經 MSYS2 mount 表對映（實測 `cygpath -m /usr/bin` →
    // `C:/Program Files/Git/usr/bin`），normalizeAbsolute 不懂 mount 表 → 必須放棄。
    if (!isNormalizationEquivalent(operands[0])) return null;
    return operands[0];
  },
};

/**
 * 該路徑經 cygpath 轉換後，是否與 normalizeAbsolute 的語義等價。
 * 成立的三種形態：Windows 磁碟絕對（X:/ 或 X:\）、MSYS 磁碟形式（/x 或 /x/…）、相對路徑。
 * 其餘以 `/` 開頭者由 MSYS2 mount 表決定實際位置，不等價。
 */
function isNormalizationEquivalent(p: string): boolean {
  // 含獨立 `..` 段一律放棄。MSYS 先折疊 POSIX `..` 再套 mount 表，normalizeAbsolute 則是
  // 先把 `/d` 轉成 `D:` 再折疊——兩者可能落在完全不同的目錄：實測
  // `cygpath -m '/d/../tmp'` → `C:/Users/…/AppData/Local/Temp`（MSYS 的 /tmp 掛載點），
  // 而 normalizeAbsolute('/d/../tmp') 會得到 `D:/tmp`。此外含 `..` 時 cygpath 還會查檔案系統
  // （實測 `cygpath -m '/d/proj/../x'` 在該路徑不存在時報 "No such file or directory"），
  // 本身就不符合純靜態求值的契約。
  if (p.replace(/\\/g, "/").split("/").some((seg) => seg === "..")) return false;
  // 磁碟前綴必須接分隔符。`C:Windows`（無分隔符）在 Windows 是「該磁碟機的當前目錄」語義，
  // cygpath 會補上分隔符解析成 C:/Windows，而 applyPath 會把它當相對路徑接到 cwd 之後。
  if (/^[A-Za-z]:/.test(p)) return /^[A-Za-z]:[/\\]/.test(p);
  // 反斜線開頭（`\d\proj`）在 Windows 是「當前磁碟機根」的絕對路徑，但 applyPath 會把它
  // 當成相對路徑接到 cwd 之後 → 兩者指向不同目錄，不可求值。
  if (p.startsWith("\\")) return false;
  if (!p.startsWith("/")) return true; // 相對路徑
  return /^\/[A-Za-z](\/|$)/.test(p); // /x 或 /x/…
}

/** 已註冊的求值器。指令名重複註冊會在載入時丟錯。 */
const EVALUATORS: SubstEvaluator[] = [
  dirnameEvaluator,
  basenameEvaluator,
  pwdEvaluator,
  echoEvaluator,
  printfEvaluator,
  cygpathEvaluator,
];

const INDEX = new Map<string, SubstEvaluator>();
for (const e of EVALUATORS) {
  for (const n of e.names) {
    if (INDEX.has(n)) throw new Error(`duplicate substitution evaluator for: ${n}`);
    INDEX.set(n, e);
  }
}

/** 內層 Script 若恰為「單一簡單指令、無重導向、無賦值前綴、非背景」則回該 Command。 */
function loneSimpleCommand(script: Script | undefined): Command | null {
  if (!script) return null;
  if (script.commands.length !== 1) return null;
  const stmt = script.commands[0];
  if (stmt.background) return null;
  if (stmt.redirects.length > 0) return null;
  const cmd = stmt.command;
  if (cmd.type !== "Command") return null; // pipeline / 控制流 / subshell 一律不求值
  if (cmd.redirects.length > 0) return null;
  if (cmd.prefix.length > 0) return null; // 賦值前綴可改變執行行為
  return cmd;
}

/**
 * 整個 Word 恰為單一 `"$(…)"` 且內層可靜態求值時回結果字串，否則 null。
 *
 * **只接受加了雙引號的形態**：未加引號的 `$(…)` 會被 bash 施以 word splitting 與
 * 空值移除，語義與「求值成單一字串」不同——`cd $(echo -n)` 展開後是零個參數，
 * 實際執行 `cd`（→ $HOME），而非 cd 到空字串。
 */
export function evalSubstitutionWord(word: Word, cwd: CwdState): string | null {
  const parts = word.parts;
  // 資格 1 + 2：恰一個 DoubleQuoted，其內恰一個 CommandExpansion
  if (!parts || parts.length !== 1) return null;
  const quoted = parts[0];
  if (quoted.type !== "DoubleQuoted") return null;
  if (quoted.parts.length !== 1) return null;
  const expansion = quoted.parts[0];
  if (expansion.type !== "CommandExpansion") return null;

  // 資格 3：內層是單一簡單指令
  const cmd = loneSimpleCommand(expansion.script);
  if (cmd === null) return null;

  // 資格 4：指令名靜態且已註冊
  if (!cmd.name) return null;
  const name = staticValue(cmd.name);
  if (name === null) return null;
  const evaluator = INDEX.get(name);
  if (!evaluator) return null;

  // 資格 5：argv 全靜態，且無未加引號 tilde
  const argv: string[] = [];
  for (const w of cmd.suffix) {
    if (hasUnquotedLeadingTilde(w)) return null;
    const v = staticValue(w);
    if (v === null) return null;
    argv.push(v);
  }

  // 資格 6～8
  const out = evaluator.evaluate(argv, cwd);
  if (out === null) return null;
  return resultIsUsable(out) ? out : null;
}

/**
 * 求值結果是否可用。
 * 空字串沒有安全的解釋（bash 語義依引號與否而異：加引號是 cd 到空字串、未加引號是 cd 到 $HOME）；
 * 含換行的多行輸出作為 cd 目標無意義。兩者一律放棄。
 */
export function resultIsUsable(out: string): boolean {
  if (out === "") return false;
  return !out.includes("\n") && !out.includes("\r");
}
