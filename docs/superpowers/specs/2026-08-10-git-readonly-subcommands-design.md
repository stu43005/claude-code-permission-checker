# 設計：擴充 git 唯讀子指令 allowlist + `-O` orderfile 範圍檢查

- 日期：2026-08-10
- 範圍：`src/rules/commands/git.ts`、`src/rules/commands/git_test.ts`
- 狀態：設計已核可，待寫實作計畫（writing-plans）

## 1. 問題陳述

`src/rules/commands/git.ts` 的 `READ_SUBCOMMANDS` 目前只含 16 個唯讀子指令：

```
status, log, diff, show, blame, rev-parse, describe,
cat-file, ls-files, ls-tree, for-each-ref, reflog, shortlog, grep
```

（另有 `branch` / `tag` / `config` / `stash` / `remote` 五個在 `switch` 中以個案 gate 處理。）

集合外的子指令一律落 `default: ask`。實務上 agent 常用的純唯讀 plumbing 子指令並未列入，最典型的是 `merge-base`——以下這條全唯讀的狀態彙整指令，只因為其中一段 `git merge-base HEAD main` 而整鏈落到 `ask`（`combine.ts` 取最弱環節）：

```
git status; git diff --staged --stat; git log -30 --oneline;
git branch --show-current; git merge-base HEAD main;
git rev-parse --abbrev-ref @{upstream}
```

實測（`dist/permission-checker` 對此指令）回：

```json
{"permissionDecision":"ask","permissionDecisionReason":"git merge-base：非唯讀子指令或未列入 allowlist"}
```

同時，設計期對 git CLI 取證發現一個**既有**的安全缺口：所有吃 common diff options 的讀取子指令都支援 `-O <file>`（orderfile），該路徑會被 git 實際開啟讀取，但現行規則完全未對其做範圍檢查。亦即現在 `git diff -O/etc/passwd HEAD~1 HEAD` 會被判 `allow`。

## 2. 取證結論（決策依據）

以下均為對本機 git CLI 實際執行 `git <sub> -h` 與構造性測試取得，非推測：

1. **`-O` 支援兩種寫法**：黏寫 `-O<file>` 與空格 `-O <file>`，兩者皆會讀取該檔（不存在時 git 報「讀取排序檔案 … 失敗」）。
2. **`-O` 不支援短旗標 bundling**：`git diff-tree -rO<file> …` 被 git 以用法錯誤拒絕。故無需處理 `-rO…` 形式。
3. **`--` 之後的 `-O` 被當 pathspec**，不讀檔（`git diff HEAD~1 HEAD -- -O/nonexistent` 正常結束、無錯誤）。
4. **吃 `-O` 的子指令**：`diff`、`log`、`show`、`whatchanged`、`range-diff`、`diff-tree`、`diff-files`、`diff-index`。
5. **不吃 `-O` 的子指令**：`blame` / `annotate`（實測 `-O<file>` 被忽略、正常輸出 blame 結果）。
6. **`git grep -O` 語意不同**：是 `--open-files-in-pager`（執行任意 pager 程式），與 orderfile 無關；現行規則已對 `sub === "grep"` 的 `-O` 回 ask。
7. **無 `-O` 的長選項等價形式**：`git diff --output-order=x` 被拒為「無效選項」。
8. **候選子指令的旗標面**：對 `merge-base`、`rev-list`、`name-rev`、`whatchanged`、`range-diff`、`cherry`、`diff-tree`、`diff-files`、`diff-index`、`check-ignore`、`check-attr`、`check-ref-format`、`count-objects`、`var`、`annotate` 逐一檢視 `-h` 輸出，除上述 `-O` 外未見寫入型（`--output`／`--write`／`-i`）或執行外部程式型旗標。

## 3. 已核可的決策

1. **範圍**：一次補上一批同性質的純唯讀子指令，而非只加 `merge-base`。
2. **`ls-remote` 不納入**（維持 ask）：它不改本地狀態但會發網路請求、可接任意 URL，等於開一條不受本工具 `curl` domain allowlist 管轄的外聯管道，與現有威脅模型不一致。
3. **`help` 與 `verify-commit` / `verify-tag` 不納入**（維持 ask）：兩者不改儲存庫狀態但會 spawn 外部程式（`git help -w` 直接開瀏覽器；verify-\* 呼叫 gpg），非 agent 日常指令，依 allowlist 思維寧可不加。
4. **程式碼結構**：直接擴充既有 `READ_SUBCOMMANDS`（以註解分行標示 porcelain / plumbing），不新增第二個集合、不改寫成表驅動。
5. **`-O` orderfile 一併修掉**，且涵蓋現有的 `git diff` / `log` / `show`（不只新增的子指令），避免同類指令行為不一致。

