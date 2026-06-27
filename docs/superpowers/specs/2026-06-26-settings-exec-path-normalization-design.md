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
5. **相對路徑**（非絕對、非 UNC、無 `..` 段）→ **純詞法相對正規化 `lexicalNormalizeRelative`（不對 cwd 解析、維持相對形式）**：`toPosix` 後**折疊 `//`、移除 `.` 段**，維持相對（不加前導 `/`）。**相對 token 永不被轉成絕對**，故相對 pattern 永不命中絕對指令、且與 cwd 完全無關（等價類廣度 = 既有字面比對 + `//`/`.` 折疊）。**類別保留 fail-closed**：若 token 原含 `/`（bash 以路徑執行該檔、非 PATH 查找）卻在折疊後塌成**無 `/` 的裸名**（如 `./npm` → `npm`、`a/.` → `a`），兩者 shell 語義不同（path-exec vs PATH-lookup），正規化跨此邊界會把本機相對檔誤升級為受信任的 PATH 指令（或反向）→ **原樣返回 token**。深層相對 `./a/b` → `a/b` 仍含 `/`、指向同一相對檔，照常正規化。理由見 §4.5 不變量 9。
6. **絕對路徑**（posix 單一 `/`、Windows `X:/`、Windows 單一 `\` 經 toPosix，且無 `..` 段）→ `normalizeAbsolute`（折疊中段 `//`、移除 `.` 段、Windows 磁碟正規化）。**因規則 3 已先攔截 `..`，此處 `normalizeAbsolute` 實際只會折疊 `//`/`.`、不會發生 `..` 上溯。**
7. **`~user`**（波浪號接使用者名、無法判定他人家目錄）：不符合規則 4（非 `~`、非 `~/` 開頭）；若含 `/`（如 `~user/x`）落入規則 5 當相對處理（`~user` 為一具名段）；若不含 `/`（如 `~user`）落入規則 1 原樣返回。**本層不嘗試解析他人家目錄**。

**零段／塌根 fail-closed**：規則 5/6 正規化後，若結果**塌成空字串、或塌成裸根（`/`、`X:/`）而原 token 並非該裸根本身**（例如 `./` → 空、`/.` → `/`）→ **改原樣返回 token（literal）**，絕不產生空 / 裸根 prefix。理由見 §4.5 不變量 6：空 prefix 會使 `prefix-loose` 的 `startsWith("")` 命中**所有**指令；裸根 `/` 會誤配所有絕對路徑。此舉維持 `parseBashRule` 的「prefix 非空」不變量。（`a/.` 因從含 `/` 塌成無 `/` 裸名，已先由規則 5 的**類別保留 fail-closed** 攔截、留字面 `a/.`（§4.5 不變量 9），與本零段／塌根 fail-closed 是不同關卡。）

**尾斜線保留**：規則 5/6 的正規化會剝除尾斜線。若**原 token 以 `/`（或 `\`）結尾且 token 非單一根 `/`**，而正規化結果未以 `/` 結尾，則補回單一尾斜線（理由見 §4.5 不變量 2）。「零段／塌根 fail-closed」優先於本規則（已返回 literal 者不再加尾斜線）。

`canonicalizeExecPath` 為純詞法、不碰檔案系統、不依賴 cwd、idempotent（已正規化字串再跑一次結果不變）。`lexicalNormalizeRelative` 為 `src/engine/scope.ts` 新增的相對路徑詞法正規化 helper（只折疊 `//`、移除 `.` 段、不解析 `..`、不加前導 `/`；`normalizeAbsolute` 假設絕對、會強制加前導 `/`，不可用於相對路徑）。

### 4.3 指令側接點（保留原始 + 另構正規化，供 union 比對）

**核心安全設計：比對採 union（見 §4.4 / §4.5 不變量 1）——指令與 pattern 各保留「原始（raw）」與「正規化（canon）」兩種形式，命中 = `(rawCmd vs rawPat)` ∨ `(canonCmd vs canonPat)`。raw 對 raw 完整重現現行行為，canon 對 canon 額外加入等價命中。如此正規化只增不減命中、永不破壞既有 deny/ask 規則。**

