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
2. **轉換項目**：展開 pattern 的 `~` / `~/`、折疊 `//` 雙斜線、移除 `.` 段。**不**對齊大小寫。
   - **設計審查觸發的收窄（已採納）**：原核可決策含「解析 `../`」，但 design-soundness 審查指出**詞法折疊 `..` 在 symlink/junction 下不等於真實解析路徑**（`/allowed/link/../tool` 可指向 `/allowed/tool` 以外的磁碟上執行檔），會造成誤放。故本 spec **已採納改為不解析 `..`**：含 `..` 路徑段的 token 一律留字面、fail-closed（見 §4.2 規則 3、§4.5 不變量 5）。此為本 spec 的最終設計，無待決項；依 brainstorming 流程會在 spec 審查關卡向使用者明示此收窄（屬告知，不阻擋實作規劃）。
3. **套用範圍**：只正規化**執行檔路徑**（指令的第一個 token / pattern 的第一個空白前 token），argv 與 pattern 其餘部分不動。

## 4. 設計

### 4.1 定位與邊界

正規化**只在 `settingsAllows` 升級層生效**。三大硬 deny 閘（print-only、sleep、遞迴遍歷磁碟根/家目錄根）在 `evaluate` / `classify` 中於 `settingsAllows` **之前**短路，本層永遠碰不到，故不影響任何硬 deny。本層也**只放寬「比對等價類」**，不放寬任何寫入型重導向、賦值前綴、或非唯讀指令偵測。

### 4.2 核心函式 `canonicalizeExecPath`

於 `src/engine/scope.ts` 新增並 export（複用既有 `toPosix` / `isAbsolute` / `normalizeAbsolute`）：

```
canonicalizeExecPath(token: string, home: string | null): string
```

**刻意不接受 `cwd` 參數**：相對路徑**不對 cwd 解析**（見規則 5 與 §4.5 不變量 3 的信任邊界理由），故本函式對 cwd 無依賴。**轉換限定為「折疊中段 `//` + 移除 `.` 段」這兩種真語義等價變換**（兩者在任何 symlink 拓樸下都不改變路徑解析結果），外加 `~`/`~/` 展開。**不解析 `..`**。對**單一執行檔 token** 正規化，指令側與 pattern 側**對稱套用同一函式**。規則依序（先判先套，命中即返回）：

1. **裸指令名**：token 不含 `/` 且不含 `\` 且非 `~`、非 `~/` 開頭 → **原樣返回**（`cat`、`git` 不得被當成路徑）。
2. **前導雙斜線（UNC / 歧義絕對）**：`toPosix(token)` 以 `//` 開頭（涵蓋 posix `//x`、Windows UNC `\\server\share`）→ **不做語義正規化、原樣返回 token（不 toPosix、不折疊、fail-closed；字面相同的 pattern 仍可命中）**。理由見 §4.5 不變量 4。**注意**：此規則只攔**前導** `//`；路徑**中段**的 `//`（如核可用例 `superpowers-codex//scripts`）不受影響、照常折疊。
3. **含 `..` 路徑段 → 原樣返回（fail-closed）**：`toPosix(token)` 以 `/` 切段後，**任一段恰為 `..`** → **不正規化、原樣返回 token**。理由見 §4.5 不變量 5：詞法折疊 `..` 在 symlink/junction 下不等於真實解析路徑，可能放行不同的磁碟上執行檔。留字面使其只配相同字面 pattern（至多 ask）。注意以段為單位判定——檔名內含 `..`（如 `foo..bar`，非獨立 `..` 段）不受影響、照常正規化。
4. **`~` 或 `~/` 開頭**：
   - `home === null` → **原樣返回，不展開**（fail-safe）。
   - 否則 `~` → `home`、`~/x` → `home` + `/x`（此時已是絕對路徑）→ 落規則 6 的絕對分支。
   - （`home` 含 `..` 段的病態情形不在考量；`resolveHome` 回傳系統絕對家目錄。）
