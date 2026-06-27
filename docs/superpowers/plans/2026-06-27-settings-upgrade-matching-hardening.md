# 升級層重新定位 — 中央前置規則成「通用不可升級硬 ask」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `permissions.allow` 升級層的接點從「對 `classifyBuiltin` 最終 verdict」收斂到「只對可升級 ask」，並把四條中央安全前置規則上移成「對所有指令、在升級之前」的通用不可升級硬 ask 閘。

**Architecture:** 重構 `src/engine/classify.ts` 的決策順序（合併現行 `classifyBuiltin` + `classify` 兩層）：① 動態指令名 → ask；② 指令規則評估、硬 deny 最優先短路；③ 四條中央前置（通用、不可升級）；④ 可升級 ask（未列入 allowlist 或指令規則自身 ask）才呼叫 `settingsAllows`；⑤ 指令規則 allow。`classify` 對外簽名與回傳型別不變；`settingsAllows`/`reconstructCommand`/各指令規則/`scope.ts`/`redirect.ts` 皆不動。詳見 spec `docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-design.md`（owner 已接受 §4.6.1 residual：維持 classify.ts-only、不採 two-phase）。

**Tech Stack:** Deno + TypeScript；測試 `deno test`；`deno task check / lint / test / build`。

---

## 檔案結構（哪些檔案動、各自負責什麼）

- **Modify:** `src/engine/classify.ts` — 重構決策順序，新增純函式 `centralPreflightAsk`；移除舊 `classifyBuiltin`。唯一行為變更來源。
- **Modify (test):** `src/engine/classify_test.ts` — 翻轉 1 個既有測試（範圍外 `<` 改為不可升級）、新增中央前置不可升級 / 指令規則 allow 覆寫 / 可升級不退化測試。
- **Modify (test):** `src/main_test.ts` — 新增 1 條 e2e：settings allow + 寫入重導向 → ask（用既有 fixture）。
- **Modify (docs):** `CLAUDE.md` — 更新「架構（評估管線）」與「四條中央前置規則」段落，反映新流程。
- **Modify (docs):** `docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-DRAFT.md` — 標注發現 A 已解、發現 B 為已知限制。
- **不動：** `src/permissions/matcher.ts`、`src/rules/**`、`src/engine/scope.ts`、`src/engine/redirect.ts`、`src/engine/evaluate.ts`、`src/engine/combine.ts`、`src/testdata/proj-with-settings/.claude/settings.json`（已含所需規則）。

---

## 前置稽核（撰寫計畫時已完成，無需於實作時重跑）

設計接受的 residual（指令規則純函式契約）所需的稽核**已在撰寫本計畫時完成**：對 `src/rules/` 執行

```bash
grep -rnE "Deno\.(write|run|Command|create|remove|mkdir|open|truncate|copy|rename|symlink|link|chmod|chown|makeTemp)" src/rules/
```

結果**無任何輸出（exit code 1）**，確認 `src/rules/`（含 `commands/*.ts` 與 `factory.ts`）所有規則 `evaluate`
皆未呼叫檔案系統 / 子行程 API、為純函式。此結論已自足地寫入 `classify.ts` 的 `centralPreflightAsk` doc 註解
（Task 1 Step 5），不另立稽核任務。**若實作期間任何規則新增了上述 API，須停止並回報**（residual 假設破口）。

---

## Task 1: 重構 `classify.ts` 決策順序 + 中央前置通用化

**Files:**
- Modify: `src/engine/classify.ts`（整檔重寫）
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 翻轉既有測試「輸入重導向 ask 可被 Bash() 升級」為不可升級**

於 `src/engine/classify_test.ts` 找到這段（約 line 261-263）：

```ts
Deno.test("輸入重導向 ask 可被 Bash() 升級", () => {
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "allow");
});
```

整段替換為（語義反轉：範圍外 `<` 是中央前置安全 ask，`permissions.allow` 不可解除）：

```ts
Deno.test("輸入重導向（範圍外 <）為不可升級中央前置：Bash() 不升級、維持 ask", () => {
  // 行為變更：範圍外 < 為中央前置安全 ask，permissions.allow 不可解除
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "ask");
});
```