`reconstructCommand(inv: CommandInvocation)` **維持回傳原始字串、簽名不變**（無 `home` 參數，**不**正規化）：

- `inv.name === null` → `null`（不變）。
- `inv.assignments.length > 0` → `null`（不變）。
- 任一 argv `staticValue` 為 `null` → `null`（不變）。
- 否則回 `[inv.name, ...argv 靜態值].join(" ")`（**原始 inv.name，不正規化**）。

**正規化指令字串 `canonCmd`** 由 `settingsAllows` 另行構造：`[canonicalizeExecPath(inv.name, null), ...argv 靜態值].join(" ")`。**指令側一律以 `home = null` 呼叫**：`inv.name` 已是去引號後的字串，無法區分原 token 是否帶引號，而 bash 對**引號** `"~/x"` **不**做 `~` 展開（只有未引號的前導 `~` 才展開）；若指令側展開 `~`，會把字面 `~` 檔名誤當成家目錄絕對路徑而誤升級（permission bypass）。以 `null` 呼叫即停用 `~` 展開，而 `//` 折疊與 `.` 段移除不需 `home`、照常運作（見 §4.5 不變量 10）。注意 `inv.name` 是 parser 給的**單一 token**（即使是引號路徑含空白，也是完整一段、不需切割），故指令側正規化涵蓋整個執行檔路徑、無 head-split 問題。argv 兩種形式皆不正規化。`reconstructCommand` 回 `null` 時 `canonCmd` 不構造（直接 `false`）。

### 4.4 Pattern 側接點 + union 比對

`settingsAllows` 改為 `settingsAllows(inv: CommandInvocation, rules: PermissionRules, home: string | null)`：

1. `rawCmd = reconstructCommand(inv)`；`null` → `false`（不變）。
2. `canonCmd = [canonicalizeExecPath(inv.name, null), ...argv 靜態值].join(" ")`（§4.3；指令側固定傳 `null`，永不展開指令側 `~`）。
3. **pattern 正規化 `canonicalizePattern(pat, home)`**（產生 canonPat，原 pat 即 rawPat）：
   - 取 pattern 的**第一個空白前 token**（`exact` 用 `text`、`prefix-boundary` / `prefix-loose` 用 `prefix`）為 head。
   - 對 head 套 `canonicalizeExecPath(head, home)`（尾斜線保留已內含）；其餘字串（第一個空白起之後）原樣保留，組回同 `kind` 的新 `BashPattern`。
   - 第一個空白前無內容或 pattern 無空白（prefix-loose 常態）→ 整個 `text`/`prefix` 視為 head。
   - **head-split 僅影響 pattern 側、且受 union 保護**：若 pattern 的執行檔路徑含空白（引號/跳脫），head-split 可能只正規化空白前段——但因 union 仍比對 `(rawCmd vs rawPat)`，原始字面行為完整保留，最壞情況只是「該 pattern 拿不到正規化加成、回退 raw」，**絕不**破壞或弱化原規則（見 §4.5 不變量 1）。
4. **union 命中函式**：對某組 patterns，命中 ⟺ `∃pat: matchesPattern(rawCmd, pat) ∨ matchesPattern(canonCmd, canonicalizePattern(pat, home))`。
5. 優先序不變：deny union 命中 → `false`；ask union 命中 → `false`；回 allow union 命中。

`parseBashRule` 已保證 prefix 不含 `*`，故 head 必無 glob 字元，正規化安全。

### 4.5 安全不變量（不可違反）

