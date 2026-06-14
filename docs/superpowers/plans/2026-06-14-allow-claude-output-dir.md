# 當前 session Claude 輸出目錄唯讀放行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓本 PreToolUse hook 把「當前 session」的 Claude Code 工具輸出目錄（`~/.claude/projects/<E>/<session_id>/` 與 `/tmp/claude-<uid>/<E>/<session_id>/`）視為唯讀延伸範圍，使純唯讀指令讀取其下檔案時回 `allow` 而非 `ask`。

**Architecture:** 在 `ScopeConfig` 新增一個與使用者規則型別分離的 `trusted: string[]` 欄位；`isReadScoped` 在 allow 層比對它。新模組 `src/claude_dir.ts` 由 hook 輸入（`transcript_path`/`session_id`）+ `home` + `Deno.uid()` 推導出「以全域唯一 `session_id` 為鍵」的 trusted 根清單（碰撞免疫、無有損編碼）。`main.ts` 組裝後以獨立參數穿過 `evaluate`/`classify`，`rules` 全程不被 mutate。

**Tech Stack:** Deno + TypeScript；`deno compile` 成單一執行檔；`@std/assert` 測試；unbash 解析（既有）。

**規格來源：** [docs/superpowers/specs/2026-06-14-allow-claude-output-dir-design.md](../specs/2026-06-14-allow-claude-output-dir-design.md)

---

## File Structure

- `src/engine/scope.ts`（改）：`ScopeConfig` 加 `trusted: string[]`；`rootScope` 補 `trusted: []`；`isReadScoped` 加 trusted 比對層。
- `src/claude_dir.ts`（新）：`sessionTrustedReadRoots(...)` 純函式 + 內部 `posixBasename`/`posixDirname` helper。
- `src/claude_dir_test.ts`（新）：上述函式的單元測試。
- `src/engine/classify.ts`（改）：`classify` 新增 `trustedReadRoots: string[] = []` 參數，組進 `ScopeConfig.trusted`。
- `src/engine/evaluate.ts`（改）：`evaluate` 新增 `trustedReadRoots: string[] = []` 參數並轉傳。
- `src/hook/types.ts`（改）：`HookInput` 加 `transcript_path?: string`。
- `src/main.ts`（改）：取 `Deno.uid()`（try/catch）、呼叫 `sessionTrustedReadRoots`、傳入 `evaluate`。
- `deno.json`（改）：`build` 與 `test` task 加 `--allow-sys=uid`。
- `src/engine/scope_test.ts`、`src/engine/classify_test.ts`、`src/main_test.ts`（改）：增補測試。

每個 Task 結束時 `deno task check && deno task lint && deno task test` 全綠才算完成。

---

## Task 1: `ScopeConfig.trusted` 欄位與 `isReadScoped` trusted 層

**Files:**
- Modify: `src/engine/scope.ts`
- Modify: `src/engine/classify.ts`（暫補 `trusted: []`，Task 3 改為用參數）
- Test: `src/engine/scope_test.ts`（含更新 `scopeWith` helper）

- [ ] **Step 1: 寫失敗測試（trusted 層 + rootScope 預設）**

在 `src/engine/scope_test.ts` 末尾新增：

```ts
Deno.test("rootScope sets empty trusted", () => {
  assertEquals(rootScope("/proj").trusted, []);
});

Deno.test("isReadScoped: trusted root grants read; root-first and deny/ask override", () => {
  const SID = "/home/me/.claude/projects/-proj/115826ef-e830-461f-8101-edac56694d2b";
  const scope: ScopeConfig = { ...rootScope("/proj"), trusted: [SID] };
  // trusted 子路徑可讀
  assertEquals(isReadScoped(SID + "/tool-results/x.txt", scope), true);
  assertEquals(isReadScoped(SID, scope), true);
  // 專案內仍 root-first
  assertEquals(isReadScoped("/proj/src/a.ts", scope), true);
  // trusted 外（同專案 memory）仍 false
  assertEquals(isReadScoped("/home/me/.claude/projects/-proj/memory/x", scope), false);
  // deny 覆蓋 trusted（deny > allow=trusted）
  const denied: ScopeConfig = { ...scope, deny: { roots: [SID], files: [] } };
  assertEquals(isReadScoped(SID + "/x", denied), false);
  // ask 覆蓋 trusted
  const asked: ScopeConfig = { ...scope, ask: { roots: [SID], files: [] } };
  assertEquals(isReadScoped(SID + "/x", asked), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL（`trusted` 不存在於 `ScopeConfig` / `rootScope` 回傳值，型別或斷言錯誤）

- [ ] **Step 3: 在 `ScopeConfig` 介面新增 `trusted` 欄位**

於 `src/engine/scope.ts` 找到 `ScopeConfig` 介面：

```ts
export interface ScopeConfig {
  root: string;
  home: string | null;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}