5. **相對路徑**（非絕對、非 UNC、無 `..` 段）→ **純詞法相對正規化 `lexicalNormalizeRelative`（不對 cwd 解析、維持相對形式）**：`toPosix` 後**折疊 `//`、移除 `.` 段**，維持相對（不加前導 `/`）。**相對 token 永不被轉成絕對**，故相對 pattern 永不命中絕對指令、且與 cwd 完全無關（等價類廣度 = 既有字面比對 + `//`/`.` 折疊）。
6. **絕對路徑**（posix 單一 `/`、Windows `X:/`、Windows 單一 `\` 經 toPosix，且無 `..` 段）→ `normalizeAbsolute`（折疊中段 `//`、移除 `.` 段、Windows 磁碟正規化）。**因規則 3 已先攔截 `..`，此處 `normalizeAbsolute` 實際只會折疊 `//`/`.`、不會發生 `..` 上溯。**
7. **`~user`**（波浪號接使用者名、無法判定他人家目錄）：不符合規則 4（非 `~`、非 `~/` 開頭）；若含 `/`（如 `~user/x`）落入規則 5 當相對處理（`~user` 為一具名段）；若不含 `/`（如 `~user`）落入規則 1 原樣返回。**本層不嘗試解析他人家目錄**。

**零段／塌根 fail-closed**：規則 5/6 正規化後，若結果**塌成空字串、或塌成裸根（`/`、`X:/`）而原 token 並非該裸根本身**（例如 `./` → 空、`/.` → `/`、`a/.` 等只剩 `.` 段的退化形）→ **改原樣返回 token（literal）**，絕不產生空 / 裸根 prefix。理由見 §4.5 不變量 6：空 prefix 會使 `prefix-loose` 的 `startsWith("")` 命中**所有**指令；裸根 `/` 會誤配所有絕對路徑。此舉維持 `parseBashRule` 的「prefix 非空」不變量。

**尾斜線保留**：規則 5/6 的正規化會剝除尾斜線。若**原 token 以 `/`（或 `\`）結尾且 token 非單一根 `/`**，而正規化結果未以 `/` 結尾，則補回單一尾斜線（理由見 §4.5 不變量 2）。「零段／塌根 fail-closed」優先於本規則（已返回 literal 者不再加尾斜線）。

`canonicalizeExecPath` 為純詞法、不碰檔案系統、不依賴 cwd、idempotent（已正規化字串再跑一次結果不變）。`lexicalNormalizeRelative` 為 `src/engine/scope.ts` 新增的相對路徑詞法正規化 helper（只折疊 `//`、移除 `.` 段、不解析 `..`、不加前導 `/`；`normalizeAbsolute` 假設絕對、會強制加前導 `/`，不可用於相對路徑）。

### 4.3 指令側接點

`reconstructCommand` 改為 `reconstructCommand(inv: CommandInvocation, home: string | null)`：

- `inv.name === null` → `null`（不變）。
- `inv.assignments.length > 0` → `null`（不變）。
- 任一 argv `staticValue` 為 `null` → `null`（不變）。
- 否則：`name = canonicalizeExecPath(inv.name, home)`，回 `[name, ...argv 靜態值].join(" ")`。argv **不**正規化。

### 4.4 Pattern 側接點

`settingsAllows` 改為 `settingsAllows(inv: CommandInvocation, rules: PermissionRules, home: string | null)`：

1. `cmd = reconstructCommand(inv, home)`；`null` → `false`（不變）。
2. 對 `rules.bash.deny`、`rules.bash.ask`、`rules.bash.allow` **三組** pattern 各自先以**同一正規化**轉換 head token，再 `matchesAny`：
   - 取 pattern 的**第一個空白前 token**（`exact` 用 `text`、`prefix-boundary` / `prefix-loose` 用 `prefix`）。
   - 對該 head token 套 `canonicalizeExecPath(head, home)`（尾斜線保留已內含於該函式）；其餘字串（第一個空白起之後）原樣保留，組回同 `kind` 的新 `BashPattern`。
   - 第一個空白前無內容或 pattern 無空白（prefix-loose 常態）→ 整個 `text`/`prefix` 視為 head token。
