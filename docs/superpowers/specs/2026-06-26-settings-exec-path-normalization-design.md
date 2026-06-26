# 設計：`permissions.allow` 比對的執行檔路徑正規化層

- 日期：2026-06-26
- 範圍：`src/permissions/matcher.ts`、`src/engine/scope.ts`、`src/engine/classify.ts` 與對應測試
- 狀態：設計已核可，待寫實作計畫（writing-plans）

## 1. 問題陳述

本 hook 會在 runtime 讀取使用者 `permissions.{allow,deny,ask}` 中的 `Bash(...)` 規則，把「builtin 判 `ask`、但命中 `permissions.allow`（且未被 deny/ask 命中）」的指令升級為 `allow`（見 `classify.ts` 的升級層）。

升級的比對邏輯在 `src/permissions/matcher.ts`：

- `reconstructCommand(inv)`：把 invocation 還原成 `[inv.name, ...argv 靜態值].join(" ")` 單一字串。
- `matchesPattern(cmd, pat)` / `matchesAny`：對 `BashPattern`（`exact` / `prefix-boundary` / `prefix-loose`）做**純字串比對**。

**缺陷**：比對兩側都未做任何路徑正規化，導致語義等價但字面不同的執行檔路徑無法命中。實例：

- allow 設定：`Bash(~/Sources/superpowers-codex/scripts/review-brainstorm.sh *)`
- 實際指令：`/Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh --spec docs/... --base <sha>`

兩處不一致使比對失敗、無法升級、維持 `ask`：

1. **pattern 側**：`~/` 未展開成家目錄。
2. **command 側**：`superpowers-codex//scripts` 的雙斜線 `//` 未折疊。

## 2. 取證結論（決策依據）

已對 Claude Code 2.1.193 編譯 binary 取證 + 官方文件交叉驗證，確認**官方對 Bash 指令的 `permissions` 比對不做路徑正規化**：

- Bash pattern 內的 `~` **不展開**，為字面字元（Read/Edit/Cd 的路徑規則才展開，走另一模組，Bash 比對不走該路徑）。
- 指令側 `//` **不折疊**、`./`·`../` **不解析**，原樣進入比對。
- 比對語意：`*`→`.*`、錨定 `^…$`、大小寫不敏感、空白折疊；對象是原始指令字串。

**推論**：本問題在官方 Claude Code 中同樣不會命中。因此「對齊官方」等於「不修」；要解決痛點，本 hook 必須**刻意比官方更寬鬆**，新增一個官方不做的正規化層。本設計即為此加值層。

## 3. 已核可的決策

1. **方向**：加入路徑正規化層（比官方寬），以使用者意圖為準。
2. **轉換項目**：展開 pattern 的 `~` / `~/`、折疊 `//` 雙斜線、解析 `./` 與 `../`。**不**對齊大小寫。
3. **套用範圍**：只正規化**執行檔路徑**（指令的第一個 token / pattern 的第一個空白前 token），argv 與 pattern 其餘部分不動。

## 4. 設計

### 4.1 定位與邊界

正規化**只在 `settingsAllows` 升級層生效**。三大硬 deny 閘（print-only、sleep、遞迴遍歷磁碟根/家目錄根）在 `evaluate` / `classify` 中於 `settingsAllows` **之前**短路，本層永遠碰不到，故不影響任何硬 deny。本層也**只放寬「比對等價類」**，不放寬任何寫入型重導向、賦值前綴、或非唯讀指令偵測。

### 4.2 核心函式 `canonicalizeExecPath`

於 `src/engine/scope.ts` 新增並 export（複用既有 `toPosix` / `isAbsolute` / `normalizeAbsolute` / 私有 `resolveAgainst`）：

```
canonicalizeExecPath(token: string, cwd: CwdState, home: string | null): string
```

對**單一執行檔 token** 正規化，指令側與 pattern 側**對稱套用同一函式**。規則依序：

1. **裸指令名**：token 不含 `/` 且不含 `\` 且非 `~`、非 `~/` 開頭 → **原樣返回**（`cat`、`git` 不得被當成路徑）。
2. **`~` 或 `~/` 開頭**：
   - `home === null` → **原樣返回，不展開**（fail-safe）。
   - 否則 `~` → `home`、`~/x` → `home` + `/x`，再 `normalizeAbsolute`。
3. **絕對路徑**（posix `/`、Windows `X:/`、UNC、Windows `\`）→ `normalizeAbsolute`（折疊 `//`、解析 `./..`、Windows 磁碟正規化）。
4. **相對路徑**：
   - `cwd.kind === "known"` → `resolveAgainst(cwd.path, token)`（解析成絕對 posix）。
   - `cwd.kind === "unknown"` → **原樣返回**（fail-safe，只配相同字面）。