1. **union 非回歸 + 三組對稱**：比對採 union `(rawCmd vs rawPat) ∨ (canonCmd vs canonPat)`，且 deny / ask / allow **三組施加完全相同的 union 規則**。由此得兩個保證：(a) **非回歸**——`(rawCmd vs rawPat)` 分支完整重現現行字面比對，凡現行會命中者必仍命中，正規化**只增不減**命中（徹底化解 head-split 對含空白 deny 規則的破壞風險：raw 永遠保留）；(b) **deny 不被弱化**——deny/ask 的命中集合是現行的超集（強化保護），且 `deny > ask > allow` 短路順序不變。若只對單側正規化（如只正規化 cmd 卻拿 rawPat 比、或反之），則可能讓 raw-deny 對 canon-cmd 失配而漏擋——故**嚴禁跨形式比對**，只允許 raw↔raw 與 canon↔canon 兩條同形式分支。
2. **尾斜線保留**：`prefix-loose` 若 pattern 為 `Bash(/a/scripts/*)`（prefix=`/a/scripts/`），`normalizeAbsolute` 會剝成 `/a/scripts`，使 `cmd.startsWith("/a/scripts")` 誤配 `/a/scriptsEVIL`。補回尾斜線維持目錄邊界，避免本正規化引入新的誤放。指令側 `inv.name` 通常不以 `/` 結尾，不受影響；對稱套用無妨。
3. **相對路徑不跨信任邊界**：相對執行檔 token **不對 cwd 解析**，只做維持相對形式的詞法正規化。故相對 pattern（如 `Bash(scripts/review.sh *)`）**永不被 cwd 改寫成絕對路徑、不依賴 invocation 的 cwd**——它只配相對指令 `scripts/review.sh`（modulo `//`/`./..`），等價類廣度與既有字面比對相同，**不**因 cwd 不同而擴張授權面（避免 reviewer 指出的 cwd-tautology：「同一相對 allow 規則在任意 cwd 升級不同的 `scripts/review.sh`」）。絕對／`~` 展開後的絕對路徑才做絕對正規化。
4. **UNC / 前導 `//` fail-closed**：前導雙斜線（potential UNC）的 token 一律**原樣保留、不折疊、不 toPosix**。本層**不對 UNC 做語義正規化**（不解析 UNC 根、不折疊前導 `//`）；保留字面使 UNC token **仍可與字面相同的 pattern 命中**，但不會因折疊前導 `//` 而與本機絕對路徑規則（`/server/share/...`）誤撞。結果至多配不到 → 維持 `ask`，**絕不誤放**。
5. **`..` 不解析、留字面（symlink/junction 安全）**：詞法折疊 `..` 並非真語義等價——`/allowed/link/../tool` 詞法為 `/allowed/tool`，但 `link` 為 symlink/junction 時實際解析到別處。若折疊後拿去比對 allow，會把「另一個磁碟上執行檔」誤升級為 allow（且因 matcher 只看正規化字串而靜默）。故含 `..` 段的 token **一律留字面**（§4.2 規則 3），只配相同字面 pattern（至多 ask）。本層**不**做 realpath 解析（不碰檔案系統），因此唯一安全選擇就是不折疊 `..`。註：對 prefix-loose 的「`..` 字面 startsWith 既有 prefix」這類**既存**比對行為，與官方 `*`→`.*` 字面比對一致、非本層新增，故不在本層處理範圍。
6. **零段／塌根 fail-closed（prefix 非空不變量）**：正規化**永不**把一個非空 token 縮成空字串或裸根（`/`、`X:/`）。**判定以「正規化後結果」為準**：結果為空（如相對 `./` → 空）或為裸根而原 token 並非該裸根本身（如絕對 `/.` → `/`）→ 回原 token literal（§4.2「零段／塌根 fail-closed」）。**注意**：`a/.` 從含 `/` 塌成無 `/` 裸名 `a`，已先由不變量 9 的**類別保留 fail-closed** 攔截留字面，不進到本關卡。否則空 prefix 會讓 `prefix-loose` 的 `startsWith("")` 命中所有指令、裸根 `/` 會誤配所有絕對路徑，違反 `parseBashRule` 既有的「prefix 非空」保證。
7. **fail-safe 方向（`home === null` 僅影響 `~`）**：`home === null` 時**只**令 `~`/`~/` 開頭的 token 原樣返回（規則 4，因無家目錄可展開）；**不依賴 home 的路徑（絕對 `/a//b`、相對 `x/y`）照常正規化**——它們的等價變換與 home 無關。與 §4.2 規則 4 一致：home 缺失不是「全域停用正規化」，只是「停用 `~` 展開」。任何停用情形至多配不到 → 維持 `ask`，**絕不誤放**。
8. **不擴大放寬面**：本層只改變「字串比對的等價類」，不新增任何可被升級的指令類型；動態名 / 賦值前綴 / 動態 argv 仍回 `null`、不升級。
9. **類別保留 fail-closed（path-exec vs PATH-lookup）**：shell 中「含 `/` 的 token」一律以路徑執行該檔，「不含 `/` 的 token」走 `PATH` 查找——兩者語義不同檔。相對正規化（折疊 `//`、移除 `.` 段）**不得跨越此邊界**：若 token 原含 `/` 卻塌成無 `/` 的裸名（`./npm` → `npm`、`a/.` → `a`），會把本機相對檔 `./npm` 誤升級為受信任的 PATH 規則 `Bash(npm *)`（或令 `Bash(./tool *)` 誤配裸 `tool`）。故此類 token **原樣留字面**（§4.2 規則 5），只配相同字面 pattern（至多 ask）。深層相對 `./a/b` → `a/b` 仍含 `/`、指向同一檔，屬合法等價、照常正規化。
10. **指令側不展開 `~`（quoted-tilde 安全）+ 不破壞 union 同形式**：指令側 `canonCmd` 以 `canonicalizeExecPath(inv.name, null)` 構造，**永不展開指令側 `~`**。`inv.name` 已去引號，無法區分原 token 帶不帶引號；bash 對引號 `"~/x"` **不**展開 `~`，若指令側展開會把字面 `~` 檔名誤當家目錄絕對路徑而誤升級。pattern 側仍以真實 `home` 展開（settings pattern 由使用者撰寫、本意即展開）。此「指令側 null、pattern 側 home」的**不對稱**仍屬 canon↔canon 同形式比對（不違反不變量 1 的「禁止跨形式」）：raw↔raw 分支完整保留；canon 分支對 allow 只在「指令本就是該絕對家目錄路徑」時命中（真語義等價、正確），對 deny/ask 仍是現行命中的超集（只增不減）。代價：未引號的 `~/x` 指令對「絕對 home pattern」拿不到正規化加成（回退 raw），屬**安全方向**（至多 ask、絕不誤放）。

