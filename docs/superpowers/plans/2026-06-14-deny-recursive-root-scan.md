# Deny Recursive Root/Home Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓本 hook 在「唯讀指令遞迴遍歷一個恰好等於磁碟根或家目錄根的路徑」時回傳 `deny`（硬性、不可由 `permissions.allow` 解除），其餘行為不變。

**Architecture:** 在既有 parse→walk→classify→combine 管線上：(1) 把 verdict 從 `allow|ask` 擴為三態加入 `deny`；(2) 在 `scope.ts` 新增「危險根偵測」述詞 `dangerousRoot`（含 `~`、lone `$HOME`/`${HOME}`、靜態絕對等於根三來源）；(3) 在會遞迴遍歷的 4 個指令（find/tree/ls/grep 家族）接「遞迴閘門」，遞迴啟用且遍歷根命中危險根時回 `deny`；(4) `classify` 對 builtin `deny` 短路，不經 `permissions.allow` 升級層。

**Tech Stack:** Deno + TypeScript，`unbash@3.0.0` 解析 Bash AST，`@std/assert` 測試。每次改動後跑 `deno task check && deno task lint && deno task test`。

設計來源：[docs/superpowers/specs/2026-06-14-deny-recursive-root-scan-design.md](../specs/2026-06-14-deny-recursive-root-scan-design.md)

---

## File Structure

| 檔案 | 職責 | 變更 |
|---|---|---|
| `src/types.ts` | 引擎 verdict 型別 | `Verdict` 加 `"deny"` |
| `src/rules/types.ts` | 規則 verdict + RuleContext + helper | `RuleVerdict` deny 態、`deny()`、`recursiveRootDenyReason()`、`RuleContext.isDangerousRoot` |
| `src/engine/combine.ts` | 多指令合併 | `deny > ask > allow` |
| `src/engine/scope.ts` | 路徑範圍 + 危險根偵測 | `ScopeConfig.home`、`isDangerousRootAbs`、`dangerousRoot`、`rootScope` 補 home |
| `src/engine/classify.ts` | 單指令判定 + 升級層 | 綁 `isDangerousRoot`、deny 短路、scope 帶 home |
| `src/engine/evaluate.ts` | 主流程 | 簽名加 `home`，向下傳 |
| `src/main.ts` | hook 進入點 | `homeDir(env)`，傳入 `evaluate` |
| `src/rules/factory.ts` | 通用唯讀規則工廠 | `recursive?` 選項 + 迴圈內 deny |
| `src/rules/commands/find.ts` | find 規則 | starts 的 `isDangerousRoot` → deny |
| `src/rules/commands/simple-flag.ts` | tree 等規則 | `treeRule` 加 `recursive: () => true` |
| `src/rules/commands/coreutils.ts` | cat/ls 等規則 | `fileReaderRule` 加 ls `-R` 遞迴述詞 |
| `src/rules/commands/grep.ts` | grep/rg 規則 | `grepRule` 加 grep/rg 遞迴述詞 |
| `CLAUDE.md` | 專案說明 | 不變量更新 |

測試檔：對應上述各檔的 `*_test.ts`，外加新增 `src/rules/types_test.ts`、`src/engine/scope_test.ts` 的 `scopeWith` 補 `home`、10 個 `src/rules/commands/*_test.ts` 的 `ctxOf` helper 補 `isDangerousRoot`。

**全程不變量**：每個 Task 結束時 `deno task check && deno task lint && deno task test` 必須全綠（編譯綠 = 該 Task 自洽）。

---

## Task 1: Verdict 三態化與 deny helper

**Files:**
- Modify: `src/types.ts`
- Modify: `src/rules/types.ts`
- Test: `src/rules/types_test.ts`（新建）

- [ ] **Step 1: 寫失敗測試**

新建 `src/rules/types_test.ts`：

```ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { deny, recursiveRootDenyReason } from "./types.ts";

Deno.test("deny() 建構 deny verdict", () => {
  assertEquals(deny("理由X"), { kind: "deny", reason: "理由X" });
});

Deno.test("recursiveRootDenyReason 含指令名/目標/禁止字樣/替代建議", () => {
  const r = recursiveRootDenyReason("find", "/");
  assertStringIncludes(r, "find");
  assertStringIncludes(r, "/");
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "請改為");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/rules/types_test.ts`
Expected: FAIL（`deny` / `recursiveRootDenyReason` 未匯出）

- [ ] **Step 3: 實作**

`src/types.ts` 第 3 行：

```ts
export type Verdict = "allow" | "ask" | "deny";
```

`src/rules/types.ts`：把 `RuleVerdict` union 與建構子改為（在 `ask` 後追加 deny 態與兩個函式）：

