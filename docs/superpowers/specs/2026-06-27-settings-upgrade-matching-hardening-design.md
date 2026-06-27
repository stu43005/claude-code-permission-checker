# 設計：升級層重新定位 — 中央前置規則成「通用不可升級硬 ask」

- 日期：2026-06-27
- 範圍：`src/engine/classify.ts` 與對應測試（`classify_test.ts`）；`classify` 對外簽名不變
- 狀態：設計已核可，待寫實作計畫（writing-plans）
- 前置輸入：`docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-DRAFT.md`（發現 A）

## 1. 問題陳述

本 hook 在 runtime 讀使用者 `permissions.{allow,deny,ask}` 的 `Bash(...)` 規則，把「builtin 判 `ask`、命中 `permissions.allow`（且未被 deny/ask 命中）」的指令升級為 `allow`（`classify.ts` 升級層、`settingsAllows`）。

升級層目前的接點是**對 `classifyBuiltin` 的「最終 verdict」一律嘗試升級**（`classify.ts:73-76`）：

```ts
const v = classifyBuiltin(inv, scope, rules.webFetch);
if (v.kind === "deny") return v;
if (v.kind === "allow") return v;
if (settingsAllows(inv, rules, scope.home)) return allow();
return v;
```

**缺陷**：`classifyBuiltin` 回 `ask` 的來源不只一種，但升級層把它們**一視同仁**地嘗試升級。其中**四條中央安全前置規則**（cwd 超範圍、寫入型重導向、賦值前綴、範圍外 `<` 讀檔）回的 `ask` 是這個 hook 的**安全地基**，本就不該被使用者的 `Bash(...)` allow 規則解除，卻一樣被升級。

實例（DRAFT 發現 A，已於真實 binary 驗證）：

- `npm test --x > /etc/passwd` + `Bash(npm test:*)` → **allow**（應為 ask：寫入重導向）。
- `/opt/tools/run.sh --x > /etc/passwd` + `Bash(/opt/tools/run.sh *)` → **allow**（同上）。

`reconstructCommand` 還原指令字串時**丟棄 redirects、不帶 cwd**，故「指令名 + argv」命中 allow 規則後，寫入重導向等安全 ask 被靜默升級，等同安全前置被繞過。此為**比官方更寬鬆**的誤放方向（官方對完整指令字串比對，`npm test > /etc/passwd` 因字串多了 `> ...` 不會命中 exact `Bash(npm test)`）。

## 2. 取證結論（決策依據）

以 `grep` 驗證 `src/rules/commands/*.ts` 的 allowlist：**`npm` 與 `/opt/tools/run.sh` 都不在 allowlist**。據此重讀 `classifyBuiltin`（`classify.ts:12-55`）的控制流：

```
if (inv.name === null) return ask("動態指令名")
const rule = lookupRule(inv.name)
if (!rule) return ask("未列入 allowlist")        ← 非-allowlist 指令在此 return
verdict = rule.evaluate(...)
if (verdict.deny) return verdict
// ↓ 四條中央前置規則：只有 allowlisted 指令才跑得到
if (cwd 超範圍) ...  if (寫入重導向) ...  if (賦值前綴) ...  if (範圍外 <) ...
return verdict
```

**關鍵推論**：DRAFT 的兩個範例（npm、/opt/tools/run.sh 皆非-allowlist）**根本跑不到中央前置規則**——它們走 `!rule → ask`，再被升級。因此：

1. 中央前置規則目前**只對 allowlisted 指令生效**，是不完整的安全閘。
2. `未列入 allowlist` 的 ask **必須維持可升級**——這是 `permissions.allow` 對自訂指令的核心放行路徑（CLAUDE.md 放行路徑 (b)：「在 settings.json 加該指令、免改碼」）。若把它變不可升級，會打爆整個自訂指令放行機制。

故修正的精確原則為：

> **中央前置 ask（四條，對所有指令通用）＝ 不可升級；其餘 ask（未列入 allowlist、指令規則自身 ask）＝ 可升級。**

## 3. 已核可的決策

1. **方向**：把升級接點從「對 `classifyBuiltin` 最終 verdict」收斂到「只對可升級 ask」，並把四條中央前置規則上移成「對所有指令、在升級之前」的通用硬 ask 閘。
2. **四條中央前置全部不可升級**（cwd 超範圍、寫入型重導向、賦值前綴、範圍外 `<`），不只寫入重導向。
3. **中央前置通用化**：對 allowlisted 與非-allowlist 指令一致施加，否則修不到 DRAFT 的非-allowlist 範例。
4. 代價（已接受）：非-allowlist 指令帶寫入重導向 / cwd 超範圍 / 範圍外 `<` 時，即使有對應 `Bash()` allow 規則也會變 ask——**安全方向**，與專案「誤 ask 可接受、誤 allow 不可接受」一致。