### 4.6 端到端驗證（核可用例）

輸入：
- `inv.name = /Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh`
- argv = `["--spec", "docs/...", "--base", "<sha>"]`（皆靜態）
- `home = /Users/stu43005`（cwd 與本層無關：執行檔為絕對路徑，正規化不涉及 cwd）
- allow pattern：`Bash(~/Sources/superpowers-codex/scripts/review-brainstorm.sh *)` → `prefix-boundary`，prefix=`~/Sources/superpowers-codex/scripts/review-brainstorm.sh`

流程（命中發生在 union 的 **canon↔canon** 分支；raw↔raw 分支此例不命中）：
- `canonCmd`：`canonicalizeExecPath(inv.name, null)` 折疊 `//` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`（指令側傳 `null`；本例執行檔為絕對路徑、無 `~`，故與 `home` 無關，`//` 折疊照常）；`canonCmd = "…review-brainstorm.sh --spec docs/... --base <sha>"`。
- `canonPat`：head `~/Sources/…/review-brainstorm.sh` 展開 `~` → `/Users/stu43005/Sources/superpowers-codex/scripts/review-brainstorm.sh`（prefix-boundary）。
- `matchesPattern(canonCmd, canonPat)`：`canonCmd.startsWith(canonPrefix + " ")` → 命中。deny/ask union 皆不命中 → allow union 命中 → 升級 `allow`。✅

## 5. 呼叫端串接

