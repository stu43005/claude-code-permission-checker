import type { Word } from "../deps.ts";
import { staticValue } from "../engine/word.ts";

export type FlagMatcher = (token: string) => boolean;

export const exact = (...names: string[]): FlagMatcher => (t) => names.includes(t);
export const prefix = (...pfx: string[]): FlagMatcher => (t) => pfx.some((p) => t.startsWith(p));

/** 取得 Word 的靜態 token；動態時回傳 null。 */
function tokenOf(w: Word): string | null {
  return staticValue(w);
}

/** argv 中是否有任一 token 命中任一 matcher。 */
export function hasAnyFlag(argv: Word[], matchers: FlagMatcher[]): boolean {
  for (const w of argv) {
    const t = tokenOf(w);
    if (t === null) continue;
    if (matchers.some((m) => m(t))) return true;
  }
  return false;
}

/**
 * 抽取位置參數（非 flag）。`valueFlags` 列出「會吃掉下一個 token 當值」的 flag，
 * 命中時跳過其後一個 token，避免把 flag 的值誤認為位置參數。
 * 以 `-` 開頭的 token 一律視為 flag（含 `--opt=val` 單 token 形式）。
 */
export function positionals(argv: Word[], valueFlags: FlagMatcher[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = tokenOf(argv[i]);
    if (t !== null && t.startsWith("-") && t !== "-" && t !== "--") {
      // 若是「會吃值」的 flag 且值是獨立 token（非 --opt=val 形式），跳過下一個 token
      const takesValue = valueFlags.some((m) => m(t)) && !t.includes("=");
      if (takesValue) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}