## 4. 設計

### 4.1 定位與邊界

本變更**只動 `classify.ts` 的決策順序與升級接點**，不改 `settingsAllows`/`reconstructCommand`（維持純字串比對職責），不改任何指令規則、不改 `scope.ts`/`redirect.ts`。三類硬 `deny`（遞迴遍歷磁碟根/家目錄根、整鏈 print-only、sleep 輪詢）的短路位置不變：print-only/sleep 在 `evaluate` 上游、遞迴根 deny 為指令規則回 deny 後於本流程步驟 2 短路——**皆不經升級層**。本變更**只收緊升級範圍**，不放寬任何寫入型重導向 / 賦值前綴 / 非唯讀偵測。

### 4.2 重構後的決策流程

把現行 `classifyBuiltin` + `classify` 兩層（先算最終 verdict、再對最終結果升級）併成單一有序流程。`classify` 對外簽名 **不變**（`(inv, root, rules, home, trustedReadRoots)`；`evaluate.ts:47` 唯一呼叫端不需改）。順序如下（先判先返、命中即返回）：

```
1. inv.name === null                  → ask（不可升級）
2. rule = lookupRule(inv.name)
   若 rule 存在：
     ruleVerdict = rule.evaluate(ctx)
     ruleVerdict.kind === "deny"       → return ruleVerdict   // 硬 deny 最優先，不升級
3. 四條中央前置（通用，對所有指令）任一命中 → ask（不可升級）
     a. cwd.kind === "known" 且 !isReadScoped(...)
     b. hasWriteRedirect(inv.redirects)
     c. inv.assignments.length > 0
     d. 任一 `<` redirect 的 target resolvePath !== "in-project"
4. 可升級 ask 區：
     無 rule（未列入 allowlist） → settingsAllows ? allow() : ask("未列入 allowlist：…")
     ruleVerdict.kind === "ask"  → settingsAllows ? allow() : ruleVerdict
5. ruleVerdict.kind === "allow"        → return allow()
```

**與現行的差異點**：

- 中央前置（步驟 3）從「`!rule` return 之後、只對 allowlisted」上移到「rule 硬 deny 之後、對所有指令」。
- `settingsAllows`（步驟 4）從「對最終 verdict 一律嘗試」收斂到「只對未列入 allowlist 的 ask 與指令規則自身的 ask」。中央前置 ask 永遠不進步驟 4。
- `inv.name === null` 的 ask（步驟 1）維持不可升級——本就因 `reconstructCommand` 於 name===null 回 `null` 而升不了，行為不變，僅語義上歸入不可升級。

### 4.3 `ctx` 與中央前置的相依

- 步驟 2 建構 `RuleContext`（`resolvePath`/`resolvePathValue`/`resolveUrl`/`isDangerousRoot` 綁定 `inv.cwd` 與 `scope`/`webFetch`），與現行 `classifyBuiltin` 完全相同。
- 步驟 3 四條中央前置所需資料皆與 rule 無關，對非-allowlist 指令同樣可計算：
  - cwd：`isReadScoped(normalizeAbsolute(inv.cwd.path), scope)`（既有 import）。
  - 寫入重導向：`hasWriteRedirect(inv.redirects)`（既有 import）。
  - 賦值前綴：`inv.assignments.length`。
  - 範圍外 `<`：`resolvePath(r.target, inv.cwd, scope)`（既有 import）。
- 四條的 `ask` 理由字串沿用現行文案（`classify.ts:35,39,43,50`），不新增/不改寫。

### 4.4 行為變更矩陣

修正會讓以下從 `allow` 翻成 `ask`（安全方向）：

| 指令 | settings | 現行 | 修正後 | 說明 |
| --- | --- | --- | --- | --- |
| `npm test --x > /etc/passwd` | `Bash(npm test:*)` | allow | **ask** | 非-allowlist + 寫入重導向 |
| `/opt/tools/run.sh --x > /etc/passwd` | `Bash(/opt/tools/run.sh *)` | allow | **ask** | 非-allowlist + 寫入重導向 |
| `cat f > out.txt` | `Bash(cat:*)` | allow | **ask** | allowlisted + 寫入重導向（中央 ask 原也被升級） |
| allowlisted 指令在專案外 cwd | `Bash(<cmd>:*)` | allow | **ask** | cwd 超範圍 |
| `<cmd> < /etc/hosts`（target 範圍外） | `Bash(<cmd>:*)` | allow | **ask** | 範圍外 `<` |

