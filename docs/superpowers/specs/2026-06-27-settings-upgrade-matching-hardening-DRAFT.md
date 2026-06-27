# DRAFT — `settingsAllows` 升級層比對模型硬化（redirect 省略 + exec/argv 扁平化）

> **狀態：草稿（DRAFT）**。本檔**不是**已核可的 spec，只是把兩個在「執行檔路徑正規化」最終對抗式審查
> 中浮現、但**屬 `settingsAllows`/`reconstructCommand` 既有語義、與正規化無關**的安全硬化議題記錄下來，
> 供日後**另起** brainstorming → spec → writing-plans → implementation 流程處理。兩者皆**非**本次正規化
> feature 新增的能力（單斜線拼寫早已觸發），故當時刻意未在該 feature 內修。

> **更新（2026-06-27）**：**發現 A 已解**——中央前置規則已改為「對所有指令通用、不可由 `permissions.allow`
> 升級」的硬 ask，升級層只套用於「未列入 allowlist」與「指令規則自身」的 ask。**發現 B 維持已知限制**：
> exec/argv 去引號扁平化的跨界匹配未處理，沿用現行 deny 對稱守護（admin 加 path-equivalent deny 即可一致
> 擋下），留待日後「結構化比對模型」設計；嚴重度低（需使用者本就有含空白執行檔路徑的 allow 規則、無資料
> 遺失語義）。

## 0. 共同根因

`settingsAllows`（`src/permissions/matcher.ts`）判定「是否依 `permissions.allow` 把 builtin 的 `ask` 升級為
`allow`」時，透過 `reconstructCommand(inv)` 把 invocation 還原成單一比對字串 `[inv.name, ...argv 靜態值].join(" ")`。
此還原是**有損的**：

- **丟棄 redirects**（`> >> < <>` 等）——見發現 A。
- **去引號 + 以單一空白拼接 exec 與 argv，喪失 exec/argv 邊界與引號資訊**——見發現 B。
- 也不帶 `inv.cwd`（cwd 範圍檢查是 classify 的中央前置，settingsAllows 看不到）——見發現 A。

兩個發現都源於「比對模型只看一條攤平字串」。徹底解法方向之一是讓升級層的比對**結構感知**（保留 redirect /
exec-token 邊界 / cwd），或在 classify 端**區分可升級 ask 與不可升級的中央安全 ask**。

---

## 1. 發現 A（高）：中央安全 ask 被 `settingsAllows` 升級（redirect / cwd 省略）

### 1.1 問題

`classify`（`src/engine/classify.ts:73-76`）對**所有**非 deny/非 allow 的 verdict 一律呼叫 `settingsAllows` 嘗試升級，
包含 `classifyBuiltin` 因下列**中央安全前置規則**而回的 `ask`：

- **寫入型重導向**（`hasWriteRedirect`，classify.ts:38-40）——資料遺失/覆寫風險。
- **範圍外輸入重導向 `<`**（classify.ts:46-52）——讀取專案外檔案。
- **cwd 超出允許範圍**（classify.ts:34-36）。

而 `settingsAllows` 還原指令時**省略 redirects、不看 cwd**，故只要「指令名 + argv」命中某 `Bash(...)` allow
規則，上述中央安全 ask 就會被升級為 `allow`，**等同於該安全前置被繞過**。

（註：env 賦值前綴的 ask（classify.ts:42-44）**不受影響**——`reconstructCommand` 對 `assignments.length > 0`
直接回 `null`，settingsAllows 本就不會升級。）

### 1.2 證據（真實 binary，已驗證）

fixture `permissions.allow` 含 `Bash(npm test:*)` / `Bash(/opt/tools/run.sh *)`：

- `npm test --x > /etc/passwd` → **allow**（應為 ask：寫入重導向）。
- `/opt/tools/run.sh --x > /etc/passwd` → **allow**（單斜線、無需正規化即觸發 → 證明既有、與正規化無關）。

### 1.3 影響

- **寫入型重導向繞過**：使用者寫 `Bash(npm test:*)` 本意是允許「執行 npm test」，卻連帶允許 `> /etc/passwd`
  之類寫到專案外的副作用，違反中央寫入重導向守門的目的。
- **比官方更寬鬆（exact / prefix-boundary pattern）**：官方 Claude Code 以 `*`→`.*` 對**完整指令字串**比對，
  故 `Bash(npm test)`（exact、無萬用字元）**不**會命中 `npm test > /etc/passwd`（字串多了 `> ...`）；但本層
  `reconstructCommand` 丟掉 redirect 後 `npm test` 命中 exact `Bash(npm test)` → 升級。此為本層**比官方更寬**
  的誤放方向（與設計「只放寬、不誤放」相違）。

### 1.4 候選方向（未定）