3. 優先序不變：`matchesAny(cmd, deny')` → `false`；`matchesAny(cmd, ask')` → `false`；回 `matchesAny(cmd, allow')`。

`parseBashRule` 已保證 prefix 不含 `*`，故 head token 必無 glob 字元，正規化安全。

### 4.5 安全不變量（不可違反）

1. **三組對稱**：deny / ask / allow 必須套用**完全相同**的正規化。否則對 allow 正規化、對 deny 不正規化會弱化 deny。對稱套用下，正規化只會讓 deny 配到「僅差中段 `//` / `~` / `.` 段」的**更多**等價形式（強化保護），且 `deny > ask > allow` 短路順序不變。
2. **尾斜線保留**：`prefix-loose` 若 pattern 為 `Bash(/a/scripts/*)`（prefix=`/a/scripts/`），`normalizeAbsolute` 會剝成 `/a/scripts`，使 `cmd.startsWith("/a/scripts")` 誤配 `/a/scriptsEVIL`。補回尾斜線維持目錄邊界，避免本正規化引入新的誤放。指令側 `inv.name` 通常不以 `/` 結尾，不受影響；對稱套用無妨。
3. **相對路徑不跨信任邊界**：相對執行檔 token **不對 cwd 解析**，只做維持相對形式的詞法正規化。故相對 pattern（如 `Bash(scripts/review.sh *)`）**永不被 cwd 改寫成絕對路徑、不依賴 invocation 的 cwd**——它只配相對指令 `scripts/review.sh`（modulo `//`/`./..`），等價類廣度與既有字面比對相同，**不**因 cwd 不同而擴張授權面（避免 reviewer 指出的 cwd-tautology：「同一相對 allow 規則在任意 cwd 升級不同的 `scripts/review.sh`」）。絕對／`~` 展開後的絕對路徑才做絕對正規化。
4. **UNC / 前導 `//` fail-closed**：前導雙斜線（potential UNC）的 token 一律**原樣保留、不折疊、不 toPosix**。本層**不對 UNC 做語義正規化**（不解析 UNC 根、不折疊前導 `//`）；保留字面使 UNC token **仍可與字面相同的 pattern 命中**，但不會因折疊前導 `//` 而與本機絕對路徑規則（`/server/share/...`）誤撞。結果至多配不到 → 維持 `ask`，**絕不誤放**。
5. **`..` 不解析、留字面（symlink/junction 安全）**：詞法折疊 `..` 並非真語義等價——`/allowed/link/../tool` 詞法為 `/allowed/tool`，但 `link` 為 symlink/junction 時實際解析到別處。若折疊後拿去比對 allow，會把「另一個磁碟上執行檔」誤升級為 allow（且因 matcher 只看正規化字串而靜默）。故含 `..` 段的 token **一律留字面**（§4.2 規則 3），只配相同字面 pattern（至多 ask）。本層**不**做 realpath 解析（不碰檔案系統），因此唯一安全選擇就是不折疊 `..`。註：對 prefix-loose 的「`..` 字面 startsWith 既有 prefix」這類**既存**比對行為，與官方 `*`→`.*` 字面比對一致、非本層新增，故不在本層處理範圍。
6. **零段／塌根 fail-closed（prefix 非空不變量）**：正規化**永不**把一個非空 token 縮成空字串或裸根（`/`、`X:/`）。退化形（`./`、`/.`、`a/.` 等只剩 `.` 段者）一律回原 token literal（§4.2「零段／塌根 fail-closed」）。否則空 prefix 會讓 `prefix-loose` 的 `startsWith("")` 命中所有指令、裸根 `/` 會誤配所有絕對路徑，違反 `parseBashRule` 既有的「prefix 非空」保證。
7. **fail-safe 方向（`home === null` 僅影響 `~`）**：`home === null` 時**只**令 `~`/`~/` 開頭的 token 原樣返回（規則 4，因無家目錄可展開）；**不依賴 home 的路徑（絕對 `/a//b`、相對 `x/y`）照常正規化**——它們的等價變換與 home 無關。與 §4.2 規則 4 一致：home 缺失不是「全域停用正規化」，只是「停用 `~` 展開」。任何停用情形至多配不到 → 維持 `ask`，**絕不誤放**。
8. **不擴大放寬面**：本層只改變「字串比對的等價類」，不新增任何可被升級的指令類型；動態名 / 賦值前綴 / 動態 argv 仍回 `null`、不升級。