> 保留同檔 line 265-268 的「輸入重導向 ask 可被 Read() 讀取範圍放寬升級」測試**不變**：`Read()` 在中央前置判定前就改寫 `scope`、使 `<` 目標落 in-project、中央前置 d 不觸發 → 仍 allow。

- [ ] **Step 2: 新增「中央前置不可升級 × 四條 × 兩態」測試**

於 `src/engine/classify_test.ts` 檔案尾端（最後一個 `Deno.test` 之後）新增：

```ts
Deno.test("中央前置不可升級：寫入重導向 × allowlisted / 非-allowlist", () => {
  // allowlisted：cat 規則本會 allow，但寫入重導向覆寫、且不可由 Bash(cat:*) 升級
  assertEquals(onlyWith("cat src/a.ts > out.txt", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  // 非-allowlist：npm 未列入 allowlist，寫入重導向不可由 Bash(npm test:*) 升級
  assertEquals(onlyWith("npm test x > out.txt", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：cwd 超範圍 × allowlisted / 非-allowlist", () => {
  const allowlisted = walk(parseCommand("cd /tmp && cat a").script, START, ROOT)
    .find((i) => i.name === "cat")!;
  assertEquals(classify(allowlisted, ROOT, rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  const nonAllow = walk(parseCommand("cd /tmp && npm test").script, START, ROOT)
    .find((i) => i.name === "npm")!;
  assertEquals(classify(nonAllow, ROOT, rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：賦值前綴 × allowlisted / 非-allowlist（維持 ask）", () => {
  assertEquals(onlyWith("FOO=bar cat a", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  assertEquals(onlyWith("FOO=bar npm test", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：範圍外 < × allowlisted / 非-allowlist", () => {
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "ask");
  assertEquals(onlyWith("npm test < /etc/passwd", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});
```

- [ ] **Step 3: 新增「指令規則 allow 被中央前置覆寫」與「可升級不退化」測試**

接續於 `src/engine/classify_test.ts` 檔案尾端新增：

```ts
Deno.test("指令規則 allow 被中央前置覆寫、不洩漏成 allow", () => {
  // cat README.md / pwd 規則本會 allow；疊加各中央前置觸發條件 + 會命中的 Bash() 仍為 ask
  assertEquals(onlyWith("cat README.md > out.txt", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask"); // 寫入重導向
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");       // 範圍外 <
  const outCwd = walk(parseCommand("cd /tmp && pwd").script, START, ROOT)
    .find((i) => i.name === "pwd")!;                                                                  // cwd 超範圍
  assertEquals(classify(outCwd, ROOT, rulesOf({ allow: ["Bash(pwd:*)"] })).kind, "ask");
});

Deno.test("可升級不退化：指令規則自身範圍外讀取 ask 仍可由 Bash() 升級", () => {
  // grep 對 /etc/passwd → 規則 ask（非中央前置）→ 可升級為 allow
  assertEquals(onlyWith("grep needle /etc/passwd", rulesOf({ allow: ["Bash(grep *)"] })).kind, "allow");
});
```

> 「非-allowlist 無中央前置仍可升級」已由既有測試 `settings allow upgrades ask -> allow`（`npm test x` + `Bash(npm test:*)` → allow，約 line 68-70）覆蓋，不重複新增。

- [ ] **Step 4: 執行新增/翻轉測試，確認在現行程式碼上 FAIL（紅燈）**

Run: `deno test --allow-env --allow-read src/engine/classify_test.ts`
Expected: FAIL。下列新/翻轉案例在**現行**程式碼回 allow（被升級層誤升），與斷言的 ask 不符：
- `輸入重導向（範圍外 <）為不可升級中央前置...`（現行 allow）
- `中央前置不可升級：寫入重導向 ...`（現行 allow）
- `中央前置不可升級：cwd 超範圍 ...`（現行 allow）
- `中央前置不可升級：範圍外 < ...`（現行 allow）
- `指令規則 allow 被中央前置覆寫...`（現行 allow）

（賦值前綴測試與「可升級不退化」測試在現行程式碼即已通過，屬回歸護欄。）

- [ ] **Step 5: 整檔重寫 `src/engine/classify.ts`**

把 `src/engine/classify.ts` 全檔內容替換為：