```ts
export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
}

/** 便利建構子。 */
export const allow = (): RuleVerdict => ({ kind: "allow" });
export const ask = (reason: string): RuleVerdict => ({ kind: "ask", reason });
export const deny = (reason: string): RuleVerdict => ({ kind: "deny", reason });

/** 產生「遞迴遍歷磁碟根/家目錄根」的 deny 理由（會回饋給 agent，故須解釋原因 + 替代）。 */
export function recursiveRootDenyReason(name: string, target: string): string {
  return `已禁止：${name} 會遞迴遍歷磁碟根或家目錄根（${target}）。` +
    `此操作會掃描跨專案、跨使用者的大量檔案，屬資料外洩 / 偵察的高風險行為。` +
    `請改為指定專案內的具體子目錄（例如 ./src），而非 / 或 ~。`;
}
```

> 註：`RuleContext.isDangerousRoot` 不在本 Task 加入（會牽動所有 `ctxOf` helper），延後到 Task 5。本 Task 僅加 union 成員與函式，既有 `combine.ts`/`classify.ts` 以 if 判斷、不做 exhaustive switch，故編譯仍綠。

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/rules/types_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/rules/types.ts src/rules/types_test.ts
git commit -m "feat(types): add deny verdict and recursiveRootDenyReason helper"
```

---

## Task 2: combine 改 deny > ask > allow

**Files:**
- Modify: `src/engine/combine.ts`
- Test: `src/engine/combine_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/combine_test.ts` 末尾追加：

```ts
Deno.test("combine: 任一 deny -> deny，取首個 deny 理由", () => {
  assertEquals(
    combine([
      { kind: "allow" },
      { kind: "deny", reason: "d1" },
      { kind: "ask", reason: "a1" },
      { kind: "deny", reason: "d2" },
    ]),
    { verdict: "deny", reason: "d1" },
  );
});

Deno.test("combine: 無 deny 時 ask 蓋過 allow", () => {
  assertEquals(
    combine([{ kind: "allow" }, { kind: "ask", reason: "a1" }]).verdict,
    "ask",
  );
});
```

> 若 `combine_test.ts` 尚未 import `combine`/`assertEquals`，沿用檔案既有 import（首行已有）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: FAIL（deny 案例回 ask 或 allow，非 deny）

- [ ] **Step 3: 實作**

`src/engine/combine.ts` 全檔改為：

```ts
import type { Decision } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";

/** 最弱環節：任一 deny → 整體 deny；否則任一 ask → ask；全部 allow → allow（取首個對應理由）。 */
export function combine(verdicts: RuleVerdict[]): Decision {
  for (const v of verdicts) {
    if (v.kind === "deny") return { verdict: "deny", reason: v.reason };
  }
  for (const v of verdicts) {
    if (v.kind === "ask") return { verdict: "ask", reason: v.reason };
  }
  return { verdict: "allow", reason: "全部指令均通過（唯讀放行或命中 permissions.allow）" };
}
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/engine/combine.ts src/engine/combine_test.ts
git commit -m "feat(engine): combine with deny > ask > allow precedence"
```

---

## Task 3: scope.ts 危險根偵測 + ScopeConfig.home

**Files:**
- Modify: `src/engine/scope.ts`
- Modify: `src/engine/classify.ts:47`（暫補 `home: null` 佔位，Task 4 接真值）
- Test: `src/engine/scope_test.ts`（含 `scopeWith` helper 補 `home`）

- [ ] **Step 1: 寫失敗測試**

先更新 `src/engine/scope_test.ts` 的 `scopeWith` helper（約 line 117-124），在回傳物件補 `home: null`：

```ts
function scopeWith(
  allowRoots: string[] = [],
  denyRoots: string[] = [],
  askRoots: string[] = [],
  allowFiles: string[] = [],
): ScopeConfig {
  return {
    root: "/proj",
    home: null,
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
  };
}
```

在 `src/engine/scope_test.ts` 頂部，把既有 `from "./scope.ts"`（line 4）那行補上 `dangerousRoot, isDangerousRootAbs`，並新增一行 import `CwdState`：

```ts
import { dangerousRoot, isDangerousRootAbs, isReadScoped, isWithin, normalizeAbsolute, resolvePath, rootScope, type PathScope, type ScopeConfig } from "./scope.ts";
import type { CwdState } from "../types.ts";
```

> `parse`/`Command` 已於檔頭 import（line 2-3）；既有 helper `firstArg`（line 6-8，回傳 `Word`）**直接沿用、不要重新宣告**（重複宣告會編譯失敗）。`Word` 型別不需另外 import（`firstArg` 回傳值已是 `Word`，可直接傳入 `dangerousRoot`）。

在檔案末尾追加 `KNOWN` 常數與測試（沿用既有 `firstArg`）：

```ts
const KNOWN: CwdState = { kind: "known", path: "/proj" };

