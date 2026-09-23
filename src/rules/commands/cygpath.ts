import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";
import type { Word } from "../../deps.ts";

/** 形態 A：純字串轉換，不碰檔案系統。不吃值者。 */
const SHAPE_A_VALUELESS = new Set(["-u", "-w", "-m", "-a", "-i", "-U", "-r", "-p", "-h", "-V"]);
/** 形態 A：吃值者（-t 的值另外檢查，dos 屬形態 B）。 */
const SHAPE_A_WITH_VALUE = new Set(["-t", "-C"]);
const SAFE_TYPES = new Set(["unix", "windows", "mixed"]);
/** 形態 B：查詢檔案系統 metadata（短名、長名還原、檔案 mode）。 */
const SHAPE_B = new Set(["-d", "-s", "-l", "-M"]);
/** 形態 C：輸出系統目錄，與輸入無關。不吃值者。 */
const SHAPE_C_VALUELESS = new Set(["-D", "-H", "-O", "-P", "-S", "-W", "-A"]);
/** 形態 C：吃值者。 */
const SHAPE_C_WITH_VALUE = new Set(["-F"]);
/** 一律 ask：讀檔取操作元／選項、行程管理。 */
const ASK_FLAGS = new Set(["-f", "-o", "-c"]);

interface Scan {
  /** 出現任何形態 B 旗標（含 -t dos）。 */
  queriesFs: boolean;
  /** 出現任何形態 C（輸出系統目錄）旗標。 */
  systemDir: boolean;
  /** 出現 -p（操作元是 PATH 列表，不是單一路徑）。 */
  pathList: boolean;
  /** 需要 ask 的理由；null 表示通過。 */
  askReason: string | null;
  operands: Word[];
}

/** 單一 memoized 掃描：evaluate 與 cwdIndependent 讀同一份結果。 */
const CACHE = new WeakMap<RuleContext, Scan>();

function scan(ctx: RuleContext): Scan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const result = doScan(ctx);
  CACHE.set(ctx, result);
  return result;
}

function doScan(ctx: RuleContext): Scan {
  let queriesFs = false;
  let systemDir = false;
  let pathList = false;
  const operands: Word[] = [];
  const argv = ctx.argv;
  const fail = (reason: string): Scan => ({ queriesFs, systemDir, pathList, askReason: reason, operands });

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) return fail("cygpath：含動態 token，無法靜態判定");
    if (!t.startsWith("-") || t === "-") {
      operands.push(argv[i]);
      continue;
    }
    if (ASK_FLAGS.has(t)) {
      return fail(`cygpath：${t} 會從檔案讀取操作元／選項或操作行程`);
    }
    if (SHAPE_B.has(t)) {
      queriesFs = true;
      continue;
    }
    if (t === "-p") {
      pathList = true;
      continue;
    }
    if (SHAPE_C_VALUELESS.has(t)) {
      systemDir = true;
      continue;
    }
    if (SHAPE_A_VALUELESS.has(t)) continue;
    if (SHAPE_A_WITH_VALUE.has(t) || SHAPE_C_WITH_VALUE.has(t)) {
      if (SHAPE_C_WITH_VALUE.has(t)) systemDir = true;
      i++;
      if (i >= argv.length) return fail(`cygpath：${t} 缺少值`);
      const v = staticValue(argv[i]);
      if (v === null) return fail("cygpath：旗標值為動態 token");
      if (t === "-t") {
        // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）；其餘未知值不在 allowlist 內
        if (v === "dos") queriesFs = true;
        else if (!SAFE_TYPES.has(v)) return fail(`cygpath：未列入安全集合的 -t 值 ${v}`);
      }
      continue;
    }
    return fail(`cygpath：未列入安全集合的旗標 ${t}`);
  }
  return { queriesFs, systemDir, pathList, askReason: null, operands };
}

/**
 * cygpath：依旗標分三種形態。
 *
 * 形態 A（純字串轉換）不對操作元做範圍檢查——cygpath 在此形態下只轉換路徑字串的書寫
 * 形式，不開檔、不讀內容，也不回報該路徑的任何檔案系統狀態，故不洩漏「使用者自己打進
 * 指令的字串」以外的資訊。
 *
 * 形態 B（`-d`/`-t dos`/`-s`/`-l`/`-M`）會查詢檔案系統 metadata（實測 `cygpath -d`
 * 對不存在路徑 exit 2、`cygpath -w -l '/c/PROGRA~1'` 回 `C:\Program Files`），
 * 屬 `test -e` 同等級的資訊洩漏，故操作元必須做範圍檢查，且不得享有 cwd 豁免。
 */
export const cygpathRule: CommandRule = {
  names: ["cygpath"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const s = scan(ctx);
    if (s.askReason !== null) return ask(s.askReason);
    // 形態 C 不接受路徑操作元：輸出與輸入無關，給了操作元代表意圖不明
    if (s.systemDir && s.operands.length > 0) {
      return ask("cygpath：輸出系統目錄的形態不接受路徑操作元");
    }
    if (s.queriesFs) {
      // -p 的操作元是以 : / ; 分隔的 PATH 列表，cygpath 會逐項查詢。
      // 整串丟給 resolvePath 會被當成單一路徑而誤判，故與查檔案系統的形態併用時一律 ask。
      if (s.pathList) {
        return ask("cygpath：-p 的操作元是 PATH 列表，無法逐項做範圍檢查");
      }
      for (const op of s.operands) {
        if (ctx.resolvePath(op) !== "in-project") {
          return ask(`cygpath：查詢檔案系統的形態，路徑超出專案範圍（${op.value}）`);
        }
      }
    }
    return allow();
  },
  cwdIndependent(ctx: RuleContext): boolean {
    const s = scan(ctx);
    // 查檔案系統的形態依賴 cwd 解析相對操作元 → 不豁免
    return s.askReason === null && !s.queriesFs;
  },
};
