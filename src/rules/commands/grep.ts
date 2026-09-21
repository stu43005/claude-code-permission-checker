import type { CommandRule } from "../types.ts";
import type { Word } from "../../deps.ts";
import type { CommandSpec, FlagSpec, SeenFlags } from "../command_spec.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, type FlagMatcher, hasAnyFlag } from "../flags.ts";

/** 既有常數，原樣保留：短旗標群集含 r/R（如 -rn、-Rl）代表遞迴。 */
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

/** 既有常數，原樣保留：rgRule 仍使用。 */
const VALUE_FLAGS = [
  exact(
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-d", "--directories", "--color", "--colour",
    "-r", "--replace", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-M",
  ),
];

/**
 * GNU grep 3.0 的旗標。`--color` / `--colour` 的值是選填且只接受黏寫（`--color=auto`），
 * 裸寫時不吃下一個 token —— 若誤設為吃值，`grep --color pat file` 會把 pat 當成它的值、
 * 讓真正的輸入檔被當成 PATTERN 而跳過範圍檢查。
 */
const NO_VALUE = [
  "-E", "--extended-regexp", "-F", "--fixed-strings", "-G", "--basic-regexp",
  "-P", "--perl-regexp", "-i", "--ignore-case", "-y", "-v", "--invert-match",
  "-w", "--word-regexp", "-x", "--line-regexp", "-c", "--count",
  "-l", "--files-with-matches", "-L", "--files-without-match", "-o", "--only-matching",
  "-q", "--quiet", "--silent", "-s", "--no-messages", "-n", "--line-number",
  "-b", "--byte-offset", "-H", "--with-filename", "-h", "--no-filename",
  "-a", "--text", "-I", "-z", "--null-data", "-Z", "--null", "-U", "--binary",
  "-r", "-R", "--recursive", "--dereference-recursive", "--help", "-V", "--version",
];
const ATTACHED_ONLY = ["--color", "--colour"];
const NON_PATH_VALUE = [
  "-m", "--max-count", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-d", "--directories", "--binary-files", "--label",
  "-e", "--regexp", "--include", "--exclude", "--devices",
];
const PATH_VALUE = ["-f", "--file", "--exclude-from"];

const flags: FlagSpec[] = [
  ...NO_VALUE.map((name): FlagSpec => ({ name, value: "none" })),
  ...ATTACHED_ONLY.map((name): FlagSpec => ({ name, value: "attached-only" })),
  ...NON_PATH_VALUE.map((name): FlagSpec => ({ name, value: "required" })),
  ...PATH_VALUE.map((name): FlagSpec => ({ name, value: "required", valueIsPath: true })),
];

/** 由 -e / --regexp / -f / --file 是否出現決定第一個位置參數是 PATTERN 還是 FILE。 */
function positionalsFor(seen: SeenFlags): "paths" | "pattern-then-paths" {
  const byFlag = seen.has("-e") || seen.has("--regexp") ||
    seen.has("-f") || seen.has("--file");
  return byFlag ? "paths" : "pattern-then-paths";
}

/**
 * 遞迴偵測。三種來源都要算進去：
 *  - 旗標本身（`-r` / `-R` / `--recursive` / `--dereference-recursive`，群集寫法由
 *    parser 逐字母展開後也會出現在 seenFlags）；
 *  - `-d recurse` / `--directories=recurse` —— 靠**值**才成立的遞迴；
 *  - `rg` 恆為遞迴。
 * 無操作元時 grep 在遞迴模式下會搜尋 cwd，故此判定同時用於危險根 deny 與 cwd 豁免排除。
 */
function recursiveFor(name: string, seen: SeenFlags, argv: Word[]): boolean {
  if (name === "rg") return true;
  for (const f of ["-r", "-R", "--recursive", "--dereference-recursive"]) {
    if (seen.has(f)) return true;
  }
  // -d / --directories 以**最後一次**出現為準（`grep -d skip -d recurse` 會遞迴）
  if ((seen.get("-d") ?? []).at(-1) === "recurse") return true;
  if ((seen.get("--directories") ?? []).at(-1) === "recurse") return true;
  // 保留既有的 raw-token 掃描作為**聯集**，不可省略。
  // 旗標感知解析會把某些 token 當成前一個旗標的值而不計入 seenFlags —— 例如
  // `grep -e -r /` 的 `-r` 是 `-e` 的 pattern 值。既有實作以 raw 掃描判定為遞迴、
  // 進而對 `/` 回硬 deny；若只依 seenFlags，該硬 deny 會降級成 ask。
  // 兩者取聯集 → 只會多判遞迴（更嚴），不會少判。
  return hasAnyFlag(argv, [
    exact("-r", "-R", "--recursive", "--dereference-recursive"),
    shortClusterHasR,
  ]);
}

function specFor(_name: string, argv: Word[]): CommandSpec {
  return {
    flags,
    positionals: positionalsFor,
    recursive: (name, seen) => recursiveFor(name, seen, argv),
  };
}

export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep"],
  spec: specFor,
  cwdIndependentWhenNoPaths: true,
});

export const rgRule: CommandRule = flagGatedReader({
  names: ["rg"],
  valueFlags: VALUE_FLAGS, // 既有常數，原樣保留
  pathValueFlags: ["-f", "--file"], // 既有設定，原樣保留
  recursive: () => true,
});