```

改為（在 `ask` 後加一行）：

```ts
export interface ScopeConfig {
  root: string;
  home: string | null;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
  /** hook 自身推導的「當前 session」可信唯讀目錄根（與使用者規則分離；allow 同級）。 */
  trusted: string[];
}
```

- [ ] **Step 4: `rootScope` 補 `trusted: []`**

於 `src/engine/scope.ts` 找到 `rootScope`：

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

在 `ask` 那行後加 `trusted: [],`：

```ts
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    home: null,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
    trusted: [],
  };
}
```

- [ ] **Step 5: `isReadScoped` 加 trusted 比對層**

於 `src/engine/scope.ts` 找到 `isReadScoped`：

```ts
export function isReadScoped(absPosix: string, scope: ScopeConfig): boolean {
  if (isWithin(scope.root, absPosix)) return true; // root-first：專案內永遠允許
  if (hits(scope.deny, absPosix)) return false;
  if (hits(scope.ask, absPosix)) return false;
  if (hits(scope.allow, absPosix)) return true;
  return false;
}
```

在 `hits(scope.allow ...)` 之後、`return false` 之前插入 trusted 層：

```ts
export function isReadScoped(absPosix: string, scope: ScopeConfig): boolean {
  if (isWithin(scope.root, absPosix)) return true; // root-first：專案內永遠允許
  if (hits(scope.deny, absPosix)) return false;
  if (hits(scope.ask, absPosix)) return false;
  if (hits(scope.allow, absPosix)) return true;
  if (scope.trusted.some((r) => isWithin(r, absPosix))) return true; // trusted（allow 同級，deny/ask 已先否決）
  return false;
}
```

- [ ] **Step 6: 更新 `scopeWith` 測試 helper 補 `trusted: []`**

`ScopeConfig.trusted` 成為必填後，`src/engine/scope_test.ts` 既有的 `scopeWith` helper 須補欄位。找到：

```ts
  return {
    root: "/proj",
    home: null,
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
  };
```

在 `ask` 那行後加 `trusted: [],`：

```ts
  return {
    root: "/proj",
    home: null,
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
    trusted: [],
  };
```

- [ ] **Step 7: 更新 `classify.ts` 的 `ScopeConfig` 字面值補 `trusted: []`（暫時；Task 3 改為用參數）**

於 `src/engine/classify.ts` 找到 `classify` 內的 scope 建構：

```ts
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
  };
```

在 `ask` 那行後加 `trusted: [],`：

```ts
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: [],
  };
```

- [ ] **Step 8: 跑測試確認通過 + 全套驗證**

Run: `deno task test`
Expected: 全綠（既有測試不回歸 + 新增 trusted 測試通過）

Run: `deno task check && deno task lint`
Expected: 無錯誤

- [ ] **Step 9: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts src/engine/classify.ts
git commit -m "feat(scope): add trusted read-root tier to ScopeConfig and isReadScoped"
```

---

## Task 2: `src/claude_dir.ts` — `sessionTrustedReadRoots`

**Files:**
- Create: `src/claude_dir.ts`
- Test: `src/claude_dir_test.ts`

- [ ] **Step 1: 寫失敗測試**