5. **`~user`**（波浪號接使用者名、其後非 `/`、無法判定他人家目錄）：不符合規則 2（非 `~`、非 `~/` 開頭），若含 `/`（如 `~user/x`）落入規則 3/4 被當相對/絕對處理；若不含 `/`（如 `~user`）落入規則 1 原樣返回。**本層不嘗試解析他人家目錄**。

**尾斜線保留**：規則 2-4 經 `normalizeAbsolute` 會剝除尾斜線。若**原 token 以 `/` 結尾且 token !== `/`**，而正規化結果未以 `/` 結尾，則補回單一尾斜線（理由見 §4.5 安全不變量第 2 點）。

`canonicalizeExecPath` 為純詞法、不碰檔案系統、idempotent（已正規化字串再跑一次結果不變）。

### 4.3 指令側接點

`reconstructCommand` 改為 `reconstructCommand(inv: CommandInvocation, home: string | null)`：

- `inv.name === null` → `null`（不變）。
- `inv.assignments.length > 0` → `null`（不變）。
- 任一 argv `staticValue` 為 `null` → `null`（不變）。
- 否則：`name = canonicalizeExecPath(inv.name, inv.cwd, home)`，回 `[name, ...argv 靜態值].join(" ")`。argv **不**正規化。

### 4.4 Pattern 側接點

`settingsAllows` 改為 `settingsAllows(inv: CommandInvocation, rules: PermissionRules, home: string | null)`：

1. `cmd = reconstructCommand(inv, home)`；`null` → `false`（不變）。
2. 對 `rules.bash.deny`、`rules.bash.ask`、`rules.bash.allow` **三組** pattern 各自先以**同一正規化**轉換 head token，再 `matchesAny`：
   - 取 pattern 的**第一個空白前 token**（`exact` 用 `text`、`prefix-boundary` / `prefix-loose` 用 `prefix`）。
   - 對該 head token 套 `canonicalizeExecPath(head, inv.cwd, home)`，並依 §4.2 尾斜線規則保留；其餘字串（第一個空白起之後）原樣保留，組回同 `kind` 的新 `BashPattern`。
   - 第一個空白前無內容或 pattern 無空白（prefix-loose 常態）→ 整個 `text`/`prefix` 視為 head token。
3. 優先序不變：`matchesAny(cmd, deny')` → `false`；`matchesAny(cmd, ask')` → `false`；回 `matchesAny(cmd, allow')`。

`parseBashRule` 已保證 prefix 不含 `*`，故 head token 必無 glob 字元，正規化安全。

### 4.5 安全不變量（不可違反）

1. **三組對稱**：deny / ask / allow 必須套用**完全相同**的正規化。否則對 allow 正規化、對 deny 不正規化會弱化 deny。對稱套用下，正規化只會讓 deny 配到「僅差 `//` / `~` / `./..`」的**更多**等價形式（強化保護），且 `deny > ask > allow` 短路順序不變。
2. **尾斜線保留**：`prefix-loose` 若 pattern 為 `Bash(/a/scripts/*)`（prefix=`/a/scripts/`），`normalizeAbsolute` 會剝成 `/a/scripts`，使 `cmd.startsWith("/a/scripts")` 誤配 `/a/scriptsEVIL`。補回尾斜線維持目錄邊界，避免本正規化引入新的誤放。指令側 `inv.name` 通常不以 `/` 結尾，不受影響；對稱套用無妨。
3. **fail-safe 方向**：`home === null`（無法展開 `~`）與 `cwd.kind === "unknown"`（無法解析相對路徑）一律**原樣不正規化**。結果至多是配不到 → 維持 `ask`，**絕不誤放**。
4. **不擴大放寬面**：本層只改變「字串比對的等價類」，不新增任何可被升級的指令類型；動態名 / 賦值前綴 / 動態 argv 仍回 `null`、不升級。

### 4.6 端到端驗證（核可用例）