### 4.6 端到端驗證（核可用例）

輸入：
- `inv.name = /Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh`
- argv = `["--spec", "docs/...", "--base", "<sha>"]`（皆靜態）
- `home = /Users/stu43005`（cwd 與本層無關：執行檔為絕對路徑，正規化不涉及 cwd）
- allow pattern：`Bash(~/Sources/superpowers-codex/scripts/review-brainstorm.sh *)` → `prefix-boundary`，prefix=`~/Sources/superpowers-codex/scripts/review-brainstorm.sh`

流程：
- 指令側：`canonicalizeExecPath` 折疊 `//` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`；`cmd = "…review-brainstorm.sh --spec docs/... --base <sha>"`。
- pattern 側：head `~/Sources/…/review-brainstorm.sh` 展開 `~` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`。
- `matchesPattern`（prefix-boundary）：`cmd.startsWith(prefix + " ")` → 命中 → 升級 `allow`。✅

## 5. 呼叫端串接

`classify.ts` 第 76 行 `if (settingsAllows(inv, rules)) return allow();` 改為傳入 `scope.home`：`settingsAllows(inv, rules, scope.home)`。`home` 已由 `evaluate.ts` → `classify(inv, root, rules, home, trustedReadRoots)` 帶入，無需新增資料流。本層**不使用** `inv.cwd`（相對路徑刻意不對 cwd 解析，見 §4.5 不變量 3）。

## 6. 已知限制（明確不做，YAGNI）

1. **wrapper 型不處理**：`bash ~/x.sh`、`timeout 5 ~/x.sh` 等，執行檔是第一個 token（`bash` / `timeout`），`~/x.sh` 是 argv，不正規化。符合「只正規化執行檔路徑」的核可範圍。
2. **不對齊大小寫**：維持現有 case-sensitive 比對（使用者明確選擇不動；Linux 路徑區分大小寫）。
3. **不碰檔案系統**：純詞法正規化，不解析 symlink / junction / 真實 inode。
4. **不解析他人家目錄**：`~user` 形式不展開。
5. **argv 內路徑不正規化**：僅執行檔 token。
6. **執行檔路徑含空白不支援**：pattern 與 reconstructed command 皆以空白切第一個 token 當執行檔；若執行檔路徑本身含空白（如 `/Users/me/My Tools/x.sh`），head 切割會落在空白處、無法正確正規化整段路徑。此類路徑維持原樣字面比對（至多配不到 → ask，不誤放）。此為既有 `reconstructCommand` 以空白 join 的延續限制，非本層新增風險。
7. **UNC / 前導 `//` 路徑不做語義正規化**：前導雙斜線 token 原樣保留（§4.2 規則 2 / §4.5 不變量 4），不解析 UNC 根、不折疊前導 `//`；字面相同的 pattern 仍可命中，但無語義等價放寬。
8. **含 `..` 段的執行檔路徑不正規化**：`/a/../b`、`x/../y` 等含獨立 `..` 段者一律留字面（§4.2 規則 3 / §4.5 不變量 5），symlink 安全；只配相同字面 pattern（至多 ask）。**僅**折疊中段 `//` 與移除 `.` 段為支援的正規化。
9. **退化路徑（只剩 `.` 段）留字面**：`./`、`/.`、`a/.` 等正規化後會塌成空/裸根者，改回原 token literal（§4.2 零段 fail-closed / §4.5 不變量 6），不產生過廣 prefix。

