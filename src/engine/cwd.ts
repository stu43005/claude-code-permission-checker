import type { Command, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { isAbsolute, normalizeAbsolute } from "./scope.ts";
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";
import { evalSubstitutionWord } from "./subst_eval.ts";

const UNKNOWN: CwdState = { kind: "unknown" };

export function isCd(cmd: Command): boolean {
  return cmd.name ? staticValue(cmd.name) === "cd" : false;
}

/** 把單一靜態路徑接到目前 cwd 上；動態 / cwd 未知 → unknown。 */
function applyPath(cwd: CwdState, value: string): CwdState {
  if (isAbsolute(value)) {
    return { kind: "known", path: normalizeAbsolute(value), origin: "chain-cd" };
  }
  if (cwd.kind === "unknown") return UNKNOWN;
  const base = cwd.path.endsWith("/") ? cwd.path : cwd.path + "/";
  return {
    kind: "known",
    path: normalizeAbsolute(base + value.replace(/\\/g, "/")),
    origin: "chain-cd",
  };
}

/**
 * `cd` 之後的新 threaded cwd。無參數（=$HOME）、動態參數、或不可解析的形態 → unknown。
 *
 * 取值順序：
 *   1. 未加引號的 leading tilde → 僅 `~` / `~/<rest>` 且 shellHome 已知時展開；
 *      混合引號形態（`~/"src"`）與 `~user` / `~+` / `~-` 一律 unknown。
 *      引號包裝的 `"~"` 不命中述詞，走步驟 3 的相對語義——那對它是正確的。
 *   2. 靜態 token → 直接使用。
 *   3. 單一 `"$(…)"` 且內層可靜態求值 → 用求值結果。
 * 步驟 2 與 3 取得的值都要再經 `applyTarget` 過濾 `-`。
 *
 * `shellHome` 選填：未提供時 tilde 形態一律 unknown（fail-safe）。
 */
export function applyCd(cmd: Command, cwd: CwdState, shellHome: string | null = null): CwdState {
  if (cmd.suffix.length === 0) return UNKNOWN; // cd 無參數 = $HOME
  const target = cmd.suffix[0];

  if (hasUnquotedLeadingTilde(target)) {
    const v = staticValue(target);
    if (v === null) return UNKNOWN;
    // parts 非空 = 混合引號形態（如 ~/"src"）：開頭 ~ 會展開、後段是引號內容，
    // 正確模擬需逐 part 重建語義 → 保守放棄。
    if (target.parts && target.parts.length > 0) return UNKNOWN;
    const expanded = expandTilde(v, shellHome);
    if (expanded === null) return UNKNOWN; // ~user / ~+ / ~- 或 home 未知
    return applyPath(cwd, expanded);
  }

  const val = staticValue(target);
  if (val !== null) return applyTarget(cwd, val);

  const evaluated = evalSubstitutionWord(target, cwd);
  if (evaluated === null) return UNKNOWN;
  return applyTarget(cwd, evaluated);
}

/**
 * 把已取得的 cd 目標字串接上 cwd。`-` 必須在這裡擋，而不是只擋原始 token——
 * 求值結果同樣可能是 `-`（`basename ./-`、`printf '%s' -`），而 bash 對 `cd -` 的解讀
 * 是「回上一個工作目錄」，不是相對路徑 `./-`。
 */
function applyTarget(cwd: CwdState, value: string): CwdState {
  if (value === "-") return UNKNOWN;
  return applyPath(cwd, value);
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