`classify.ts` 第 76 行 `if (settingsAllows(inv, rules)) return allow();` 改為傳入 `scope.home`：`settingsAllows(inv, rules, scope.home)`。`home` 已由 `evaluate.ts` → `classify(inv, root, rules, home, trustedReadRoots)` 帶入，無需新增資料流。本層**不使用** `inv.cwd`（相對路徑刻意不對 cwd 解析，見 §4.5 不變量 3）。

## 6. 已知限制（明確不做，YAGNI）

1. **wrapper 型不處理**：`bash ~/x.sh`、`timeout 5 ~/x.sh` 等，執行檔是第一個 token（`bash` / `timeout`），`~/x.sh` 是 argv，不正規化。符合「只正規化執行檔路徑」的核可範圍。
2. **不對齊大小寫**：維持現有 case-sensitive 比對（使用者明確選擇不動；Linux 路徑區分大小寫）。
3. **不碰檔案系統**：純詞法正規化，不解析 symlink / junction / 真實 inode。
4. **不解析他人家目錄**：`~user` 形式不展開。
5. **argv 內路徑不正規化**：僅執行檔 token。
6. **執行檔路徑含空白：pattern 側不享正規化加成，但安全（union 保護）**：指令側 `inv.name` 是 parser 的單一 token，含空白也完整、正規化涵蓋全路徑、無切割問題。pattern 側則以第一個空白切 head，若 pattern 的執行檔路徑含空白（引號/跳脫），head-split 只會正規化空白前段。因比對採 union（§4.4 / §4.5 不變量 1）仍保留 `(rawCmd vs rawPat)`，**現行字面行為完整保留**：含空白的 deny/ask/allow 規則一律照舊生效，最壞只是該 pattern 拿不到 `//`/`~`/`.` 正規化加成（回退 raw 字面比對）。**不**會破壞規則、**不**會弱化 deny。
7. **UNC / 前導 `//` 路徑不做語義正規化**：前導雙斜線 token 原樣保留（§4.2 規則 2 / §4.5 不變量 4），不解析 UNC 根、不折疊前導 `//`；字面相同的 pattern 仍可命中，但無語義等價放寬。
8. **含 `..` 段的執行檔路徑不正規化**：`/a/../b`、`x/../y` 等含獨立 `..` 段者一律留字面（§4.2 規則 3 / §4.5 不變量 5），symlink 安全；只配相同字面 pattern（至多 ask）。**僅**折疊中段 `//` 與移除 `.` 段為支援的正規化。
9. **退化路徑（塌成空/裸根）留字面**：`./`（→空）、`/.`（→`/`）等正規化後會塌成空/裸根者，改回原 token literal（§4.2 零段 fail-closed / §4.5 不變量 6），不產生過廣 prefix。
10. **含 `/` 塌成裸名的相對 token 留字面（類別保留）**：`./npm`、`a/.` 等原含 `/` 卻會塌成無 `/` 裸名者一律留字面（§4.2 規則 5 / §4.5 不變量 9），避免 path-exec 與 PATH-lookup 混淆。`./a/b` → `a/b`（仍含 `/`）屬合法等價、不在此列。
11. **指令側 `~` 不展開**：`canonCmd` 以 `home = null` 構造，未引號或引號的 `~/x` 指令一律不展開 `~`（§4.5 不變量 10）；只有 pattern 側的 `~` 會展開。代價是「未引號 `~/x` 指令 × 絕對 home pattern」拿不到加成（回退 raw、至多 ask），換取 quoted-tilde 不被誤升級。

## 7. 測試計畫

### 7.1 `src/permissions/matcher_test.ts`

既有測試補上 `home` 參數（**僅** `settingsAllows` 簽名新增 `home`；`reconstructCommand` 簽名不變、仍回原始字串）。新增**allow 與 ask 兩面 + 邊界**：

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
- **含空白執行檔路徑 + union 非回歸**（finding round-4-#1 回歸測試）：
  - deny `Bash(/Users/me/My Tools/x.sh *)`（路徑含空白）對指令 `/Users/me/My Tools/x.sh ...` → 仍命中 deny（raw 分支保留）→ **不**升級。即使該 deny 含 `//`（`/Users/me//My Tools/x.sh`）也至少由 raw 比對擋下。
  - allow 含空白且**無** `//`/`~`/`.` 的 pattern → 經 raw 分支照常命中（行為與現行一致）。
