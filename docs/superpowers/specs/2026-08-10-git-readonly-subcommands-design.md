# 設計：擴充 git 唯讀子指令 allowlist + `-O` orderfile 範圍檢查

- 日期：2026-08-10
- 範圍：`src/rules/commands/git.ts`、`src/rules/commands/git_test.ts`
- 狀態：設計已核可，待寫實作計畫（writing-plans）

## 1. 問題陳述

`src/rules/commands/git.ts` 的 `READ_SUBCOMMANDS` 目前只含 14 個唯讀子指令：

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
8. **unbash 對 git 常見 token 的靜態判定**（以 `parse()` + `isStatic()` / `staticValue()` 實測，關乎 §4.3 收緊的誤殺面）：
   - `@{upstream}` → **靜態**（`parts: null`、`staticValue` 回 `"@{upstream}"`）。`@{…}` 不含逗號或 `..`，未被解析為 BraceExpansion，故 §1 的目標指令**不**受動態收緊影響。
   - `HEAD~1`、`--`、`src/x.ts` → 靜態。
   - `$BRANCH` → 動態（`SimpleExpansion`）；`*.md`（未引號 glob）→ 動態（`word.ts` 詞法偵測）。
9. **`--help` 與 `-h` 行為不同（設計審查 round 2 觸發的實測）**：
   - `git --help <sub>` 與 `git <sub> --help` **都會 spawn man viewer**（實測 `GIT_MAN_VIEWER=nonexistent-viewer-xyz git --help log` 回「未知的 man 檢視器」警告，證明該環境變數指定的程式確實被當作 viewer 執行）。兩者等價於 `git help <sub>`。
   - `git <sub> -h`（如 `git log -h`）**只印用法到 stdout**，不 spawn man。
   - `git --help`（無子指令）只印 git 總用法，不 spawn man。
10. **候選子指令的旗標面**：對 `merge-base`、`rev-list`、`name-rev`、`whatchanged`、`range-diff`、`cherry`、`diff-tree`、`diff-files`、`diff-index`、`check-ignore`、`check-attr`、`check-ref-format`、`count-objects`、`var`、`annotate` 逐一檢視 `-h` 輸出，除上述 `-O` 外未見寫入型（`--output`／`--write`／`-i`）或執行外部程式型旗標。

## 3. 已核可的決策

1. **範圍**：一次補上一批同性質的純唯讀子指令，而非只加 `merge-base`。
2. **`ls-remote` 不納入**（維持 ask）：它不改本地狀態但會發網路請求、可接任意 URL，等於開一條不受本工具 `curl` domain allowlist 管轄的外聯管道，與現有威脅模型不一致。
3. **`help` 與 `verify-commit` / `verify-tag` 不納入**（維持 ask）：兩者不改儲存庫狀態但會 spawn 外部程式（`git help -w` 直接開瀏覽器；verify-\* 呼叫 gpg），非 agent 日常指令，依 allowlist 思維寧可不加。
4. **程式碼結構**：直接擴充既有 `READ_SUBCOMMANDS`（以註解分行標示 porcelain / plumbing），不新增第二個集合、不改寫成表驅動。
5. **`-O` orderfile 一併修掉**，且涵蓋現有的 `git diff` / `log` / `show`（不只新增的子指令），避免同類指令行為不一致。
6. **堵住 `--help` 這條與被排除的 `help` 等價的路徑**（設計審查 round 2 觸發）：現行 `SAFE_VALUELESS_GLOBAL` 含 `--help`，故 `git --help log` 會被 `parseSub` 跳過旗標、判為子指令 `log` → allow；`git log --help` 則落在 rest、無人檢查。兩者實際都 spawn man viewer（§2 取證 9），與決策 3「排除 `help`」直接矛盾。修法見 §4.5。
7. **子指令之後、`--` 之前的動態 token 一律 ask**（設計審查觸發、使用者裁決採納）：靜態分析無法區分 `$FOO` 展開成 branch 名或展開成 `-O/etc/passwd`，若放行動態 token，§4.2 的 `-O` 檢查便可被 `git diff $ARGS HEAD` 這類寫法整個繞過。**此為既有行為的收緊**（現行 `git diff $FOO` 判 `allow`，變更後判 `ask`），代價與範圍見 §4.3。

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
3. `t === null`（動態 token）→ `ask("git <sub>：子指令引數含動態 token，無法排除其展開為 -O 等旗標")`。理由與代價見 §4.3。
4. `t === "-O"`（空格形式）→ 取值 token `restWords[k + 1]`：
   - 不存在（`-O` 在末尾）→ `ask("git <sub>：-O 缺少 orderfile 值")`。
   - `staticValue` 為 `null`（值為動態）→ `ask("git <sub>：-O 的 orderfile 值為動態，無法判定範圍")`。
   - 否則對該值呼叫 `ctx.resolvePathValue(值)`；結果非 `"in-project"` → `ask("git <sub>：-O orderfile 路徑超出專案範圍")`。
   - 通過則 `k += 2` 繼續。