Deno.test("isDangerousRootAbs: 磁碟根 / 家目錄 / 子目錄", () => {
  assertEquals(isDangerousRootAbs("/", null), true);
  assertEquals(isDangerousRootAbs("C:/", null), true); // 磁碟根偵測跨平台（正則 ^[A-Za-z]:/$）
  assertEquals(isDangerousRootAbs("D:/", null), true);
  assertEquals(isDangerousRootAbs("/usr", null), false);
  assertEquals(isDangerousRootAbs("/home/me", "/home/me"), true);
  assertEquals(isDangerousRootAbs("/home/me/x", "/home/me"), false);
});

Deno.test("dangerousRoot: tilde 與磁碟根", () => {
  assertEquals(dangerousRoot(firstArg("find ~"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find /"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find ~/.claude"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find ."), KNOWN, null), false);
});

Deno.test("dangerousRoot: $HOME 各形式", () => {
  assertEquals(dangerousRoot(firstArg("find $HOME"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find ${HOME}"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find $HOME/"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find $HOME/foo"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find $HOMER"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find ${HOME:-/tmp}"), KNOWN, null), false);
});

Deno.test("dangerousRoot: 靜態絕對等於 home（需 home）", () => {
  assertEquals(dangerousRoot(firstArg("find /home/me"), KNOWN, "/home/me"), true);
  assertEquals(dangerousRoot(firstArg("find /home/me"), KNOWN, null), false);
});

Deno.test("dangerousRoot: cwd 未知的相對路徑不可確認", () => {
  assertEquals(dangerousRoot(firstArg("find sub"), { kind: "unknown" }, null), false);
});

Deno.test("dangerousRoot: 磁碟根字面（跨平台）", () => {
  assertEquals(dangerousRoot(firstArg("find C:/"), KNOWN, null), true);
});

Deno.test({
  name: "dangerousRoot: $USERPROFILE 在 Windows 視為家目錄根",
  ignore: Deno.build.os !== "windows",
  fn() {
    assertEquals(dangerousRoot(firstArg("find $USERPROFILE"), KNOWN, null), true);
  },
});

Deno.test({
  name: "dangerousRoot: $USERPROFILE 在非 Windows 不算家目錄根",
  ignore: Deno.build.os === "windows",
  fn() {
    assertEquals(dangerousRoot(firstArg("find $USERPROFILE"), KNOWN, null), false);
  },
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL（`dangerousRoot`/`isDangerousRootAbs` 未匯出）

- [ ] **Step 3: 實作**

`src/engine/scope.ts`：

1. 頂部 import 補 `WordPart`：

```ts
import type { Word, WordPart } from "../deps.ts";
```

2. `ScopeConfig`（約 line 77）加入必填 `home`：

```ts
export interface ScopeConfig {
  root: string;
  home: string | null;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}
```

3. `rootScope`（約 line 85）回傳物件補 `home: null`：

```ts
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    home: null,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
  };
}
```

4. 檔案末尾新增危險根偵測（`isWindows`/`normalizeAbsolute`/`isAbsolute`/`staticValue`/私有 `resolveAgainst` 皆同檔可用）：

```ts
const HOME_VAR_NAMES = IS_WINDOWS ? ["HOME", "USERPROFILE"] : ["HOME"];

/** 已正規化絕對 POSIX 路徑是否為磁碟根（/、X:/）或恰好等於家目錄。 */
export function isDangerousRootAbs(absPosix: string, home: string | null): boolean {
  if (absPosix === "/") return true;
  if (/^[A-Za-z]:\/$/.test(absPosix)) return true;
  if (home !== null && absPosix === normalizeAbsolute(home)) return true;
  return false;
}

/** Word 是否為「單獨的家目錄變數展開」：$HOME / ${HOME} / $HOME/ / $USERPROFILE(Windows)。 */
function loneHomeExpansion(word: Word): boolean {
  const parts = word.parts;
  if (!parts || parts.length === 0) return false;
  let head: WordPart;
  if (parts.length === 1) {
    head = parts[0];
  } else if (parts.length === 2 && parts[1].type === "Literal" && parts[1].value === "/") {
    head = parts[0]; // $HOME/（純結尾斜線 = 家目錄本身）
  } else {
    return false;
  }
  if (head.type === "SimpleExpansion") {
    const name = head.text.startsWith("$") ? head.text.slice(1) : "";
    return HOME_VAR_NAMES.includes(name);
  }
  if (head.type === "ParameterExpansion") {
    // 純 ${HOME}：任何修飾子（:- / # / ! / index…）都會讓 text ≠ "${<parameter>}"
    return head.text === "${" + head.parameter + "}" && HOME_VAR_NAMES.includes(head.parameter);
  }
  return false;
}

/**
 * Word 是否指向磁碟根 / 家目錄根：
 *   1) lone home expansion（$HOME/${HOME}/$HOME/、Windows $USERPROFILE）
 *   2) 字面 ~ 或 ~/
 *   3) 靜態絕對/相對解析後 isDangerousRootAbs
 *   其餘（動態、cwd 未知的相對路徑、子目錄）→ false
 */
export function dangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean {
  if (loneHomeExpansion(arg)) return true; // 先於 staticValue：展開類 Word 的 staticValue 為 null
  const v = staticValue(arg);
  if (v === null) return false;
  if (v === "~" || v === "~/") return true;
  let abs: string;
  if (isAbsolute(v)) {
    abs = normalizeAbsolute(v);
  } else {
    if (cwd.kind === "unknown") return false;
    abs = resolveAgainst(cwd.path, v);
  }
  return isDangerousRootAbs(abs, home);
}
```

5. `src/engine/classify.ts` 第 47 行的 `ScopeConfig` 字面值補 `home: null`（暫時佔位；Task 4 接真值），使編譯通過：

```ts
  const scope: ScopeConfig = {
    root,
    home: null,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
  };
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts src/engine/classify.ts
git commit -m "feat(scope): add dangerousRoot detection and ScopeConfig.home"
```

---

## Task 4: 穿入 home（classify / evaluate / main.homeDir）

**Files:**
- Modify: `src/engine/classify.ts`
- Modify: `src/engine/evaluate.ts`
- Modify: `src/main.ts`
- Test: `src/main_test.ts`（新增 `homeDir` 單元測試）

- [ ] **Step 1: 寫失敗測試**

在 `src/main_test.ts` 頂部 import 區補：

```ts
import { homeDir } from "./main.ts";
import { normalizeAbsolute } from "./engine/scope.ts";
```

在檔案末尾追加：

```ts
Deno.test("homeDir: 讀 HOME 並正規化（去結尾斜線）", () => {
  assertEquals(homeDir({ get: (k: string) => (k === "HOME" ? "/home/me/" : undefined) }), "/home/me");
});

Deno.test("homeDir: HOME 未設時退回 USERPROFILE", () => {
  assertEquals(
    homeDir({ get: (k: string) => (k === "USERPROFILE" ? "/c/Users/me" : undefined) }),
    normalizeAbsolute("/c/Users/me"),
  );
});

Deno.test("homeDir: 皆未設 -> null", () => {
  assertEquals(homeDir({ get: () => undefined }), null);
});
```

> `src/main_test.ts` 首行已 import `assertEquals`，沿用。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env --allow-read --allow-run src/main_test.ts`
Expected: FAIL（`homeDir` 未匯出）

- [ ] **Step 3: 實作**

`src/engine/classify.ts`：`classify` 簽名加 `home`，並把第 47 行 Task 3 暫填的 `home: null` 改為 `home`（classify import 維持原樣，`dangerousRoot` 的 import 留到 Task 5 使用時再加，以免 lint 報未使用）：

```ts
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
): RuleVerdict {
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
  };
  const v = classifyBuiltin(inv, scope);
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
}
```

> 本步驟只改 `classify` 簽名與 `home`；`classifyBuiltin` 的 ctx 綁定 `isDangerousRoot` 在後續任務加入、deny 短路也在後續任務加入。此處 `classify` 主體與目前原始碼一致。

`src/engine/evaluate.ts`：`evaluate` 簽名加 `home`，傳給 `classify`：

```ts
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules, home)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

4. `src/main.ts`：頂部 import 已有 `normalizeAbsolute`。新增 `homeDir` 並在 `evaluate` 呼叫處傳入：

```ts
/** 讀取家目錄絕對路徑（HOME 優先、否則 USERPROFILE）；未設定回 null。 */
export function homeDir(env: { get(key: string): string | undefined }): string | null {
  const h = env.get("HOME") ?? env.get("USERPROFILE");
  if (!h || h.trim() === "") return null;
  return normalizeAbsolute(h.trim());
}
```

並把 `main()` 內 `decision = evaluate(command, root, initialCwd(input.cwd, root), rules);` 改為：

```ts
    const home = homeDir(Deno.env);
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home);
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env --allow-read --allow-run src/main_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（既有 e2e 與 evaluate 測試不受影響：home 預設 null、尚無規則使用）

- [ ] **Step 5: Commit**

```bash
git add src/engine/classify.ts src/engine/evaluate.ts src/main.ts src/main_test.ts
git commit -m "feat(engine): thread home dir through evaluate and classify"
```

---

## Task 5: RuleContext.isDangerousRoot + find.ts deny + 接線所有 ctxOf

**Files:**
- Modify: `src/rules/types.ts`（`RuleContext` 加 `isDangerousRoot`）
- Modify: `src/engine/classify.ts`（ctx 綁定 `isDangerousRoot` + import `dangerousRoot`）
- Modify: `src/rules/commands/find.ts`（starts 的 deny）
- Modify: 10 個 `src/rules/commands/*_test.ts` 的 `ctxOf` helper
- Test: `src/rules/commands/find_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/rules/commands/find_test.ts` 末尾追加：

```ts
Deno.test("find 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find /")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find ~")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find $HOME")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find ${HOME}")).kind, "deny");
});

Deno.test("find 根/家目錄的子路徑 -> 非 deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find ~/.claude")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find .")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find /usr")).kind, "ask");
});

Deno.test("find action flag 優先於根 deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find / -delete")).kind, "ask");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/rules/commands/find_test.ts`
Expected: FAIL（`ctxOf` 的 `RuleContext` 缺 `isDangerousRoot` 編譯錯，或 deny 案例回 ask）

- [ ] **Step 3: 實作**

3a. `src/rules/types.ts` 的 `RuleContext` 介面加入方法（`Word` 已於首行 import）：

```ts
export interface RuleContext {
  name: string;
  argv: Word[];
  redirects: Redirect[];
  assignments: AssignmentPrefix[];
  cwd: CwdState;
  /** 對某參數做範圍檢查（內部已綁定 cwd 與 root）。 */
  resolvePath(arg: Word): PathScope;
  /** 對 flag 的路徑值（字串）做範圍檢查。 */
  resolvePathValue(value: string | null): PathScope;
  /** 此參數是否指向磁碟根 / 家目錄根（用於遞迴指令的 deny 判定）。 */
  isDangerousRoot(arg: Word): boolean;
}
```

3b. `src/engine/classify.ts`：頂部 import 補 `dangerousRoot`：

```ts
import { dangerousRoot, isReadScoped, normalizeAbsolute, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
```

並在 `classifyBuiltin` 回傳 `rule.evaluate({...})` 的 ctx 物件補一行：

```ts
  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
    isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
  });
```

3c. `src/rules/commands/find.ts`：import 補 `deny, recursiveRootDenyReason`：

```ts
import { allow, ask, deny, recursiveRootDenyReason } from "../types.ts";
```

在 `evaluate` 內、action 偵測迴圈**之後**、resolvePath 迴圈**之前**插入根 deny 迴圈：

```ts
    // 偵測寫檔 / 執行 action（既有）
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t !== null && ACTION_FLAGS.has(t)) {
        return ask(`find：${t} 會寫檔或執行外部指令`);
      }
    }
    // 遞迴遍歷磁碟根 / 家目錄根（find 預設遞迴）→ deny
    for (const s of starts) {
      if (ctx.isDangerousRoot(s)) {
        return deny(recursiveRootDenyReason("find", s.value));
      }
    }
    for (const s of starts) {
      if (ctx.resolvePath(s) !== "in-project") {
        return ask(`find：起始路徑超出專案範圍或無法解析（${s.value}）`);
      }
    }
    return allow();
```

> `$HOME`/`${HOME}` 的 `staticValue` 為 null（屬 `DYNAMIC_PART_TYPES`），故 starts 蒐集迴圈的 `t !== null && t.startsWith("-")` 不 break，`$HOME` 被收進 `starts`，供 `isDangerousRoot` 偵測。

3d. 10 個 rule 測試的 `ctxOf` helper：每個檔案 (1) 在 `import { resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";` 補 `dangerousRoot`；(2) 在 `ctxOf` 回傳物件補一行 `isDangerousRoot: (w) => dangerousRoot(w, cwd, null),`。對以下檔案逐一套用（皆有名為 `cwd` 的區域變數，編輯相同）：

- `src/rules/commands/awk_test.ts`
- `src/rules/commands/find_test.ts`
- `src/rules/commands/gh_test.ts`
- `src/rules/commands/grep_test.ts`
- `src/rules/commands/sed_test.ts`
- `src/rules/commands/deno_test.ts`
- `src/rules/commands/git_test.ts`
- `src/rules/commands/positional-output_test.ts`
- `src/rules/commands/coreutils_test.ts`
- `src/rules/commands/simple-flag_test.ts`

每檔 import 改為：

```ts
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
```

每檔 `ctxOf` 回傳物件補：

```ts
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/rules/commands/find_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/rules/types.ts src/engine/classify.ts src/rules/commands/find.ts src/rules/commands/*_test.ts
git commit -m "feat(rules): deny recursive root/home scan in find via isDangerousRoot"
```

---

## Task 6: classify 對 deny 短路（不被 permissions.allow 升級）

**Files:**
- Modify: `src/engine/classify.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/classify_test.ts` 末尾追加（沿用既有 `rulesOf`/`onlyWith` helper）：

```ts
Deno.test("classify: deny 不被 permissions.allow 升級", () => {
  const rules = rulesOf({ allow: ["Bash(find *)"] });
  assertEquals(onlyWith("find /", rules).kind, "deny");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL（無短路時 `find /` 命中 `Bash(find *)` 被升級為 `allow`）

- [ ] **Step 3: 實作**

`src/engine/classify.ts` 的 `classify` 函式，在 `settingsAllows` 升級層**之前**加 deny 短路：

```ts
  const v = classifyBuiltin(inv, scope);
  if (v.kind === "deny") return v; // 硬 deny：不經 settingsAllows 升級層
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "feat(engine): short-circuit deny before permissions.allow upgrade"
```

---

## Task 7: factory recursive 選項 + treeRule

**Files:**
- Modify: `src/rules/factory.ts`
- Modify: `src/rules/commands/simple-flag.ts`
- Test: `src/rules/commands/simple-flag_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/rules/commands/simple-flag_test.ts` 末尾追加：

```ts
Deno.test("tree 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(treeRule.evaluate(ctxOf("tree", "tree /")).kind, "deny");
  assertEquals(treeRule.evaluate(ctxOf("tree", "tree ~")).kind, "deny");
  assertEquals(treeRule.evaluate(ctxOf("tree", "tree $HOME")).kind, "deny");
});

Deno.test("tree 專案內子目錄 -> allow；-o 寫檔 -> ask", () => {
  assertEquals(treeRule.evaluate(ctxOf("tree", "tree ./sub")).kind, "allow");
  assertEquals(treeRule.evaluate(ctxOf("tree", "tree -o out.txt")).kind, "ask");
});
```

> `simple-flag_test.ts` 需 import `treeRule`（若尚未）：`import { treeRule } from "./simple-flag.ts";`（檔內既有其他 rule import，沿用同行或新增）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/rules/commands/simple-flag_test.ts`
Expected: FAIL（`tree /` 回 ask 而非 deny）

- [ ] **Step 3: 實作**

`src/rules/factory.ts`：

1. import 補 `deny, recursiveRootDenyReason`：

```ts
import { allow, ask, deny, recursiveRootDenyReason } from "./types.ts";
```

2. `FlagGatedReaderOptions` 加可選欄位：

```ts
export interface FlagGatedReaderOptions {
  names: string[];
  askFlags?: FlagMatcher[];
  valueFlags?: FlagMatcher[];
  pathValueFlags?: string[];
  askReason?: (name: string) => string;
  /** 回 true 表示此次呼叫會遞迴遍歷；遍歷根命中危險根時 deny。 */
  recursive?: (name: string, argv: Word[]) => boolean;
}
```

> `Word` 型別已於 `factory.ts` 透過 `flags.ts`/`word.ts` 間接使用；若無直接 import，在頂部加 `import type { Word } from "../deps.ts";`。

3. `flagGatedReader` 的 positionals 迴圈改為（迴圈外算一次 `isRecursive`）：

```ts
      const pathFlagVerdict = checkPathValueFlags(ctx, opts.pathValueFlags ?? []);
      if (pathFlagVerdict) return pathFlagVerdict;
      const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;
      for (const arg of positionals(ctx.argv, valueFlags)) {
        if (isRecursive && ctx.isDangerousRoot(arg)) {
          return deny(recursiveRootDenyReason(ctx.name, arg.value));
        }
        const scope = ctx.resolvePath(arg);
        if (scope !== "in-project") {
          return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
        }
      }
      return allow();
```

4. `src/rules/commands/simple-flag.ts` 的 `treeRule` 加 `recursive`：

```ts
export const treeRule: CommandRule = flagGatedReader({
  names: ["tree"],
  askFlags: [exact("-o"), prefix("-o")],
  valueFlags: [exact("-o", "-L", "-P", "-I")],
  askReason: () => "tree：-o 會把輸出寫入檔案",
  recursive: () => true,
});
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/rules/commands/simple-flag_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/simple-flag.ts src/rules/commands/simple-flag_test.ts
git commit -m "feat(rules): add recursive gate to factory and tree deny"
```

---

## Task 8: coreutils fileReaderRule（ls -R 遞迴）

**Files:**
- Modify: `src/rules/commands/coreutils.ts`
- Test: `src/rules/commands/coreutils_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/rules/commands/coreutils_test.ts` 末尾追加：

```ts
Deno.test("ls -R 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R ~")).kind, "deny");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R /")).kind, "deny");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls --recursive $HOME")).kind, "deny");
});

Deno.test("ls 非遞迴碰根 / cat 碰根 -> 非 deny", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -l ~")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("cat /")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("ls -R ./sub")).kind, "allow");
});
```

> `coreutils_test.ts` 的 `ctxOf` 第一參數固定指令名為 argv 對應的 `name`？實際 `ctxOf(src, cwd?)` 內部以 `parse(src)` 取得 `cmd`、並用 `name` 欄位。確認 `coreutils_test.ts` 既有 `ctxOf` 是否以指令字面設定 `name`；若其 `name` 寫死非實際指令，需確保 `ls`/`cat` 透過 `parse(src)` 的第一字設定。沿用該檔既有測試呼叫慣例（既有測試已涵蓋 `cat`/`ls` 等，照same pattern 呼叫）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: FAIL（`ls -R ~` 回 allow 而非 deny）

- [ ] **Step 3: 實作**

`src/rules/commands/coreutils.ts`：

1. import 補（檔頭加一行）：

```ts
import { exact } from "../flags.ts";
import { hasAnyFlag } from "../flags.ts";
```

> 若 `coreutils.ts` 尚未 import `flags.ts`，新增上面兩行（可合併為 `import { exact, hasAnyFlag } from "../flags.ts";`）。

2. `fileReaderRule` 加 `recursive`（只讓 `ls` 且帶 `-R`/`--recursive` 時遞迴；同群組的 cat/head 等永遠非遞迴）：

```ts
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "tail", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // 這些指令無「會寫檔」的 flag（已於 spec 查證）；故 askFlags 留空。
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
});
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/coreutils.ts src/rules/commands/coreutils_test.ts
git commit -m "feat(rules): deny ls -R recursive root/home scan"
```

---

## Task 9: grep grepRule（grep -r / rg 遞迴）

**Files:**
- Modify: `src/rules/commands/grep.ts`
- Test: `src/rules/commands/grep_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/rules/commands/grep_test.ts` 末尾追加（`ctxOf(name, src)` 取兩參數）：

```ts
Deno.test("grep -r / rg 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -r x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -R x ~")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --recursive x $HOME")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rn x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg x ~")).kind, "deny");
});

Deno.test("grep 非遞迴碰根 -> 非 deny", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep / file")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x /")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");
});
```

> `grep / file`：`/` 為 pattern positional、無遞迴旗標 → 非 deny；`/` 落 out-of-project → ask。`grep x /`：無 `-r` → 非遞迴 → `/` out-of-project → ask。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: FAIL（`grep -r x /` 回 ask 而非 deny）

- [ ] **Step 3: 實作**

`src/rules/commands/grep.ts`：

1. import 補 `hasAnyFlag`、`FlagMatcher`（`exact` 已 import）：

```ts
import { exact, hasAnyFlag, type FlagMatcher } from "../flags.ts";
```

2. 在檔案內（`VALUE_FLAGS` 之後）定義短旗標群集偵測，並於 `grepRule` 加 `recursive`：

```ts
// 短旗標群集含 r/R（如 -rn、-Rl）：僅作用於 grep 家族的遞迴偵測；漏判退回 ask（安全）。
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  valueFlags: VALUE_FLAGS,
  pathValueFlags: ["-f", "--file"],
  recursive: (n, a) =>
    n === "rg" ||
    hasAnyFlag(a, [
      exact("-r", "-R", "--recursive", "--dereference-recursive"),
      shortClusterHasR,
    ]),
});
```

> grep 的 `-r` 仍在 `VALUE_FLAGS`（rg `--replace` 吃值用）；遞迴偵測獨立掃 argv，與吃值處理互不影響。

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: PASS
Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（既有案例 `grep -rn TODO src` 仍 allow：`src` 非根）

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/grep.ts src/rules/commands/grep_test.ts
git commit -m "feat(rules): deny grep -r / rg recursive root/home scan"
```

---

## Task 10: e2e（main_test 真實子行程驗證 deny）

**Files:**
- Test: `src/main_test.ts`

- [ ] **Step 1: 新增 e2e 整合測試**

在 `src/main_test.ts` 末尾追加（沿用既有 `runHook` helper；其 `clearEnv: true` 不帶 HOME，但 `find /`、`find $HOME` 的 deny 不依賴 HOME 值）：

```ts
Deno.test("e2e: recursive root scan -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find / -type d -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: lone $HOME recursive scan -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find $HOME -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: subdir of home -> not deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find ~/.claude -name x" }, cwd: "/proj" },
    "/proj",
  );
  const decision = JSON.parse(out).hookSpecificOutput.permissionDecision;
  assertEquals(decision !== "deny", true);
});