```ts
import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { allow, ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { dangerousRoot, isReadScoped, normalizeAbsolute, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { resolveUrl } from "../permissions/domain_scope.ts";

/**
 * 四條中央前置安全規則（對所有指令通用、不可由 permissions.allow 升級）。
 * 命中任一回不可升級的 `ask`，否則回 `null`。純函式、不碰檔案系統。
 * 呼叫端保證 inv.name !== null（動態指令名已於 classify 先行處理）。
 *
 * 順序安全性：本前置覆寫指令規則的 allow/ask，唯一能越過它先行返回的是指令規則的 deny
 * （更嚴格、安全方向）。指令規則的 evaluate 為純函式、無副作用（已於 2026-06-27 以 grep 稽核
 * src/rules/ 確認無 Deno 檔案系統/子行程 API），故步驟 2 在「危險 cwd/redirect」情境下呼叫
 * rule.evaluate 無 runtime 危害；任何帶中央前置觸發條件的指令永不可能成為 allow。
 */
function centralPreflightAsk(inv: CommandInvocation, scope: ScopeConfig): RuleVerdict | null {
  // 一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）
  if (inv.cwd.kind === "known" && !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // 二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }
  // 三：環境變數賦值前綴（LD_PRELOAD/BASH_ENV 等）可改變執行行為
  if (inv.assignments.length > 0) {
    return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);
  }
  // 四：輸入重導向 `<` 的目標路徑須落在允許讀取範圍
  for (const r of inv.redirects) {
    if (r.operator !== "<") continue; // 只查讀檔 `<`；heredoc/here-string 與 fd 複製不在此
    if (!r.target) continue;
    if (resolvePath(r.target, inv.cwd, scope) !== "in-project") {
      return ask(`${inv.name}：輸入重導向讀取超出專案範圍或無法靜態解析（${r.target.value}）`);
    }
  }
  return null;
}

/**
 * 對單一指令呼叫判定 allow / ask / deny。
 *
 * 決策順序：
 *  1. 動態指令名 → 不可升級 ask。
 *  2. 指令規則評估；其硬 deny（遞迴遍歷磁碟根/家目錄根）最優先，不經中央前置、不經升級層。
 *  3. 四條中央前置（通用、不可升級）任一命中 → ask。
 *  4. 可升級 ask：未列入 allowlist、或指令規則自身 ask → 命中 settings allow（未被 deny/ask 命中）則升級。
 *  5. 指令規則 allow → allow。
 */
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
): RuleVerdict {
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: trustedReadRoots,
  };

  // 步驟 1：動態指令名
  if (inv.name === null) return ask("動態指令名，無法判定");

  // 步驟 2：指令規則評估 + 硬 deny 短路（deny 最優先，先於中央前置與升級層）
  const rule = lookupRule(inv.name);
  const ruleVerdict: RuleVerdict | null = rule
    ? rule.evaluate({
      name: inv.name,
      argv: inv.argv,
      redirects: inv.redirects,
      assignments: inv.assignments,
      cwd: inv.cwd,
      resolvePath: (w) => resolvePath(w, inv.cwd, scope),
      resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
      resolveUrl: (v) => resolveUrl(v, rules.webFetch),
      isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
    })
    : null;
  if (ruleVerdict?.kind === "deny") return ruleVerdict;

  // 步驟 3：四條中央前置（通用、不可升級）
  const central = centralPreflightAsk(inv, scope);
  if (central) return central;

  // 步驟 4：可升級 ask（未列入 allowlist 或指令規則自身 ask）
  if (ruleVerdict === null || ruleVerdict.kind === "ask") {
    if (settingsAllows(inv, rules, scope.home)) return allow();
    return ruleVerdict ?? ask(`未列入 allowlist 的指令：${inv.name}`);
  }

  // 步驟 5：指令規則 allow
  return ruleVerdict;
}
```

- [ ] **Step 6: 執行完整測試套件，確認全綠**

Run: `deno test --allow-run --allow-env --allow-read`
Expected: PASS（全部測試通過，含 Step 1-3 新增/翻轉案例與既有 e2e）。

- [ ] **Step 7: 型別檢查與 lint**

Run: `deno task check && deno task lint`
Expected: 兩者皆無錯誤（特別確認 `classify.ts` 無未使用 import：已移除舊 `WebFetchRules` 型別匯入）。

- [ ] **Step 8: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "fix(classify): make central preflight a universal non-upgradable hard ask