## 4. 設計

### 4.1 `READ_SUBCOMMANDS` 擴充

新增 16 個子指令名稱。擴充後集合（既有 14 + 新增 16 = 30）：

```
porcelain: status, log, diff, show, blame, annotate, describe, shortlog,
           grep, reflog, whatchanged, range-diff, cherry, count-objects,
           version
plumbing:  rev-parse, rev-list, merge-base, name-rev, var, cat-file,
           ls-files, ls-tree, for-each-ref, diff-tree, diff-files,
           diff-index, check-ignore, check-attr, check-ref-format
```

**新增項**（16）：`annotate`、`whatchanged`、`range-diff`、`cherry`、`count-objects`、`version`、`rev-list`、`merge-base`、`name-rev`、`var`、`diff-tree`、`diff-files`、`diff-index`、`check-ignore`、`check-attr`、`check-ref-format`。

**明確排除、維持 ask**：`ls-remote`（網路）、`help`（man / browser）、`verify-commit`、`verify-tag`（gpg）、`symbolic-ref`、`worktree`、`submodule`、`notes`、`bisect`、`merge-tree`（皆有寫入形式，需個案 gate，不在本次範圍）。

### 4.2 `-O` orderfile 範圍檢查

**接點**：`gitRule.evaluate` 中，置於既有 `sub === "grep"` 的 `-O` 檢查**之後**、`READ_SUBCOMMANDS.has(sub)` 判定**之前**。順序保證 `git grep -O` 仍走既有的「執行任意 pager」ask 理由，語意不被新檢查覆蓋。

**掃描對象**：子指令之後的引數。為精確區分「動態 token」與「字面值恰為哨符」，`parseSub` 額外回傳 `restWords: Word[]`（子指令之後的原始 `Word` 陣列，與既有 `rest: string[]` 索引一一對應）。既有 `rest` 保留不動，供 `has()` / `--ext-diff` / `--output` 等既有檢查沿用。

**演算法**（走訪 `restWords`，索引 `k` 由 0 遞增）：

1. 取 `t = staticValue(restWords[k])`。
2. `t === "--"` → **停止掃描**，回 allow 路徑（`--` 之後是 pathspec，`-O` 不再是旗標；見 §2 取證 3）。
3. `t === null`（動態 token）→ **跳過此 token、繼續掃描**（不停止、不 ask；理由見 §5 非目標 1）。
4. `t === "-O"`（空格形式）→ 取值 token `restWords[k + 1]`：
   - 不存在（`-O` 在末尾）→ `ask("git <sub>：-O 缺少 orderfile 值")`。
   - `staticValue` 為 `null`（值為動態）→ `ask("git <sub>：-O 的 orderfile 值為動態，無法判定範圍")`。
   - 否則對該值呼叫 `ctx.resolvePathValue(值)`；結果非 `"in-project"` → `ask("git <sub>：-O orderfile 路徑超出專案範圍")`。
   - 通過則 `k += 2` 繼續。
5. `t` 以 `"-O"` 開頭且長度 > 2（黏寫形式 `-O<file>`）→ 取 `t.slice(2)` 為值，同樣以 `ctx.resolvePathValue` 判定，非 `"in-project"` → ask。通過則 `k += 1` 繼續。
6. 其他 → `k += 1` 繼續。

**套用範圍為所有子指令**（不限於 §2 取證 4 列出的那 8 個）：不維護「哪些子指令吃 `-O`」的清單，對不吃 `-O` 的子指令頂多多問一次，方向安全且無需隨 git 版本追蹤。此順序意味著 `switch` 中的 `branch` / `tag` / `config` / `stash` / `remote` 也會被掃描——這些子指令不吃 `-O`，實務上不會出現，掃描僅是無害的一致性成本。

**不處理 bundling**：依 §2 取證 2，git 本身拒絕 `-rO<file>`，故無需辨識該形式。

### 4.3 為何新增子指令不繞過既有閘門

`parseSub` 的全域選項 allowlist（`-c` 僅放行安全 config key、`--exec-path` / `--config-env` 明確 ask、**任何未知全域旗標一律 ask**）在子指令名稱判定**之前**執行，對新增子指令自動生效。既有兩條 rest 層檢查（`--ext-diff`、`--output` / `--output=`）同樣在 `READ_SUBCOMMANDS` 判定之前、且不分子指令套用，自動涵蓋新增的 diff 家族。

因此本次變更只擴大「哪些子指令名稱可放行」，不新增任何繞過路徑。`classify.ts` 的四條中央前置規則（cwd 範圍、寫入型重導向、賦值前綴、範圍外 `<`）位於指令規則之外、對所有指令通用且不可升級，完全不受影響。