Deno.test("e2e: compound allow + recursive-root -> deny (最弱環節)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat README.md && find / -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});
```

> 複合指令 `cat README.md && find / -name x`：經真實 parse→walk→combine，`cat` 葉指令 allow、`find /` 葉指令 deny，`combine` 取 `deny`（驗證 deny 透過整條管線傳播，而非只在 `combine` 單元測試）。

- [ ] **Step 2: 跑 e2e 確認通過（整合驗證，非 red-green）**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: 四個新 e2e 案例 PASS（Task 5–9 完成後管線已支援 deny；本 Task 純整合驗證，故預期一次通過）。若任一 FAIL，回頭檢視對應指令規則。

> 此 Task 為整合驗證，前置 Task 已實作 deny；e2e 主要確認 hook 輸出真的帶 `permissionDecision: "deny"`、exit 0、且 deny 透過複合指令的 combine 傳播。

- [ ] **Step 3: 全套驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 4: Commit**

```bash
git add src/main_test.ts
git commit -m "test(e2e): assert hook returns deny for recursive root/home scan"
```

---

## Task 11: 文件更新 + Operational Verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md 不變量**

在 `CLAUDE.md` 中：

1. 「這是什麼」段落，把「其餘回 `ask`。**永不回 `deny`**。」改為：

```
其餘回 `ask`。**僅對「遞迴遍歷磁碟根/家目錄根的唯讀指令」回 `deny`（硬性、不可由 permissions.allow 解除）；其餘維持 allow / ask，永不主動 `deny`。**
```

2. 「核心不變量」段落，把「**永不 `deny`、永遠 `exit 0`**」那條改為：

```
- **deny 僅限「遞迴遍歷恰好等於磁碟根/家目錄根的唯讀指令」**（find/tree/ls -R/grep -r/rg）；其餘維持「永不 `deny`」。verdict 三態優先序 `deny > ask > allow`。**永遠 `exit 0`**；任何例外都 try/catch 成 ask（fail-safe）。
- deny 為硬性：`classify` 對 builtin `deny` 短路，**不經** `permissions.allow` 升級層（升級層只把 `ask` 變 `allow`，永遠碰不到 `deny`）。deny 漏判（遞迴/根偵測未覆蓋、home env 缺失）只退回 `ask`，絕不誤放行。
```

3. 「架構（評估管線）」的 `combine.ts` 說明，把「任一 ask → 整體 ask」改為「任一 deny → 整體 deny；否則任一 ask → 整體 ask」。

4. 「架構（評估管線）」的 `classify.ts` bullet（描述 `classify(inv, root, rules)` 升級層那句）末尾補：

```
此外，builtin 回 `deny`（遞迴遍歷磁碟根/家目錄根，由 `scope.ts` 的 `dangerousRoot`/`isDangerousRoot` 述詞偵測，接於 find/tree/ls -R/grep -r/rg 的遞迴閘門）時**先於升級層短路返回**，不經 `settingsAllows`，故 `permissions.allow` 無法解除此 deny。
```

5. 「架構（評估管線）」的 `scope.ts` bullet（`resolvePath`/`resolvePathValue` 三態那句）末尾補：

```
另提供 `isDangerousRootAbs`/`dangerousRoot` 危險根偵測（字面 `~`/`~/`、lone `$HOME`/`${HOME}`/`$HOME/`、Windows `$USERPROFILE`、靜態絕對等於磁碟根 `/`、`X:/` 或家目錄），供遞迴指令回 `deny`。
```

6. 「三條中央前置規則」段落：**不新增中央前置規則**（deny 為規則內判定 + `classify` 短路，非中央前置）。在該段標題下補一句明示此設計決策：

```
（註：對「遞迴遍歷磁碟根/家目錄根」的 `deny` 不是中央前置規則，而是各遞迴指令規則內以 `isDangerousRoot` 判定、再由 `classify` 對 `deny` 短路；故不在本三條之列。）
```

7. 「hook 決策 vs settings.json 權限的優先序」段落補一句：

```
此外，本檢查器現會對「遞迴遍歷磁碟根/家目錄根的唯讀指令」主動回 `deny`（硬性、不可由 `permissions.allow` 解除）。此 deny 之 `permissionDecisionReason` 會回饋給 agent，故理由文字會解釋禁止原因與可行替代。
```

- [ ] **Step 2: Build**

Run: `deno task build`
Expected: 產出 `dist/permission-checker`，無錯誤

- [ ] **Step 3: Operational Verification（餵 JSON 給真實 binary）**

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"find / -type d -name x"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker
# 期望：permissionDecision "deny"、exit 0、reason 含「已禁止」與替代建議

echo '{"tool_name":"Bash","tool_input":{"command":"find $HOME -name x"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker
# 期望：deny

echo '{"tool_name":"Bash","tool_input":{"command":"ls -R ~"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker
# 期望：deny

echo '{"tool_name":"Bash","tool_input":{"command":"ls -l ~"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker
# 期望：非 deny（ls -l 非遞迴）

echo '{"tool_name":"Bash","tool_input":{"command":"cat README.md"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker
# 期望：allow（未回歸）
```

逐一確認輸出符合期望（特別是 `ls -l ~` 非 deny、`cat README.md` 仍 allow）。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: deny recursive root/home scan invariant and precedence"
```

---

## Dependency / Execution Order

```
Task 1 (verdict types)
  └─ Task 2 (combine)
  └─ Task 3 (scope dangerousRoot + ScopeConfig.home)
       └─ Task 4 (thread home)
            └─ Task 5 (RuleContext.isDangerousRoot + find deny + ctxOf)
                 └─ Task 6 (classify deny short-circuit)
                 └─ Task 7 (factory recursive + tree)
                      └─ Task 8 (ls -R)
                      └─ Task 9 (grep -r / rg)
                           └─ Task 10 (e2e)
                                └─ Task 11 (docs + operational verification)
```

Task 6/7 在 Task 5 之後可並行；Task 8/9 在 Task 7 之後可並行；其餘為線性依賴。