建立 `src/claude_dir_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { sessionTrustedReadRoots } from "./claude_dir.ts";

const HOME = "/home/me";
const SID = "115826ef-e830-461f-8101-edac56694d2b";
const E = "-home-me-Sources-proj";
const TRANSCRIPT = `${HOME}/.claude/projects/${E}/${SID}.jsonl`;
const CLAUDE_ROOT = `${HOME}/.claude/projects/${E}/${SID}`;

Deno.test("合法：uid + privateTmp → 三根（~/.claude + /tmp + /private/tmp），皆以 sid 結尾", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, 501, true);
  assertEquals(roots, [
    CLAUDE_ROOT,
    `/tmp/claude-501/${E}/${SID}`,
    `/private/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("uid 給定、privateTmp=false → 不含 /private/tmp", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, 501, false);
  assertEquals(roots, [CLAUDE_ROOT, `/tmp/claude-501/${E}/${SID}`]);
});

Deno.test("uid=null → 僅 ~/.claude 一根", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, null, true), [CLAUDE_ROOT]);
});

Deno.test("前後空白：transcript 與 sessionId 皆 trim", () => {
  const roots = sessionTrustedReadRoots(`  ${TRANSCRIPT}  `, `  ${SID}  `, HOME, null, true);
  assertEquals(roots, [CLAUDE_ROOT]);
});

Deno.test("大小寫敏感：.JSONL 結尾 → []", () => {
  const up = `${HOME}/.claude/projects/${E}/${SID}.JSONL`;
  assertEquals(sessionTrustedReadRoots(up, SID, HOME, null, true), []);
});

Deno.test("transcript basename 與 session_id 不符 → []", () => {
  const other = `${HOME}/.claude/projects/${E}/deadbeef.jsonl`;
  assertEquals(sessionTrustedReadRoots(other, SID, HOME, null, true), []);
});

Deno.test("session_id 缺失/空白 → []", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, undefined, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "   ", HOME, null, true), []);
});

Deno.test("session_id 非安全路徑段（. / .. / 斜線 / 反斜線 / 點 / 空白）一律回 []", () => {
  // sid="." 即使 transcript basename 湊成 ".jsonl"，安全段檢查先擋（不得收斂回 <E>）
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/.jsonl`, ".", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/...jsonl`, "..", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a/b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a\\b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a.b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a b", HOME, null, true), []);
});

Deno.test("transcript 不在 ~/.claude/projects 下 → []", () => {
  const ssh = `${HOME}/.ssh/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(ssh, SID, HOME, 501, true), []);
});

Deno.test("transcript dir 等於 projects 根（少一段）→ []", () => {
  const atRoot = `${HOME}/.claude/projects/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(atRoot, SID, HOME, 501, true), []);
});