維持原判定（**不變**）：

| 指令 | settings | 判定 | 說明 |
| --- | --- | --- | --- |
| `npm test --x`（無 redirect） | `Bash(npm test:*)` | allow | 未列入 allowlist 的 ask 仍可升級 |
| `cat README.md` | `Bash(cat:*)` | allow | 指令規則 allow（無中央前置） |
| 指令規則自身範圍外讀取 ask | `Bash(<cmd> <path>)` / `Read(...)` | 可升級 | 非中央前置，仍可由 settings/Read 放寬 |
| `FOO=bar <cmd>`（賦值前綴） | 任意 | ask | 本就不升級（reconstruct 回 null），無變化 |
| `<cmd> < projfile`（target 在專案內，或 Read() 已放寬） | 任意 | 走可升級區 | 中央前置 d 看的是放寬後 scope，不命中 |

### 4.5 不變量（不可違反）

1. **deny 三類最優先、不經升級層**：遞迴根掃描（指令規則回 deny，步驟 2 短路）、整鏈 print-only、sleep 輪詢（後二者在 `evaluate` 上游短路，根本不進 `classify`）。
2. **指令規則硬 deny 優先於中央前置 ask**：步驟 2 在步驟 3 之前。含寫入重導向的遞迴根掃描指令仍回 deny（非 ask）。
3. **中央前置 ask 不可由 `permissions.allow` 升級**：步驟 3 命中即 return，永不進步驟 4 的 `settingsAllows`。
4. **未列入 allowlist 的 ask 仍可升級**：步驟 4 保留此放行路徑（CLAUDE.md 放行路徑 (b)）。
5. **`Read()/Edit()/Write()` 讀取範圍放寬不受影響**：cwd（a）與範圍外 `<`（d）判定吃的是已含 readScope 放寬的 `scope`，放寬命中時這兩條本就不觸發 → 仍走可升級區。
6. **default-deny**：未涵蓋形式 fallback `ask`；任何例外 try/catch 成 ask（fail-safe，上游既有）。
7. **`classify` 對外簽名與回傳型別不變**：`combine.ts`/`evaluate.ts` 不需改。

## 5. 測試計畫

`src/engine/classify_test.ts` 補強（沿用既有 `ctxOf`/fixture helper；allow 與 ask 兩面 + allowlisted/非-allowlist 兩態）：

1. **中央前置不可升級 × 四條 × 兩態**：每條中央前置（cwd/寫入重導向/賦值前綴/範圍外 `<`）對 allowlisted 與非-allowlist 各一例，配上會命中的 `Bash(...)` allow 規則，斷言**仍為 ask**（不被升級）。
2. **回歸更新**：若既有測試斷言「allowlisted 帶寫入重導向 + `Bash(<cmd>:*)` → allow」，更新為 ask（該行為即被修掉的 bug；於測試註解標明）。
3. **可升級路徑不退化**：
   - 非-allowlist 無中央前置（`npm test --x` + `Bash(npm test:*)`）→ allow。
   - 指令規則自身範圍外讀取 ask + 對應 `Bash()`/`Read()` 規則 → allow。
4. **deny 優先**：遞迴根掃描 + 寫入重導向 + 命中 `Bash(...)` → 仍 deny（不被中央 ask 或升級遮蔽）。

## 6. Operational verification（改規則後必做）

`deno task check && deno task lint && deno task test` 全綠後 `deno task build`，餵真實 JSON 給 binary：

- fixture `permissions.allow` 含 `Bash(npm test:*)`：
  - `npm test --x > /etc/passwd` → **ask**、exit 0（原 allow）。
  - `npm test --x` → **allow**、exit 0（未列入 allowlist 仍升級）。
- fixture 含 `Bash(/opt/tools/run.sh *)`：
  - `/opt/tools/run.sh --x > /etc/passwd` → **ask**、exit 0。

## 7. 非目標 / 範圍界線

- **不**處理 DRAFT 發現 B（exec/argv 扁平化跨界匹配）——維持現行 deny 對稱守護、文件化為已知限制，留待日後「結構化比對模型」設計。
- **不**改 `reconstructCommand`/`settingsAllows` 的字串比對模型、**不**把 redirect 納入比對字串（本設計以「分流不可升級 ask」達成目的，無需動比對模型）。
- **不**改 `canonicalizeExecPath` 或任何路徑正規化（前一 feature 已完成）。

## 8. 後續

- 以本 spec 為輸入，進入 `superpowers-codex:writing-plans` 產出實作計畫。
- DRAFT 檔（發現 A 已由本 spec 承接）可於實作完成後清理或標注「發現 A 已解、發現 B 待辦」。