## 7. 測試計畫

### 7.1 `src/permissions/matcher_test.ts`

既有測試補上 `home` 參數（`reconstructCommand` / `settingsAllows` 簽名變更）。新增**allow 與 ask 兩面 + 邊界**：

- `~` / `~/` 展開命中（home 已知）；`home === null` 時不展開 → 不升級（ask）。
- `//` 折疊命中（含核可用例）；中段 `.` 段移除（`/a/./b` → `/a/b`）命中。
- **`..` 留字面、symlink 安全**（finding round-2-#1 回歸測試）：
  - 含 `..` 段的指令 `/allowed/link/../tool` 與 allow `Bash(/allowed/tool*)` → **不**命中（前者留字面、未折疊 `..`）→ 維持 ask。
  - pattern 與指令皆寫 `/allowed/link/../tool` → 命中（字面相同）。
  - 檔名內含 `..`（`foo..bar`，非獨立段）→ 照常正規化、不受 `..`-guard 影響。
- **零段／塌根 fail-closed**（finding round-2-#2 回歸測試，allow 與 deny 兩側都測）：
  - `Bash(./*)`（prefix-loose prefix=`./`）→ 正規化不得塌成空字串 → **不**命中任意指令（如 `rm -rf /`）。
  - `Bash(a/..*)`（含 `..`）→ 留字面 → 只配字面 `a/..` 開頭、不過廣。
  - exact `./`、`a/..` → 留字面、不塌空。
  - 同樣在 deny 組驗證：退化 pattern 不會因塌根而誤擴大 deny 命中面（對稱）。
- 尾斜線保留：`Bash(/a/scripts/*)` 命中 `/a/scripts/x` 但**不**命中 `/a/scriptsEVIL`。
- **相對 pattern 不跨邊界、cwd 無關**（finding 1 回歸測試）：
  - 相對 pattern `Bash(scripts/review.sh *)` **不**命中絕對指令 `/home/me/proj/scripts/review.sh ...`（相對永不被解析成絕對）。
  - 同一相對 pattern 對相對指令 `scripts//review.sh ...` 的判定**與傳入 cwd 無關**（折疊 `//` 後命中；改變 cwd 不影響結果）。
- **UNC / 前導 `//` fail-closed**（finding 2 回歸測試）：
  - pattern `Bash(//server/share/tool *)` 與指令 `//server/share/tool ...` 皆原樣 → 命中（字面相同）。
  - 本機 allow `Bash(/server/share/tool *)` **不**命中 UNC 指令 `//server/share/tool ...`（前導 `//` 未折疊、不誤撞）。
  - 中段 `//`（`/a//b`）仍正常折疊（與前導 `//` 區隔）。
- **執行檔路徑含空白**：`/Users/me/My Tools/x.sh` 形式維持字面、不誤放（至多 ask）。
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
| `src/engine/scope.ts` | 新增 export `canonicalizeExecPath(token, home)`（不接 cwd；含前導 `//`、`..`-段、零段／塌根三道 fail-closed guard）+ 私有 `lexicalNormalizeRelative` helper（折疊 `//`、移除 `.`、不解析 `..`） |
| `src/permissions/matcher.ts` | `reconstructCommand`、`settingsAllows` 加 `home` 參數；新增 pattern head 正規化 |
| `src/engine/classify.ts` | `settingsAllows(inv, rules, scope.home)` |
| `src/permissions/matcher_test.ts` | 補 `home` 參數 + 新案例 |
| `src/engine/classify_test.ts` | 端到端升級案例 |
| `src/main_test.ts` | e2e 真實 JSON 案例 |
| `CLAUDE.md` | 補述「升級層執行檔路徑正規化（比官方寬）」於 matcher / 優先序段落 |