Deno.test("非絕對 / 非 .jsonl / 空 / undefined transcript → []；home=null → []", () => {
  assertEquals(sessionTrustedReadRoots(`projects/${E}/${SID}.jsonl`, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/${SID}.txt`, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots("", SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(undefined, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, null, 501, true), []);
});

Deno.test("碰撞免疫：/a/b 與 /a-b 共用 <E>=-a-b，但各 session 子樹以各自 sid 區隔", () => {
  const E2 = "-a-b";
  const sidA = "aaaaaaaa-0000-0000-0000-000000000000";
  const sidB = "bbbbbbbb-0000-0000-0000-000000000000";
  const a = sessionTrustedReadRoots(`${HOME}/.claude/projects/${E2}/${sidA}.jsonl`, sidA, HOME, null, false);
  const b = sessionTrustedReadRoots(`${HOME}/.claude/projects/${E2}/${sidB}.jsonl`, sidB, HOME, null, false);
  assertEquals(a, [`${HOME}/.claude/projects/${E2}/${sidA}`]);
  assertEquals(b, [`${HOME}/.claude/projects/${E2}/${sidB}`]);
  // 兩者互不涵蓋（不同 sid 子樹）：不相等，且任一不在另一之下
  assertEquals(a[0] === b[0], false);
  assertEquals(a[0].startsWith(b[0] + "/") || b[0].startsWith(a[0] + "/"), false);
});

Deno.test({
  name: "Windows：drive 路徑正規化後仍正確綁定（Windows 上 Deno.uid()→null，僅 ~/.claude 根）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const wHome = "C:/Users/me";
    const wE = "-c-Users-me-proj"; // 示意：實際編碼由 Claude 決定；此處只驗正規化/綁定一致性
    const wTranscript = `${wHome}/.claude/projects/${wE}/${SID}.jsonl`;
    // Windows 上 main.ts 取不到 uid（Deno.uid() 回 null），故只應產生 ~/.claude 根
    const roots = sessionTrustedReadRoots(wTranscript, SID, wHome, null, false);
    assertEquals(roots, [`C:/Users/me/.claude/projects/${wE}/${SID}`]);
  },
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/claude_dir_test.ts`
Expected: FAIL（`./claude_dir.ts` 不存在 / `sessionTrustedReadRoots` 未定義）

- [ ] **Step 3: 實作 `src/claude_dir.ts`**

建立 `src/claude_dir.ts`：

```ts
import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";

/** 已正規化絕對 POSIX 路徑的最後一段（"/" → ""）。 */
function posixBasename(absPosix: string): string {
  const idx = absPosix.lastIndexOf("/");
  return idx < 0 ? absPosix : absPosix.slice(idx + 1);
}

/** 已正規化絕對 POSIX 路徑的 dirname；頂層 "/x" → "/"；無分隔符 → null。 */
function posixDirname(absPosix: string): string | null {
  const idx = absPosix.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return absPosix.slice(0, idx);
}

/** session_id 安全單一路徑段：僅 alnum / '_' / '-'（UUID 形即符合）；拒 . / .. / 分隔符 / 點 / 空。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 推導「當前 session 的 Claude Code 工具/任務輸出子目錄」清單（trusted read roots）。
 * 全部以 .../<session_id>/ 結尾（以全域唯一 session_id 為鍵 → 碰撞免疫）。
 * 任一安全閘不過或前置缺失 → []（fail-safe）。純詞法、不碰 FS、不丟例外。
 *
 * @param uid Deno.uid() 結果（由呼叫端 try/catch 取得；null 時不產生 /tmp 根）
 * @param includePrivateTmp main.ts 傳 Deno.build.os === "darwin"（macOS /tmp 為 /private/tmp 的 symlink）
 */
export function sessionTrustedReadRoots(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  home: string | null,
  uid: number | null,
  includePrivateTmp: boolean,
): string[] {
  if (home === null) return [];
  if (!sessionId || sessionId.trim() === "") return [];
  if (!transcriptPath || transcriptPath.trim() === "") return [];

  const sid = sessionId.trim();
  if (!SAFE_SESSION_ID.test(sid)) return []; // 先於任何把 sid 串入路徑的動作（封 . / .. / 逃逸）

  const t = transcriptPath.trim();
  if (!isAbsolute(t)) return [];
  if (!toPosix(t).endsWith(".jsonl")) return []; // 大小寫敏感

  const abs = normalizeAbsolute(t);
  if (posixBasename(abs) !== sid + ".jsonl") return []; // transcript 檔名須等於 <session_id>.jsonl（綁定當前 session）

  const dir = posixDirname(abs);
  if (dir === null) return [];

  const projectsRoot = normalizeAbsolute(home + "/.claude/projects");
  if (!isWithin(projectsRoot, dir) || dir === projectsRoot) return []; // dir 須嚴格在 <home>/.claude/projects/ 之下且至少一段

  const e = posixBasename(dir); // 權威編碼段（非重算）
  const roots: string[] = [normalizeAbsolute(dir + "/" + sid)]; // ~/.claude session 子目錄
  if (uid !== null) {
    const bases = includePrivateTmp ? ["/tmp", "/private/tmp"] : ["/tmp"];
    for (const b of bases) {
      roots.push(normalizeAbsolute(b + "/claude-" + uid + "/" + e + "/" + sid));
    }
  }

  // Post-construction 不變量（defense-in-depth）：~/.claude 根（roots[0]）的 dirname 必為已驗證的 dir，
  // 且每個 root 的 basename 必為 sid。SAFE_SESSION_ID 安全段檢查已保證此恆成立，此處僅防未來建構邏輯回歸。
  if (posixDirname(roots[0]) !== dir) return [];
  for (const r of roots) {
    if (posixBasename(r) !== sid) return [];
  }
  return roots;
}
```

- [ ] **Step 4: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/claude_dir_test.ts`
Expected: PASS（全部案例）

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（型別/lint 無錯誤；既有測試不回歸 + 新增 claude_dir 測試通過）

- [ ] **Step 5: Commit**

```bash
git add src/claude_dir.ts src/claude_dir_test.ts
git commit -m "feat(claude-dir): derive session-keyed trusted read roots from hook input"
```

---

## Task 3: 把 `trustedReadRoots` 參數穿過 `classify` 與 `evaluate`

**Files:**
- Modify: `src/engine/classify.ts`
- Modify: `src/engine/evaluate.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/classify_test.ts` 末尾新增（沿用檔頭既有的 `parseCommand`/`walk`/`classify`/`parseBashRule`/`parsePathRule`/`EMPTY_READ_SCOPE` 匯入與 `ROOT`/`START`/`rulesOf`），並在檔頭 import 區新增 `import { evaluate } from "./evaluate.ts";`：

```ts
const CLAUDE_TRUSTED = "/home/me/.claude/projects/-proj/115826ef-e830-461f-8101-edac56694d2b";
const TMP_TRUSTED = "/tmp/claude-501/-proj/115826ef-e830-461f-8101-edac56694d2b";

function withTrusted(src: string, trusted: string[], rules?: PermissionRules) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules ?? rulesOf({}), "/home/me", trusted);
}

Deno.test("trusted ~/.claude 子路徑唯讀指令 → allow", () => {
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`, [CLAUDE_TRUSTED]).kind, "allow");
});

Deno.test("trusted /tmp 子路徑唯讀指令 → allow", () => {
  assertEquals(withTrusted(`cat ${TMP_TRUSTED}/tasks/x.output`, [CLAUDE_TRUSTED, TMP_TRUSTED]).kind, "allow");
});

Deno.test("同專案 memory、他 session、本 session transcript 檔皆不在 trusted → ask", () => {
  assertEquals(withTrusted("cat /home/me/.claude/projects/-proj/memory/x.md", [CLAUDE_TRUSTED]).kind, "ask");
  assertEquals(withTrusted("cat /home/me/.claude/projects/-proj/other-sid/tool-results/x", [CLAUDE_TRUSTED]).kind, "ask");
  // transcript .jsonl 位於 session 子目錄的兄弟位置，不在 trusted 根之下
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}.jsonl`, [CLAUDE_TRUSTED]).kind, "ask");
});