## 5. 非目標 / 已接受限制

1. **子指令之後的動態 token 維持既有容忍**。現行 `parseSub` 對子指令**之後**的動態值不 ask（`rest.push(r ?? " ")` 僅以哨符代表），故 `git diff $FOO` 目前即為 `allow`。本次沿用此行為：§4.2 演算法步驟 3 對動態 token 選擇「跳過並繼續」，意即若動態 token 展開後恰為 `-O<path>`，`-O` 檢查偵測不到。
   - **決策**：不改。改為「遇動態 token 即 ask」會讓 `git log $ref`、`git diff $BRANCH` 這類極常見用法從 allow 變 ask，誤殺成本遠高於收益；且這是 `git.ts` 對 rest 動態值的**既有**通用容忍，非本次引入。
   - 注意動態值出現在**子指令之前**（全域選項區）時，`parseSub` 已判為未知全域旗標 → ask，不受此限制影響。
2. **`.gitattributes` 的 textconv filter 不在本次範圍**。`git diff` / `show` / `log` 可經 `textconv` 設定執行外部程式，此風險在現行設計中已隨這三個子指令被 allow 而存在（`--ext-diff` 有擋、textconv 沒擋）。新增的 diff-\* plumbing 家族繼承同一面，不提高既有風險等級。收緊 textconv 需獨立評估。
3. **有寫入形式的近親子指令不做個案 gate**。`symbolic-ref`、`worktree`、`submodule`、`notes`、`bisect`、`merge-tree` 需比照 `branch` / `stash` 的個案寫法，設計與測試成本高於本次收益，維持 `ask`。

## 6. 測試計畫（`src/rules/commands/git_test.ts`）

沿用既有 `ctxOf` helper（cwd `/proj`、`rootScope("/proj")`）。新增：

1. **新增子指令 allow**：對 16 個新子指令各斷言 `allow`，含 `git merge-base HEAD main`、`git rev-list --count HEAD`、`git diff-tree -r HEAD`、`git check-ignore src/x.ts`、`git var GIT_AUTHOR_IDENT`、`git version`。
2. **排除清單 ask**：`git ls-remote origin`、`git help log`、`git verify-commit HEAD`、`git symbolic-ref HEAD`、`git worktree list`、`git submodule status`、`git merge-tree a b` 皆為 `ask`。
3. **`-O` 黏寫形式**：`git diff -Osrc/order.txt HEAD` → `allow`；`git diff -O/etc/passwd HEAD` → `ask`；`git diff-tree -O../outside.txt HEAD` → `ask`。
4. **`-O` 空格形式**：`git diff -O src/order.txt HEAD` → `allow`；`git diff -O /etc/passwd HEAD` → `ask`；`git range-diff -O /tmp/x a..b c..d` → `ask`。
5. **`-O` 邊界**：`git diff HEAD -O` （末尾缺值）→ `ask`；`git diff -O "$F" HEAD`（值動態）→ `ask`。
6. **`--` 終止符**：`git diff HEAD -- -O/etc/passwd` → `allow`（`-O` 為 pathspec，不讀檔）。
7. **grep 語意不被覆蓋**：`git grep -O foo` → `ask`，且理由字串仍為既有的 pager 理由（斷言 `reason` 內含 `pager`），確認新檢查未搶先命中。
8. **全域閘門對新子指令仍生效**：`git -c core.pager=cat merge-base HEAD main` → `ask`；`git --exec-path=/tmp rev-list HEAD` → `ask`；`git --unknown-global merge-base HEAD main` → `ask`。
9. **回歸**：既有測試全數維持通過（特別是 `git diff HEAD~1` 等仍為 `allow`）。

## 7. 驗證步驟

1. `deno task check && deno task lint && deno task test` 全綠。
2. `deno task build`。
3. Operational verification（餵 JSON 給 binary，`CLAUDE_PROJECT_DIR` 指向本專案）：
   - §1 的完整狀態彙整指令 → 期望 `allow`。
   - `git diff -O/etc/passwd HEAD~1 HEAD` → 期望 `ask`（**不可**為 allow；此為本次修補的缺口）。
   - `git ls-remote origin` → 期望 `ask`。
   - 三者皆須 `exit 0`。
   - 若某項回 `allow` 而預期 `ask`，先確認是否因 `permissions.allow` 命中而升級（讀 `permissionDecisionReason`）；`-O` 那條若因升級而 allow，屬合法行為（指令規則自身的 ask 屬可升級 ask），以單元測試為準。
4. 更新 `CLAUDE.md` 中 git 規則的描述（`READ_SUBCOMMANDS` 已擴充、新增 `-O` orderfile 範圍檢查），保持文件與實作一致。