- 裸指令名（`cat` / `git`）不被當路徑、行為不變。
- **union 非回歸總則**：抽樣既有「現行會命中」案例，加入正規化層後**全部仍命中**（raw↔raw 分支保證）；正規化只新增命中、不移除。
- **deny / ask 不被弱化**：原本命中 deny 的指令，加入正規化後仍命中 deny（不升級）；deny pattern 僅差中段 `//` / `~` / `.` 的等價形式**額外**也命中（canon 分支，強化保護）。
- **類別保留 fail-closed（path-exec vs PATH-lookup，§4.5 不變量 9 回歸測試）**：
  - 指令 `./npm install` **不**被 PATH allow `Bash(npm *)` 升級（`./npm` 留字面、不塌成 `npm`）。
  - pattern `Bash(./tool *)` **不**命中裸 `tool` 指令。
  - 深層 `./a/b` 指令仍命中相對 `Bash(a/b *)`（合法等價、仍含 `/`）。
  - 單元層：`canonicalizeExecPath("./npm", null)` → `./npm`；`canonicalizeExecPath("a/.", null)` → `a/.`；`canonicalizeExecPath("./a/b", null)` → `a/b`。
- **指令側 `~` 不展開（quoted-tilde 安全，§4.5 不變量 10 回歸測試）**：
  - 引號 `"~/proj/tool.sh" x` 指令 **不**被絕對 home allow `Bash(/home/me/proj/tool.sh *)` 升級（指令側 `home=null`、不展開 `~`）。
  - motivating case（絕對指令 + `~` pattern）仍命中（`~` 只在 pattern 側展開）。
- 動態名 / 賦值前綴 / 動態 argv → 仍 `null`、不升級。

### 7.2 `src/engine/classify_test.ts` 與 e2e

- `classify_test.ts`：補一條「builtin ask + permissions.allow 含 `~` pattern + 指令含 `//`」端到端升級 allow。
- `src/main_test.ts`（子行程 e2e）：補核可用例的真實 JSON（餵 stdin，期望 allow、exit 0）。

### 7.3 驗證關卡

`deno task check && deno task lint && deno task test` 全綠 → `deno task build` → operational verification：餵核可用例 JSON 給 binary 確認回 allow；另餵「`home` 未設定」或「僅差大小寫」等形式確認**未誤放**（維持 ask）。

## 8. 影響檔案

| 檔案 | 變更 |
|------|------|
| `src/engine/scope.ts` | 新增 export `canonicalizeExecPath(token, home)`（不接 cwd；含前導 `//`、`..`-段、零段／塌根、**類別保留（含 `/` 塌成裸名）**四道 fail-closed guard）+ 私有 `lexicalNormalizeRelative` helper（折疊 `//`、移除 `.`、不解析 `..`） |
| `src/permissions/matcher.ts` | `settingsAllows` 加 `home` 參數、改 union 比對（raw↔raw ∨ canon↔canon）；新增 `canonicalizePattern`（pattern head 正規化）；`reconstructCanonical` **指令側固定傳 `home=null`**（不展開指令側 `~`）；`reconstructCommand` 簽名不變（仍回原始字串） |
| `src/engine/classify.ts` | `settingsAllows(inv, rules, scope.home)` |
| `src/permissions/matcher_test.ts` | 補 `home` 參數 + 新案例 |
| `src/engine/classify_test.ts` | 端到端升級案例 |
| `src/main_test.ts` | e2e 真實 JSON 案例 |
| `CLAUDE.md` | 補述「升級層執行檔路徑正規化（比官方寬）」於 matcher / 優先序段落 |