Deno.test("trusted 下但命中 user Read() deny、且無 Bash allow → ask", () => {
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: EMPTY_READ_SCOPE,
      deny: { roots: [CLAUDE_TRUSTED], files: [] },
      ask: EMPTY_READ_SCOPE,
    },
  };
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`, [CLAUDE_TRUSTED], rules).kind, "ask");
});

Deno.test("未傳 trustedReadRoots（預設 []）→ 同外部路徑 ask", () => {
  const invs = walk(parseCommand(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`).script, START, ROOT);
  assertEquals(classify(invs[0], ROOT).kind, "ask");
});

Deno.test("evaluate 把 trustedReadRoots 轉傳給 classify → allow", () => {
  const out = evaluate(
    `cat ${CLAUDE_TRUSTED}/tool-results/x.txt`,
    ROOT,
    START,
    rulesOf({}),
    "/home/me",
    [CLAUDE_TRUSTED],
  );
  assertEquals(out.verdict, "allow");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL（`classify` 尚無第 5 個參數 → trusted 永遠空 → 前述 allow 案例變 ask）

- [ ] **Step 3: `classify` 新增 `trustedReadRoots` 參數**

於 `src/engine/classify.ts` 找到 `classify`（Task 1 已讓 scope 含 `trusted: []`）：

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
    trusted: [],
  };
```

改為（新增第 5 參數，並把 `trusted: []` 改為使用該參數）：

```ts
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
```

（此函式其餘部分不變。）

- [ ] **Step 4: `evaluate` 新增 `trustedReadRoots` 參數並轉傳**

於 `src/engine/evaluate.ts` 找到 `evaluate`：

```ts
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
): Decision {
```

改為：

```ts
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
): Decision {
```

並把同檔內的：

```ts
    return combine(invocations.map((inv) => classify(inv, root, rules, home)));
```

改為：

```ts
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
```

- [ ] **Step 5: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS

Run: `deno task check && deno task lint`
Expected: 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/engine/classify.ts src/engine/evaluate.ts src/engine/classify_test.ts
git commit -m "feat(engine): thread trustedReadRoots through evaluate and classify"
```

---

## Task 4: 串接 `main.ts`、`HookInput.transcript_path` 與 build 權限

**Files:**
- Modify: `src/hook/types.ts`
- Modify: `src/main.ts`
- Modify: `deno.json`
- Test: `src/main_test.ts`

- [ ] **Step 1: `deno.json` 的 build/test task 加 `--allow-sys=uid`**

於 `deno.json` 的 `tasks`：

```json
    "test": "deno test --allow-run --allow-env --allow-read",
```

改為：

```json
    "test": "deno test --allow-run --allow-env --allow-read --allow-sys=uid",
```

並把：

```json
    "build": "deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE --output dist/permission-checker src/main.ts"
```

改為：

```json
    "build": "deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE --allow-sys=uid --output dist/permission-checker src/main.ts"
```

- [ ] **Step 2: `HookInput` 加 `transcript_path?`**

於 `src/hook/types.ts` 找到：

```ts
export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
  session_id?: string;
}
```

改為：

```ts
export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
}
```

- [ ] **Step 3: 寫失敗 e2e 測試**

在 `src/main_test.ts` 末尾新增（沿用檔頭既有 `assertEquals` 匯入）。先加一個帶 `HOME` 的子行程 helper，再加測試：

```ts
/** 以子行程執行 main.ts，可額外指定環境變數（如 HOME），並帶 --allow-sys=uid。 */
async function runHookWithEnv(
  payload: unknown,
  env: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "--allow-sys=uid", "src/main.ts"],
    clearEnv: true,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout } = await child.output();
  return new TextDecoder().decode(stdout).trim();
}

const E2E_HOME = "/tmp/cc-pc-e2e-home";
const E2E_PROJ = "/tmp/cc-pc-e2e-home/Sources/proj";
const E2E_E = "-tmp-cc-pc-e2e-home-Sources-proj";
const E2E_SID = "115826ef-e830-461f-8101-edac56694d2b";
const E2E_TRANSCRIPT = `${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}.jsonl`;

function e2ePayload(command: string, extra: Record<string, unknown> = {}) {
  return {
    tool_name: "Bash",
    tool_input: { command },
    cwd: E2E_PROJ,
    session_id: E2E_SID,
    transcript_path: E2E_TRANSCRIPT,
    ...extra,
  };
}

Deno.test("e2e: 讀當前 session 的 ~/.claude tool-results -> allow", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: 不帶 transcript_path -> ask", async () => {
  const out = await runHookWithEnv(
    { tool_name: "Bash", tool_input: { command: `cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt` }, cwd: E2E_PROJ, session_id: E2E_SID },
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: transcript basename 與 session_id 不符 -> ask", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt`, {
      transcript_path: `${E2E_HOME}/.claude/projects/${E2E_E}/deadbeef.jsonl`,
    }),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: transcript_path 在 ~/.claude/projects 外 -> ask", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.ssh/${E2E_SID}/secret`, {
      transcript_path: `${E2E_HOME}/.ssh/${E2E_SID}.jsonl`,
    }),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: 同專案 memory -> ask（不自動放行）", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/memory/note.md`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test({
  name: "e2e: 讀當前 session 的 /tmp 任務輸出 -> allow（macOS）",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const uid = Deno.uid();
    const out = await runHookWithEnv(
      e2ePayload(`cat /private/tmp/claude-${uid}/${E2E_E}/${E2E_SID}/tasks/x.output`),
      { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
    );
    assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
  },
});
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `deno test --allow-run --allow-env --allow-read --allow-sys=uid src/main_test.ts`
Expected: FAIL（`main.ts` 尚未組裝 trusted → 新增的 allow 案例變 ask）