1. **classify 端分流（較小、推薦起點）**：把「中央安全 ask」（寫入重導向 / 範圍外輸入重導向 / cwd 範圍外）
   標記為**不可升級**，`classify` 只對「指令未列入 allowlist / 指令規則自身的非安全 ask」呼叫 `settingsAllows`。
   只會更嚴格、不可能誤放。需要在 `RuleVerdict` 增一個「可升級」旗標，或在 classify 重檢這三項。
2. **把 redirects 納入比對模型**：`reconstructCommand` 保留 redirect 字串、`settingsAllows` 連 redirect 一起比，
   使 allow 規則無法靜默丟棄該段（更貼近官方字串比對語義）。
3. 兩者並用：分流為主、必要時納入 redirect 比對。

### 1.5 注意事項

- 此為**既有行為**（IMPL_BASE 已存在）；修正屬**行為變更**——allowlisted 指令帶 redirect 將從 allow 變 ask，
  對某些使用者是可用性下降，但方向與本專案「誤 ask 可接受、誤 allow 不可接受」一致。
- 影響範圍是**整個升級層**（所有 allowlisted 指令），非單一指令規則。

---

## 2. 發現 B（已知、暫受 deny 對稱守護）：exec/argv 扁平化跨界匹配

### 2.1 問題

`reconstructCommand` 把 exec（`inv.name`）與 argv **去引號後以單一空白拼接**。因此**含空白的執行檔路徑**
pattern 可能跨越指令的 exec/argv 邊界匹配：pattern 的「執行檔路徑」其實對上了「指令 exec token + 首個 argv」。

### 2.2 證據（真實函式/binary，已驗證）

- 指令 `"/tmp/My" "App/run.sh" evil`（實際執行 `/tmp/My`，argv 為 `App/run.sh`、`evil`）→ `reconstructCommand`
  得 `"/tmp/My App/run.sh evil"` → 命中 allow `Bash(/tmp/My App/run.sh *)`（該規則本意是執行檔 `/tmp/My App/run.sh`）。
- 單斜線拼寫即已如此（raw 分支）；正規化的 `//` 拼寫（`"/tmp//My" ...`）只是同一執行檔的另一寫法，**未新增能力**。

### 2.3 為何「執行檔長度閘」不可行（已實證並撤回）

曾嘗試「canonPat 比對長度 ≤ canon 執行檔名長度」的閘來阻止跨界匹配，但：

- 跨界 allow（`/tmp/My App/run.sh` 命中 exec `/tmp/My`）與**合法 argv-specific deny**（`Bash(/opt/t/run.sh --danger:*)`
  擋 `/opt/t/run.sh --danger`）在攤平字串上**結構完全相同**（pattern head == canon exec、其餘配 argv），無法區分。
- 該閘會把較長的 argv deny 排除、卻保留較短的 exec-only allow → **真實 deny-bypass**（最終審查 round 5 實證）。
- 故已撤回，改回 canon 對 deny/ask/allow **一致扁平**比對：argv-specific deny 與 exec-only allow 走同一條 canonCmd、
  deny 先評估而擋下（**deny 對稱**為現行守護）。

### 2.4 候選方向（未定）

- **保留 exec/argv 邊界於比對模型**：升級層改為「exec token 對 exec、argv 對 argv」結構化比對，而非攤平字串。
  pattern 側的 exec/argv 邊界本身仍有歧義（pattern 是使用者字串、空白可能在執行檔路徑內），需設計如何切割
  pattern 或要求 pattern 標示。屬較大改動。

### 2.5 現況風險評估

- **非本次正規化新增能力**：單斜線拼寫早已觸發、`/tmp//My` ≡ `/tmp/My` 同檔。
- **有守護**：deny 對稱——admin 加 path-equivalent deny 即可一致擋下。
- 嚴重度低於發現 A（無資料遺失語義；需使用者本就有含空白執行檔路徑的 allow 規則）。

---

## 3. 非目標 / 範圍界線（草稿階段先記）

- 本草稿**不**處理執行檔路徑詞法正規化本身（`canonicalizeExecPath` 已於前一 feature 完成並硬化：UNC、`..`、
  零段、類別保留、指令側不展開 `~`、POSIX 反斜線、`~` 展開後重檢 UNC/`..`）。
- 兩個發現的修正都會碰**升級層核心語義 / `reconstructCommand` 還原模型**，影響所有 allowlisted 指令，故需
  獨立的設計與測試，不應夾帶進正規化 feature。

## 4. 後續

- 以本草稿為輸入，另起 `superpowers-codex:brainstorming` → spec → writing-plans → implementation。
- 建議優先處理發現 A（高、資料遺失、且比官方更寬）；發現 B 可一併於「結構化比對模型」設計中解掉，或視成本
  維持 deny 對稱守護並文件化為已知限制。