Relocate the permissions.allow upgrade point: the four central safety
preconditions (cwd scope, write redirect, env-assignment prefix, out-of-scope
< input) now apply to all commands (allowlisted or not) before any
settingsAllows upgrade, and can no longer be upgraded by a Bash(...) allow
rule. Only not-in-allowlist asks and command-rule asks remain upgradable.
Merges the old classifyBuiltin/classify two layers into one ordered flow.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: e2e 鎖定（真實流程：settings allow + 寫入重導向 → ask）

**Files:**
- Test: `src/main_test.ts`（新增 1 條，使用既有 `SETTINGS_FIXTURE`，其 settings.json 已含 `Bash(npm test:*)`）

- [ ] **Step 1: 新增 e2e 測試**

於 `src/main_test.ts` 找到既有測試 `e2e: command matching settings allow -> allow (upgrade)`（約 line 68-74），在其**後方**新增：

```ts
Deno.test("e2e: settings allow + 寫入重導向 -> ask（中央前置不可升級）", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm test --x > /etc/passwd" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
```

> `cwd: SETTINGS_FIXTURE` 確保 cwd 落在該 fixture 專案內（cwd 中央前置不觸發），單獨驗證寫入重導向 `> /etc/passwd` 這條中央前置不被 `Bash(npm test:*)` 升級。

- [ ] **Step 2: 執行 e2e 測試，確認通過**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: PASS（新測試回 ask；既有 `npm test --silent -> allow`、`npm run build -> ask` 等不受影響）。

- [ ] **Step 3: Commit**

```bash
git add src/main_test.ts
git commit -m "test(main): e2e lock settings-allow + write redirect stays ask

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 更新 `CLAUDE.md` 架構說明 + 標注 DRAFT（發現 A 已解、發現 B 為已知限制）

**Files:**
- Modify: `CLAUDE.md`（「架構（評估管線）」的 `classify.ts` 條目 + 「四條中央前置規則」段落）
- Modify: `docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-DRAFT.md`（頂端狀態區塊加更新註）

- [ ] **Step 1: 更新「架構（評估管線）」的 `classify.ts` 條目**

於 `CLAUDE.md` 找到描述 `classify.ts` 「分兩層」的那條 bullet（以 `**`classify.ts`** 分兩層` 開頭），整條替換為反映新流程的描述（自足、不引用 spec/plan 文件）：

```markdown
- **`classify.ts`** 單一有序流程：① `name` 為 null（動態）→ 不可升級 ask；② 評估指令規則，其硬 `deny`
  （遞迴遍歷磁碟根/家目錄根）最優先短路、不經中央前置與升級層；③ **四條中央前置規則**（見下）對
  **所有指令**（含未列入 allowlist 者）通用、命中即回**不可升級** ask；④ 可升級 ask（未列入 allowlist、
  或指令規則自身 ask）才呼叫 `settingsAllows` 嘗試以 `permissions.allow` 升級為 `allow`（命中 allow 且未被
  deny/ask 命中才升級）；⑤ 指令規則 `allow` → allow。純函式 `centralPreflightAsk` 封裝步驟 ③。
  **中央前置 ask 永不進升級層。**
```

- [ ] **Step 2: 更新「四條中央前置規則」段落開頭描述**

於 `CLAUDE.md` 找到 `### 四條中央前置規則` 標題下、以 ``classifyBuiltin` **先評估個別指令規則**` 開頭的段落，整段替換為（自足、不引用 spec/plan 文件）：

```markdown
`classify` **先評估指令規則**：若其回硬 `deny`（遞迴根掃描）立即返回，使硬 deny 不被中央前置 ask 遮蔽、
亦不被升級層解除。指令規則非 deny 時，對**所有指令**（不論是否 allowlisted）施加以下四條中央前置規則
（命中即回**不可升級** `ask`，先於可升級 ask 區的 `settingsAllows`）；其安全性不依賴指令規則內部行為
（中央前置覆寫 rule 的 allow/ask，唯一越過的是 rule deny；此順序依賴 rule.evaluate 純函式契約）：
```

> 同段落下方「1. cwd 範圍 / 2. 寫入型重導向 / 3. 環境變數賦值前綴 / 4. 輸入重導向」四條列舉**保持不變**（規則內容未變，僅套用範圍由「allowlisted」擴及「所有指令」、且改為不可升級）。