5. `t` 以 `"-O"` 開頭且長度 > 2（黏寫形式 `-O<file>`）→ 取 `t.slice(2)` 為值，同樣以 `ctx.resolvePathValue` 判定，非 `"in-project"` → ask。通過則 `k += 1` 繼續。
6. 其他 → `k += 1` 繼續。

**套用範圍為所有子指令**（不限於 §2 取證 4 列出的那 8 個）：不維護「哪些子指令吃 `-O`」的清單，對不吃 `-O` 的子指令頂多多問一次，方向安全且無需隨 git 版本追蹤。此順序意味著 `switch` 中的 `branch` / `tag` / `config` / `stash` / `remote` 也會被掃描——這些子指令不吃 `-O`，實務上不會出現，掃描僅是無害的一致性成本。

**不處理 bundling**：依 §2 取證 2，git 本身拒絕 `-rO<file>`，故無需辨識該形式。

### 4.3 動態 token 收緊（§4.2 步驟 3）的範圍與代價

**為何必要**：`-O` 檢查建立在「能靜態看到所有引數」之上。現行 `parseSub` 對子指令**之後**的動態值不 ask（`rest.push(r ?? " ")` 僅以哨符代表），故 `git diff $FOO` 目前判 `allow`。若維持此容忍，`git diff $ARGS HEAD` 在 runtime 展開為 `git diff -O/etc/passwd HEAD` 時，決策仍以展開前的形狀分類——新檢查等於可被單一變數繞過。靜態分析無從區分 `$FOO` 展開成 branch 名或旗標，故唯一 fail-safe 的處理是 ask。

**適用範圍**：子指令**之後**、`--` **之前**的任何動態 token（變數展開、`$(…)`、可逸出 glob）。`--` 之後的動態 token 是 pathspec、不可能被解讀為旗標，**不** ask（掃描已於 `--` 停止）。子指令**之前**（全域選項區）的動態 token 不受本條影響——`parseSub` 已將其判為未知全域旗標 → ask。

**行為變更與代價**（明知的收緊，非 regression）：以下原本 `allow` 的形式變為 `ask`：

- `git log $ref`、`git diff $BRANCH`、`git show "$SHA"`
- `git diff $(git merge-base HEAD main)`（外層 invocation 因動態 argv 而 ask；`walk.ts` 列舉出的內層 `git merge-base` 仍各自判定為 allow）
- `git log *.md`（未加引號 glob 屬動態 token）

使用者若需自動放行特定形式，可循既有兩條路：加 allowlist 規則，或在 `permissions.allow` 加 `Bash(git log *)` 等（此 ask 屬指令規則自身的 ask，為**可升級** ask）。

### 4.4 為何新增子指令不繞過既有閘門

`parseSub` 的全域選項 allowlist（`-c` 僅放行安全 config key、`--exec-path` / `--config-env` 明確 ask、**任何未知全域旗標一律 ask**）在子指令名稱判定**之前**執行，對新增子指令自動生效。既有兩條 rest 層檢查（`--ext-diff`、`--output` / `--output=`）同樣在 `READ_SUBCOMMANDS` 判定之前、且不分子指令套用，自動涵蓋新增的 diff 家族。

因此本次變更只擴大「哪些子指令名稱可放行」，不新增任何繞過路徑。`classify.ts` 的四條中央前置規則（cwd 範圍、寫入型重導向、賦值前綴、範圍外 `<`）位於指令規則之外、對所有指令通用且不可升級，完全不受影響。

### 4.5 `--help` 路徑封堵

決策 3 把 `help` 排除在 allowlist 外，理由是它 spawn man / browser。但 git 提供兩條語義等價的旗標路徑，現行規則都放行：

| 形式 | 現行行為 | 實際效果 |
|---|---|---|
| `git help log` | `default: ask` | 開 man |
| `git --help log` | `--help` 在 `SAFE_VALUELESS_GLOBAL` 被跳過 → 子指令判為 `log` → **allow** | 開 man |
| `git log --help` | `--help` 落在 rest、無檢查 → **allow** | 開 man |

man viewer 可經 `GIT_MAN_VIEWER` 指定任意程式（§2 取證 9），故這是實質的外部程式執行面，而非單純的說明文字輸出。

**修法**（兩處，缺一不可）：

1. **從 `SAFE_VALUELESS_GLOBAL` 移除 `"--help"`**。移除後它落入 `parseSub` 的「未知全域旗標」分支 → `dangerous` → ask，涵蓋 `git --help log`。
2. **rest 層新增 `--help` 檢查**，與既有 `--ext-diff` 檢查同層（在 `READ_SUBCOMMANDS.has(sub)` 判定之前）：`rest.includes("--help")` → `ask("git <sub>：--help 會 spawn man viewer（可經 GIT_MAN_VIEWER 指定任意程式）")`，涵蓋 `git log --help`。

