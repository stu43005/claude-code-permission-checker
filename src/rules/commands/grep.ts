import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, hasAnyFlag, type FlagMatcher } from "../flags.ts";

// grep 與 rg 共通：會吃下一 token 當值的 flag。
const VALUE_FLAGS = [
  exact(
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-d", "--directories", "--color", "--colour",
    "-r", "--replace", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-M",
  ),
];

// 短旗標群集含 r/R（如 -rn、-Rl）：僅作用於 grep 家族的遞迴偵測；漏判退回 ask（安全）。
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

/**
 * 對所有位置參數（含 pattern）做範圍檢查。pattern 通常為相對字串 → 落在專案內 →
 * allow；只有 pattern / 檔案看起來是專案外絕對路徑時才 ask（保守、罕見誤判可接受）。
 */
export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  valueFlags: VALUE_FLAGS,
  pathValueFlags: ["-f", "--file"],
  recursive: (n, a) =>
    n === "rg" ||
    hasAnyFlag(a, [
      exact("-r", "-R", "--recursive", "--dereference-recursive"),
      shortClusterHasR,
    ]),
});
