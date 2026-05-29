import type { Command, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { isAbsolute, normalizeAbsolute } from "./scope.ts";

const UNKNOWN: CwdState = { kind: "unknown" };

export function isCd(cmd: Command): boolean {
  return cmd.name ? staticValue(cmd.name) === "cd" : false;
}

/** 把單一靜態路徑接到目前 cwd 上；動態 / cwd 未知 → unknown。 */
function applyPath(cwd: CwdState, value: string): CwdState {
  if (isAbsolute(value)) return { kind: "known", path: normalizeAbsolute(value) };
  if (cwd.kind === "unknown") return UNKNOWN;
  const base = cwd.path.endsWith("/") ? cwd.path : cwd.path + "/";
  return { kind: "known", path: normalizeAbsolute(base + value.replace(/\\/g, "/")) };
}

/** `cd` 之後的新 threaded cwd。無參數（=$HOME）或動態參數 → unknown。 */
export function applyCd(cmd: Command, cwd: CwdState): CwdState {
  if (cmd.suffix.length === 0) return UNKNOWN; // cd 無參數 = $HOME
  const val = staticValue(cmd.suffix[0]);
  if (val === null) return UNKNOWN;
  return applyPath(cwd, val);
}

/** 取得緊接在 flag 之後的值：支援 `--opt=val` 與 `--opt val` / `-C val`。 */
function optionValue(argv: Word[], i: number, token: string): { value: string | null; consumedNext: boolean } {
  const eq = token.indexOf("=");
  if (eq >= 0) return { value: token.slice(eq + 1), consumedNext: false };
  const next = argv[i + 1];
  if (!next) return { value: null, consumedNext: false };
  return { value: staticValue(next), consumedNext: true };
}

/**
 * 解析 git 指令級路徑選項，回傳該次 git 指令的有效 cwd。
 * 處理 `-C <path>`（多個累積）、`--git-dir=`/`--git-dir <p>`、
 * `--work-tree=`/`--work-tree <p>`、`-c core.worktree=<p>`。
 * 任一相關路徑為動態 → unknown。work-tree 設定後即為有效基準。
 */
export function gitEffectiveCwd(cmd: Command, cwd: CwdState): CwdState {
  let base = cwd; // 隨 -C 累積
  let workTree: string | null = null; // 相對於套用 -C 後的 base
  let gitDir: string | null = null; // --git-dir 路徑（納入範圍檢查）
  const argv = cmd.suffix;

  for (let i = 0; i < argv.length; i++) {
    const tok = staticValue(argv[i]);
    if (tok === null || !tok.startsWith("-")) continue;

    if (tok === "-C") {
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      base = applyPath(base, v.value);
      if (v.consumedNext) i++;
    } else if (tok === "--work-tree" || tok.startsWith("--work-tree=")) {
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      workTree = v.value;
      if (v.consumedNext) i++;
    } else if (tok === "--git-dir" || tok.startsWith("--git-dir=")) {
      // --git-dir 指向倉庫目錄；靜態值須納入範圍檢查（落在專案外 → 該指令 cwd 視為該處）
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      gitDir = v.value;
      if (v.consumedNext) i++;
    } else if (tok === "-c") {
      const v = optionValue(argv, i, tok);
      if (v.value === null) {
        // 動態 config，無法判斷是否 core.worktree → 保守 unknown
        return UNKNOWN;
      }
      const m = v.value.match(/^core\.worktree=(.*)$/);
      if (m) workTree = m[1];
      if (v.consumedNext) i++;
    } else if (tok.startsWith("-c")) {
      // -ckey=val 黏寫形式
      const inline = tok.slice(2);
      const m = inline.match(/^core\.worktree=(.*)$/);
      if (m) workTree = m[1];
    }
  }

  if (workTree !== null) return applyPath(base, workTree);
  // --git-dir 在專案外 → effective cwd 指向該處，使中央 cwd 前置規則 ask；
  // 在專案內則維持 in-project（讀取子指令仍可 allow）。
  if (gitDir !== null) return applyPath(base, gitDir);
  return base;
}
