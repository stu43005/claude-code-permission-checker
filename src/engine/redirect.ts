import type { Redirect } from "../deps.ts";
import { staticValue } from "./word.ts";

/** 一律寫檔的運算子（建立 / 覆寫 / 附加檔案）。 */
const WRITE_OPERATORS = new Set<string>([">", ">>", ">|", "&>", "&>>", "<>"]);

/** 目標是否為 null 裝置（無副作用）。 */
function isNullDevice(value: string): boolean {
  const v = value.replace(/\\/g, "/").toLowerCase();
  return v === "/dev/null" || v === "nul";
}

/** target 是否為 fd 數字或關閉符 `-`（代表 fd 複製 / 關閉，非寫檔）。 */
function isFdOrClose(value: string): boolean {
  return /^\d+$/.test(value) || value === "-";
}

/**
 * 單一重導向是否會造成檔案寫入。
 * - `>&`：接檔名 → 寫檔（如 `ls >&out.txt`）；接 fd 數字 / `-` → fd 複製 / 關閉
 *   （如 `2>&1`、`>&2`、`>&-`），非寫檔。`<&` 為輸入複製，永不寫檔。
 * - WRITE_OPERATORS：一律寫檔，但目標為 null 裝置 → 視為無副作用。
 * - 目標為動態（無法靜態確認）→ 保守視為寫檔（ask）。
 */
function isWriteRedirect(r: Redirect): boolean {
  if (r.operator === ">&") {
    if (!r.target) return false;
    const v = staticValue(r.target);
    if (v !== null && isFdOrClose(v)) return false; // fd 複製 / 關閉
    if (v !== null && isNullDevice(v)) return false;
    return true; // 檔名或動態目標 → 寫檔
  }
  if (!WRITE_OPERATORS.has(r.operator)) return false; // 含 `<&`、純輸入運算子
  if (!r.target) return false; // 無檔案目標
  const val = staticValue(r.target);
  if (val !== null && isNullDevice(val)) return false;
  return true;
}

/** 是否存在任一會造成檔案寫入的重導向。 */
export function hasWriteRedirect(redirects: Redirect[]): boolean {
  return redirects.some(isWriteRedirect);
}