- [ ] **Step 5: `main.ts` 串接**

於 `src/main.ts` 頂部匯入區（在 `import { evaluate } ...` 後）新增：

```ts
import { sessionTrustedReadRoots } from "./claude_dir.ts";
```

找到 `main()` 內的 else 區塊：

```ts
  } else {
    const command = input.tool_input?.command ?? "";
    const rules = loadPermissionRules(Deno.env, root);
    const home = homeDir(Deno.env);
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home);
  }
```

改為：

```ts
  } else {
    const command = input.tool_input?.command ?? "";
    const rules = loadPermissionRules(Deno.env, root);
    const home = homeDir(Deno.env);
    let uid: number | null = null;
    try {
      uid = Deno.uid();
    } catch {
      uid = null; // 權限（--allow-sys=uid）/平台不支援 → 不產生 /tmp 根（fail-safe）
    }
    const trusted = sessionTrustedReadRoots(
      input.transcript_path,
      input.session_id,
      home,
      uid,
      Deno.build.os === "darwin",
    );
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);
  }
```

- [ ] **Step 6: 跑測試確認通過 + 全套驗證**

Run: `deno test --allow-run --allow-env --allow-read --allow-sys=uid src/main_test.ts`
Expected: PASS

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（既有測試不回歸；新增測試通過）