**`-h` 不受影響**：`git log -h` 只印用法到 stdout、不 spawn man（§2 取證 9），維持現狀。注意 `-h` 本就不在 `SAFE_VALUELESS_GLOBAL` 中，故 `git -h`（全域位置）現在即為 ask，本次不改變。

**附帶 over-ask**：`git --help`（無子指令）只印 git 總用法、不 spawn man，但移除後也會 ask（`parseSub` 遇未知旗標後無子指令 → 先回「未指定子指令」的 ask）。此為安全方向的輕微誤殺，接受。

## 5. Non-goals / Accepted limitations

（非目標 / 已接受限制。第 1 項為設計審查中經使用者裁決的 accepted limitation。）

1. **專案外 `-O` orderfile 維持「可升級 ask」，不做成不可升級的硬邊界**。
   - **Concern**（design-soundness 審查提出）：`git diff -O/etc/passwd` 只判指令規則自身的 ask，可被使用者的 `Bash(git diff *)` 之類廣域 `permissions.allow` 升級為 allow，使這條新的檔案系統邊界弱於中央前置的「範圍外 `<`」（後者不可升級）。
   - **Decision**：不實作硬邊界。
   - **Rationale**（使用者裁決）：① 與既有架構衝突——`factory.ts` 的 `pathValueFlags`（`grep -f <外部檔>`、`diff --from-file=<外部檔>`）全部都是可升級 ask，單獨把 `-O` 升格會造成規則體系不一致；② 危害極低——orderfile 內容只影響 diff 的檔案排序、**不會被輸出**，資訊洩漏強度遠弱於 `grep -f`；③ 使用者自行寫下 `Bash(git diff *)` 即為明確授權，正是升級層的設計意圖。
   - **範圍**：本裁決基於「`-O` 與既有 `pathValueFlags` 同類、且內容不外洩」這個前提。若日後 `-O` 的語義改變、或既有 `pathValueFlags` 改為不可升級，此接受限制不再自動適用，須重新評估。
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
6b. **動態 token（§4.3 收緊）**：`git log $ref` → `ask`；`git diff $BRANCH HEAD` → `ask`；`git diff $(git merge-base HEAD main)` → `ask`；`git log *.md`（未引號 glob）→ `ask`。
6c. **`--` 之後的動態 token 不 ask**：`git diff HEAD -- $FILE` → `allow`（掃描已於 `--` 停止，pathspec 不可能被解讀為旗標）。
6d. **`--help` 封堵（§4.5）**：`git --help log` → `ask`；`git log --help` → `ask`；`git help log` → `ask`（既有）；`git --help` → `ask`。對照組 `git log -h` → `allow`（`-h` 不 spawn man，且不得被新檢查誤殺）。
7. **grep 語意不被覆蓋**：`git grep -O foo` → `ask`，且理由字串仍為既有的 pager 理由（斷言 `reason` 內含 `pager`），確認新檢查未搶先命中。
8. **全域閘門對新子指令仍生效**：`git -c core.pager=cat merge-base HEAD main` → `ask`；`git --exec-path=/tmp rev-list HEAD` → `ask`；`git --unknown-global merge-base HEAD main` → `ask`。
9. **回歸**：既有測試全數維持通過（特別是 `git diff HEAD~1`、`git -C sub status` 等靜態形式仍為 `allow`）。**例外**：若既有測試中存在「子指令後帶動態 token 且斷言 `allow`」的案例，依 §4.3 該斷言必須改為 `ask`——這是本次刻意的行為收緊，不是測試被改壞。實作時須逐一檢視 `git_test.ts` 既有斷言並在計畫中列出所有需改動者。

## 7. 驗證步驟

1. `deno task check && deno task lint && deno task test` 全綠。
2. `deno task build`。
3. Operational verification（餵 JSON 給 binary，`CLAUDE_PROJECT_DIR` 指向本專案）：
   - §1 的完整狀態彙整指令 → 期望 `allow`。
   - `git diff -O/etc/passwd HEAD~1 HEAD` → 期望 `ask`（**不可**為 allow；此為本次修補的缺口）。
   - `git ls-remote origin` → 期望 `ask`。
   - `git log $ref` → 期望 `ask`（§4.3 收緊生效）。
   - `git --help log` → 期望 `ask`（§4.5 封堵生效；此為本次修補的第二個缺口）。
   - 五者皆須 `exit 0`。
   - 若某項回 `allow` 而預期 `ask`，先確認是否因 `permissions.allow` 命中而升級（讀 `permissionDecisionReason`）；`-O` 那條若因升級而 allow，屬合法行為（指令規則自身的 ask 屬可升級 ask），以單元測試為準。
4. 更新 `CLAUDE.md` 中 git 規則的描述（`READ_SUBCOMMANDS` 已擴充、新增 `-O` orderfile 範圍檢查），保持文件與實作一致。