輸入：
- `inv.name = /Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh`
- argv = `["--spec", "docs/...", "--base", "<sha>"]`（皆靜態）
- `home = /Users/stu43005`、`cwd.kind = "known"`
- allow pattern：`Bash(~/Sources/superpowers-codex/scripts/review-brainstorm.sh *)` → `prefix-boundary`，prefix=`~/Sources/superpowers-codex/scripts/review-brainstorm.sh`

流程：
- 指令側：`canonicalizeExecPath` 折疊 `//` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`；`cmd = "…review-brainstorm.sh --spec docs/... --base <sha>"`。
- pattern 側：head `~/Sources/…/review-brainstorm.sh` 展開 `~` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`。
- `matchesPattern`（prefix-boundary）：`cmd.startsWith(prefix + " ")` → 命中 → 升級 `allow`。✅

## 5. 呼叫端串接

`classify.ts` 第 76 行 `if (settingsAllows(inv, rules)) return allow();` 改為傳入 `scope.home`：`settingsAllows(inv, rules, scope.home)`。`home` 已由 `evaluate.ts` → `classify(inv, root, rules, home, trustedReadRoots)` 帶入，`inv.cwd` 已在 invocation 上，無需新增資料流。

## 6. 已知限制（明確不做，YAGNI）

1. **wrapper 型不處理**：`bash ~/x.sh`、`timeout 5 ~/x.sh` 等，執行檔是第一個 token（`bash` / `timeout`），`~/x.sh` 是 argv，不正規化。符合「只正規化執行檔路徑」的核可範圍。
2. **不對齊大小寫**：維持現有 case-sensitive 比對（使用者明確選擇不動；Linux 路徑區分大小寫）。
3. **不碰檔案系統**：純詞法正規化，不解析 symlink / junction / 真實 inode。
4. **不解析他人家目錄**：`~user` 形式不展開。
5. **argv 內路徑不正規化**：僅執行檔 token。

## 7. 測試計畫

### 7.1 `src/permissions/matcher_test.ts`

既有測試補上 `home` 參數（`reconstructCommand` / `settingsAllows` 簽名變更）。新增**allow 與 ask 兩面 + 邊界**：

- `~` / `~/` 展開命中（home 已知）；`home === null` 時不展開 → 不升級（ask）。
- `//` 折疊命中（含核可用例）。
- `./` 與 `../` 解析：`../` 跳出 prefix → **不**命中（安全正向）。
- 尾斜線保留：`Bash(/a/scripts/*)` 命中 `/a/scripts/x` 但**不**命中 `/a/scriptsEVIL`。
- `cwd.kind === "unknown"` + 相對路徑 → 原樣、只配相同字面。
- 裸指令名（`cat` / `git`）不被當路徑、行為不變。
- **deny / ask 對稱不弱化**：原本命中 deny 的指令，正規化後仍命中 deny（不升級）；deny pattern 僅差 `//` / `~` 的等價形式也命中。
- 動態名 / 賦值前綴 / 動態 argv → 仍 `null`、不升級。

### 7.2 `src/engine/classify_test.ts` 與 e2e

- `classify_test.ts`：補一條「builtin ask + permissions.allow 含 `~` pattern + 指令含 `//`」端到端升級 allow。
- `src/main_test.ts`（子行程 e2e）：補核可用例的真實 JSON（餵 stdin，期望 allow、exit 0）。

### 7.3 驗證關卡

`deno task check && deno task lint && deno task test` 全綠 → `deno task build` → operational verification：餵核可用例 JSON 給 binary 確認回 allow；另餵「`home` 未設定」或「僅差大小寫」等形式確認**未誤放**（維持 ask）。

## 8. 影響檔案

| 檔案 | 變更 |
|------|------|
| `src/engine/scope.ts` | 新增 export `canonicalizeExecPath`，匯出或內用 `resolveAgainst` |
| `src/permissions/matcher.ts` | `reconstructCommand`、`settingsAllows` 加 `home` 參數；新增 pattern head 正規化 |
| `src/engine/classify.ts` | `settingsAllows(inv, rules, scope.home)` |
| `src/permissions/matcher_test.ts` | 補 `home` 參數 + 新案例 |
| `src/engine/classify_test.ts` | 端到端升級案例 |
| `src/main_test.ts` | e2e 真實 JSON 案例 |
| `CLAUDE.md` | 補述「升級層執行檔路徑正規化（比官方寬）」於 matcher / 優先序段落 |