- [ ] **Step 7: Operational verification（build 後餵真實 JSON）**

```bash
deno task build
USER_ID=$(id -u)
H="/tmp/cc-pc-e2e-home"; PJ="$H/Sources/proj"; E="-tmp-cc-pc-e2e-home-Sources-proj"; SID="115826ef-e830-461f-8101-edac56694d2b"
T="$H/.claude/projects/$E/$SID.jsonl"
# 1) 當前 session ~/.claude tool-results -> allow
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.claude/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 2a) /private/tmp 任務輸出（macOS symlink 形式）-> allow
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat /private/tmp/claude-$USER_ID/$E/$SID/tasks/x.output\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 2b) /tmp 任務輸出（另一形式）-> allow
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat /tmp/claude-$USER_ID/$E/$SID/tasks/x.output\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 3) 同專案 memory（不在當前 session 子樹）-> ask
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.claude/projects/$E/memory/n.md\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 4) transcript basename 與 session_id 不符 -> ask
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.claude/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$H/.claude/projects/$E/deadbeef.jsonl\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 5) transcript_path 在 ~/.claude/projects 外 -> ask
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.ssh/$SID/secret\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\",\"transcript_path\":\"$H/.ssh/$SID.jsonl\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
# 6) 缺 transcript_path -> ask
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.claude/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"$PJ\",\"session_id\":\"$SID\"}" \
  | HOME="$H" CLAUDE_PROJECT_DIR="$PJ" ./dist/permission-checker
```

Expected：(1) allow、(2a) allow、(2b) allow、(3) ask、(4) ask、(5) ask、(6) ask；全部 `exit 0`。

- [ ] **Step 8: Commit**

```bash
git add src/hook/types.ts src/main.ts deno.json src/main_test.ts
git commit -m "feat(main): allow current-session Claude output dirs as read-only trusted roots"
```

---

## 收尾

- [ ] **最終全套驗證**：`deno task check && deno task lint && deno task test` 全綠。
- [ ] **更新 `CLAUDE.md`**：在「hook 決策 vs settings.json 權限的優先序」一節後，補一段說明本功能（放行來源、以 `session_id` 為鍵的安全閘、刻意不含 memory/歷史 session、`--allow-sys=uid`、與使用者規則型別分離），並 commit（`docs: ...`）。