- [ ] **Step 3: 標注 DRAFT — 發現 A 已解、發現 B 維持已知限制**

於 `docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-DRAFT.md` 頂端狀態引言區塊（以 `> **狀態：草稿（DRAFT）**` 開頭的整段引言）之後，新增一段更新註（原檔其餘內容保持不動）：

```markdown
> **更新（2026-06-27）**：**發現 A 已解**——由設計 `2026-06-27-settings-upgrade-matching-hardening-design.md`
> 及其實作計畫承接（中央前置規則升級為「通用不可升級硬 ask」）。**發現 B 維持已知限制**：exec/argv 去引號
> 扁平化的跨界匹配未在本次處理，沿用現行 deny 對稱守護（admin 加 path-equivalent deny 即可一致擋下），
> 留待日後「結構化比對模型」設計；其嚴重度低（需使用者本就有含空白執行檔路徑的 allow 規則、無資料遺失語義）。
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-06-27-settings-upgrade-matching-hardening-DRAFT.md
git commit -m "docs: universal non-upgradable central preflight; mark finding A done, B known-limitation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Build + Operational verification（改規則後必做）

**Files:** 無（純驗證，不 commit）

- [ ] **Step 1: 全套驗證 + 編譯**

Run: `deno task check && deno task lint && deno task test && deno task build`
Expected: 全綠；`dist/permission-checker`（或 `.exe`）產出成功。

- [ ] **Step 2: 餵真實 JSON 給 binary — 寫入重導向不可升級（非-allowlist）**

Run（fixture 已含 `Bash(npm test:*)`）：
```bash
FIX="$(pwd)/src/testdata/proj-with-settings"
echo '{"tool_name":"Bash","tool_input":{"command":"npm test --x > /etc/passwd"},"cwd":"'"$FIX"'"}' \
  | CLAUDE_PROJECT_DIR="$FIX" ./dist/permission-checker
```
Expected: 輸出 JSON 的 `permissionDecision` 為 **`ask`**、行程 exit 0。

- [ ] **Step 3: 餵真實 JSON — 無 redirect 仍可升級（回歸護欄）**

Run:
```bash
FIX="$(pwd)/src/testdata/proj-with-settings"
echo '{"tool_name":"Bash","tool_input":{"command":"npm test --x"},"cwd":"'"$FIX"'"}' \
  | CLAUDE_PROJECT_DIR="$FIX" ./dist/permission-checker
```
Expected: `permissionDecision` 為 **`allow`**、exit 0（未列入 allowlist 的 ask 仍可由 `Bash(npm test:*)` 升級）。

- [ ] **Step 4: 餵真實 JSON — 非-allowlist 腳本 + 寫入重導向不可升級**

Run（fixture 已含 `Bash(/opt/tools/run.sh *)`）：
```bash
FIX="$(pwd)/src/testdata/proj-with-settings"
echo '{"tool_name":"Bash","tool_input":{"command":"/opt/tools/run.sh --x > /etc/passwd"},"cwd":"'"$FIX"'"}' \
  | CLAUDE_PROJECT_DIR="$FIX" ./dist/permission-checker
```
Expected: `permissionDecision` 為 **`ask`**、exit 0。

- [ ] **Step 5: 確認三項 operational verification 結果與預期一致**

若 Step 2 或 Step 4 回 `allow`（未被擋下），代表中央前置未生效 → 回頭檢查 Task 1 的 classify.ts 重構。若 Step 3 回 `ask`，代表可升級路徑被誤收緊 → 同樣回頭檢查。三項皆符合預期才算完成。

---

## 完成準則（Definition of Done）

- `deno task check && deno task lint && deno task test` 全綠。
- `deno task build` 成功；Task 4 三項 operational verification 結果分別為 ask / allow / ask。
- 既有翻轉測試（範圍外 `<` + Bash → ask）與全部新增測試通過；其餘既有測試不破。
- `CLAUDE.md` 架構說明與新流程一致；`classify.ts` 含稽核日期註解。
- 不變量維持：deny 三類最優先且不可升級、指令規則硬 deny 優先於中央前置、中央前置 ask 不可升級、未列入 allowlist 與指令規則 ask 仍可升級、`Read()/Edit()/Write()` 讀取範圍放寬不受影響、`classify` 對外簽名不變。
