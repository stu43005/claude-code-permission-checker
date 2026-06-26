# 執行檔路徑正規化層（union raw+canon）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `permissions.allow` 比對在升級層支援執行檔路徑的詞法正規化（展開 `~`、折疊中段 `//`、移除 `.` 段），使使用者寫的 allow pattern 能命中語義等價但字面不同的真實指令，且以 union（raw + canon）比對保證非回歸、不弱化任何 deny/ask。

**Architecture:** 在 `scope.ts` 新增純詞法函式 `canonicalizeExecPath(token, home)`（含 UNC / `..` / 零段三道 fail-closed）。`matcher.ts` 的 `settingsAllows` 改採 union 比對：指令與 pattern 各保留原始（raw）與正規化（canon）兩種形式，命中 ⟺ `(rawCmd vs rawPat) ∨ (canonCmd vs canonPat)`，三組 deny/ask/allow 對稱套用。`classify.ts` 把 `scope.home` 傳入 `settingsAllows`。

**Tech Stack:** Deno + TypeScript；`deno task check / lint / test / build`；測試用 `@std/assert`。

**Spec:** `docs/superpowers/specs/2026-06-26-settings-exec-path-normalization-design.md`

---

## File Structure

- `src/engine/scope.ts`（**修改**）：新增 export `canonicalizeExecPath(token, home)` 與私有 `lexicalNormalizeRelative`、`hasDotDotSegment`。複用既有 `toPosix` / `isAbsolute` / `normalizeAbsolute`。
- `src/engine/scope_test.ts`（**修改**）：`canonicalizeExecPath` 單元測試。
- `src/permissions/matcher.ts`（**修改**）：`settingsAllows` 加 `home` 參數、改 union；新增私有 `reconstructCanonical` / `canonicalizePattern` / `matchesRuleSet`；`reconstructCommand` 簽名與行為不變。
- `src/permissions/matcher_test.ts`（**修改**）：union / `~` / `//` / fail-closed 案例。
- `src/engine/classify.ts`（**修改**）：第 76 行 `settingsAllows(inv, rules, scope.home)`。
- `src/engine/classify_test.ts`（**修改**）：端到端升級案例。
- `src/main_test.ts`（**修改**）：子行程 e2e。
- `src/testdata/proj-with-settings/.claude/settings.json`（**修改**）：新增兩條 allow 規則供 e2e。
- `CLAUDE.md`（**修改**）：補述升級層執行檔路徑正規化。

---

## Task 1: `canonicalizeExecPath` + helpers（scope.ts）

**Files:**
- Modify: `src/engine/scope.ts`（在 `normalizeAbsolute` 之後、`resolveAgainst` 之前新增）
- Test: `src/engine/scope_test.ts`

- [ ] **Step 1: 在 scope_test.ts import 加入 `canonicalizeExecPath`**

修改 `src/engine/scope_test.ts` 第 4 行的 import，加入 `canonicalizeExecPath`：

```ts
import { canonicalizeExecPath, dangerousRoot, isDangerousRootAbs, isReadScoped, isWithin, normalizeAbsolute, resolvePath, rootScope, type PathScope, type ScopeConfig } from "./scope.ts";
```

- [ ] **Step 2: 寫失敗測試（canonicalizeExecPath 全行為）**

在 `src/engine/scope_test.ts` 末尾新增：

```ts
Deno.test("canonicalizeExecPath: bare command name unchanged", () => {
  assertEquals(canonicalizeExecPath("git", null), "git");
  assertEquals(canonicalizeExecPath("cat", "/home/me"), "cat");
});

Deno.test("canonicalizeExecPath: folds middle // and removes . segment", () => {
  assertEquals(canonicalizeExecPath("/a//b/c", null), "/a/b/c");
  assertEquals(canonicalizeExecPath("/a/./b", null), "/a/b");
});

Deno.test("canonicalizeExecPath: home unavailable still normalizes non-tilde paths", () => {
  assertEquals(canonicalizeExecPath("/a//b", null), "/a/b");
});

Deno.test("canonicalizeExecPath: expands ~ and ~/x when home known", () => {
  assertEquals(canonicalizeExecPath("~", "/home/me"), "/home/me");
  assertEquals(canonicalizeExecPath("~/x/y", "/home/me"), "/home/me/x/y");
  assertEquals(canonicalizeExecPath("~/proj//tool.sh", "/home/me"), "/home/me/proj/tool.sh");
});

Deno.test("canonicalizeExecPath: ~ left literal when home is null", () => {
  assertEquals(canonicalizeExecPath("~/x", null), "~/x");
  assertEquals(canonicalizeExecPath("~", null), "~");
});

Deno.test("canonicalizeExecPath: .. segment left literal (symlink safety)", () => {
  assertEquals(canonicalizeExecPath("/a/../b", null), "/a/../b");
  assertEquals(canonicalizeExecPath("/allowed/link/../tool", null), "/allowed/link/../tool");
});

Deno.test("canonicalizeExecPath: '..' inside a filename is not a .. segment", () => {
  assertEquals(canonicalizeExecPath("/a//foo..bar", null), "/a/foo..bar");
});

Deno.test("canonicalizeExecPath: leading // (UNC) left literal", () => {
  assertEquals(canonicalizeExecPath("//server/share/tool", null), "//server/share/tool");
});

Deno.test("canonicalizeExecPath: zero-segment / bare-root collapse left literal", () => {
  assertEquals(canonicalizeExecPath("./", null), "./");
  assertEquals(canonicalizeExecPath("/.", null), "/.");
});

Deno.test("canonicalizeExecPath: a/. normalizes to a (named segment remains)", () => {
  assertEquals(canonicalizeExecPath("a/.", null), "a");
});

Deno.test("canonicalizeExecPath: relative stays relative, folds //", () => {
  assertEquals(canonicalizeExecPath("scripts//run.sh", null), "scripts/run.sh");
  assertEquals(canonicalizeExecPath("scripts/run.sh", null), "scripts/run.sh");
});

Deno.test("canonicalizeExecPath: preserves trailing slash (directory boundary)", () => {
  assertEquals(canonicalizeExecPath("/a/scripts/", null), "/a/scripts/");
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL（`canonicalizeExecPath` 尚未匯出 → 編譯/解析錯誤）

- [ ] **Step 4: 實作 `canonicalizeExecPath` 與 helpers**

在 `src/engine/scope.ts` 的 `normalizeAbsolute` 函式（第 57 行 `}` 結束）之後、`resolveAgainst`（第 60 行）之前插入：

```ts
/** 路徑是否含獨立 ".." 段（以 "/" 切段比對，排除檔名內的 ".." 如 foo..bar）。 */
function hasDotDotSegment(posix: string): boolean {
  return posix.split("/").some((seg) => seg === "..");
}

/**
 * 相對路徑詞法正規化：折疊 `//`、移除 `.` 段；**不**解析 `..`、**不**加前導 `/`。
 * 呼叫端保證傳入的 posix 不含獨立 `..` 段（已由 canonicalizeExecPath 規則 3 攔截）。
 */
function lexicalNormalizeRelative(posix: string): string {
  const out: string[] = [];
  for (const seg of posix.split("/")) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/**
 * 把單一執行檔 token 做純詞法正規化（不碰檔案系統、不依賴 cwd、idempotent）。
 * 指令側與 pattern 側對稱套用。轉換限定：展開 `~`/`~/`、折疊中段 `//`、移除 `.` 段。
 * 三道 fail-closed：前導 `//`（UNC）、含 `..` 段、塌成空/裸根 → 一律原樣返回 token。
 * 見 spec §4.2。
 */
export function canonicalizeExecPath(token: string, home: string | null): string {
  // 規則 1：裸指令名（無 / 無 \ 且非 ~、~/）→ 原樣
  if (!token.includes("/") && !token.includes("\\") && token !== "~" && !token.startsWith("~/")) {
    return token;
  }
  // 規則 2：前導 //（UNC / 歧義絕對）→ 原樣（fail-closed，不 toPosix、不折疊）
  if (toPosix(token).startsWith("//")) return token;
  // 規則 3：含獨立 .. 段 → 原樣（symlink/junction 安全）
  if (hasDotDotSegment(toPosix(token))) return token;

  // 規則 4：~ / ~/ 展開（home 為 null → 原樣，僅停用 ~ 展開）
  let work = token;
  if (token === "~" || token.startsWith("~/")) {
    if (home === null) return token;
    work = token === "~" ? home : home + token.slice(1); // "~/x" -> home + "/x"
  }

  const posix = toPosix(work);
  // 尾斜線語義（依原 token，非 work）；單一根 "/" 不算
  const hadTrailingSlash = /[/\\]$/.test(token) && toPosix(token) !== "/";

  let normalized: string;
  if (isAbsolute(posix)) {
    // 規則 6：絕對 → normalizeAbsolute（.. 已被規則 3 攔截，故僅折疊 //、移除 .、Windows 磁碟正規化）
    normalized = normalizeAbsolute(posix);
  } else {
    // 規則 5：相對 → 維持相對的詞法正規化
    normalized = lexicalNormalizeRelative(posix);
  }

  // 零段／塌根 fail-closed：結果塌成空、或塌成裸根而原非該裸根 → 原樣 token
  const isBareRoot = normalized === "/" || /^[A-Za-z]:\/$/.test(normalized);
  if (normalized === "" || (isBareRoot && posix !== normalized)) {
    return token;
  }

  // 尾斜線保留（零段 fail-closed 已先返回者不到這裡）
  if (hadTrailingSlash && !normalized.endsWith("/")) normalized += "/";
  return normalized;
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: PASS（全部 canonicalizeExecPath 測試 + 既有 scope 測試綠）

- [ ] **Step 6: 型別與 lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤

- [ ] **Step 7: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts
git commit -m "feat(scope): add canonicalizeExecPath for exec-path lexical normalization"
```

---

## Task 2: `settingsAllows` 改 union 比對（matcher.ts）

**Files:**
- Modify: `src/permissions/matcher.ts`
- Test: `src/permissions/matcher_test.ts`

- [ ] **Step 1: 寫失敗測試（union / ~ / // / fail-closed）**

在 `src/permissions/matcher_test.ts` 末尾新增：

```ts
Deno.test("settingsAllows: ~ pattern + // command upgrades (the motivating case)", () => {
  assertEquals(
    settingsAllows(
      firstInv("/home/me/proj//tool.sh --x"),
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      "/home/me",
    ),
    true,
  );
});

Deno.test("settingsAllows: ~ pattern not expanded when home is null -> no upgrade", () => {
  assertEquals(
    settingsAllows(
      firstInv("/home/me/proj/tool.sh --x"),
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      null,
    ),
    false,
  );
});

Deno.test("settingsAllows: // folding upgrades without ~ (home irrelevant)", () => {
  assertEquals(
    settingsAllows(firstInv("/opt/t//run.sh --x"), rulesOf({ allow: ["Bash(/opt/t/run.sh *)"] })),
    true,
  );
});

Deno.test("settingsAllows: union non-regression - existing literal allow still matches", () => {
  assertEquals(
    settingsAllows(firstInv("npm test --silent"), rulesOf({ allow: ["Bash(npm test:*)"] })),
    true,
  );
});

Deno.test("settingsAllows: spaced exec path deny preserved via raw branch (not bypassed)", () => {
  const rules = rulesOf({
    allow: ["Bash(/o/My App/run.sh *)"],
    deny: ["Bash(/o/My App/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App/run.sh" x'), rules), false);
});

Deno.test("settingsAllows: spaced exec path allow matches via raw branch", () => {
  assertEquals(
    settingsAllows(firstInv('"/o/My App/run.sh" x'), rulesOf({ allow: ["Bash(/o/My App/run.sh *)"] })),
    true,
  );
});

Deno.test("settingsAllows: .. in command stays literal -> folded allow does not match", () => {
  assertEquals(
    settingsAllows(firstInv("/allowed/link/../tool x"), rulesOf({ allow: ["Bash(/allowed/tool *)"] })),
    false,
  );
});

Deno.test("settingsAllows: UNC fail-closed - local allow does not match UNC command", () => {
  assertEquals(
    settingsAllows(firstInv("//server/share/tool x"), rulesOf({ allow: ["Bash(/server/share/tool *)"] })),
    false,
  );
});

Deno.test("settingsAllows: identical UNC literal matches", () => {
  assertEquals(
    settingsAllows(firstInv("//server/share/tool x"), rulesOf({ allow: ["Bash(//server/share/tool *)"] })),
    true,
  );
});

Deno.test("settingsAllows: zero-segment pattern ./ does not match everything", () => {
  assertEquals(settingsAllows(firstInv("rm -rf /"), rulesOf({ allow: ["Bash(./*)"] })), false);
});

Deno.test("settingsAllows: deny equivalent (only differs by //) blocks upgrade", () => {
  const rules = rulesOf({
    allow: ["Bash(/opt/t/run.sh *)"],
    deny: ["Bash(/opt//t/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv("/opt/t/run.sh x"), rules), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: FAIL（`settingsAllows` 尚未接受第三個 `home` 參數 / 尚未 union；`~`、`//`、UNC 案例不符）

- [ ] **Step 3: 實作 union 比對**

修改 `src/permissions/matcher.ts`。先在 import 區（第 1-3 行）加入 `canonicalizeExecPath`：

```ts
import type { CommandInvocation } from "../types.ts";
import { staticValue } from "../engine/word.ts";
import { canonicalizeExecPath } from "../engine/scope.ts";
import type { PermissionRules } from "./settings.ts";
```

把 `reconstructCommand`（第 62-72 行）替換為下列「共用核心 + 兩個薄包裝」，並在檔末替換 `settingsAllows`：

```ts
/** 以 nameOf 轉換執行檔名後還原指令字串；null 條件與原 reconstructCommand 相同。 */
function reconstructWith(inv: CommandInvocation, nameOf: (name: string) => string): string | null {
  if (inv.name === null) return null;
  if (inv.assignments.length > 0) return null;
  const parts: string[] = [nameOf(inv.name)];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    parts.push(v);
  }
  return parts.join(" ");
}

/**
 * 把 invocation 還原成單一可比對指令字串（原始、不正規化）。簽名與行為不變。
 */
export function reconstructCommand(inv: CommandInvocation): string | null {
  return reconstructWith(inv, (name) => name);
}

/** 正規化執行檔名後的指令字串（canonCmd）。argv 不正規化。 */
function reconstructCanonical(inv: CommandInvocation, home: string | null): string | null {
  return reconstructWith(inv, (name) => canonicalizeExecPath(name, home));
}

/** 對 pattern 的第一個空白前 head token 套 canonicalizeExecPath，其餘原樣。 */
function canonicalizeHead(s: string, home: string | null): string {
  const sp = s.indexOf(" ");
  if (sp === -1) return canonicalizeExecPath(s, home);
  return canonicalizeExecPath(s.slice(0, sp), home) + s.slice(sp);
}

/** 產生 pattern 的正規化版本（canonPat），head token 正規化、其餘原樣。 */
function canonicalizePattern(pat: BashPattern, home: string | null): BashPattern {
  switch (pat.kind) {
    case "exact":
      return { kind: "exact", text: canonicalizeHead(pat.text, home) };
    case "prefix-boundary":
      return { kind: "prefix-boundary", prefix: canonicalizeHead(pat.prefix, home) };
    case "prefix-loose":
      return { kind: "prefix-loose", prefix: canonicalizeHead(pat.prefix, home) };
  }
}

/** union 命中：(rawCmd vs rawPat) ∨ (canonCmd vs canonPat)，跨整組 patterns。 */
function matchesRuleSet(
  rawCmd: string,
  canonCmd: string,
  pats: BashPattern[],
  home: string | null,
): boolean {
  return pats.some((p) =>
    matchesPattern(rawCmd, p) || matchesPattern(canonCmd, canonicalizePattern(p, home))
  );
}
```

接著把 `settingsAllows`（檔末第 80-86 行）整段替換為：

```ts
/**
 * 綜合判定：此 invocation 是否應依 settings 升級為 allow。
 * union 比對：指令與 pattern 各保留 raw / canon 兩形式，命中 ⟺ (rawCmd vs rawPat) ∨ (canonCmd vs canonPat)。
 * 三組 deny/ask/allow 對稱套用；raw↔raw 完整重現現行行為，正規化只增不減命中（見 spec §4.5 不變量 1）。
 */
export function settingsAllows(
  inv: CommandInvocation,
  rules: PermissionRules,
  home: string | null = null,
): boolean {
  const rawCmd = reconstructCommand(inv);
  if (rawCmd === null) return false;
  const canonCmd = reconstructCanonical(inv, home);
  if (canonCmd === null) return false; // 與 rawCmd 同步，理論上不會發生
  if (matchesRuleSet(rawCmd, canonCmd, rules.bash.deny, home)) return false;
  if (matchesRuleSet(rawCmd, canonCmd, rules.bash.ask, home)) return false;
  return matchesRuleSet(rawCmd, canonCmd, rules.bash.allow, home);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: PASS（新案例 + 既有 matcher 測試全綠；既有 `settingsAllows(inv, rules)` 兩參數呼叫因 `home` 預設 `null` 仍可編譯且行為不變）

- [ ] **Step 5: 型別與 lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/permissions/matcher.ts src/permissions/matcher_test.ts
git commit -m "feat(matcher): union raw+canon settings matching with exec-path normalization"
```

---

## Task 3: 串接 `scope.home` 至 settingsAllows（classify.ts）

**Files:**
- Modify: `src/engine/classify.ts:76`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 寫失敗測試（端到端升級，含 home 與 // fold）**

在 `src/engine/classify_test.ts` 末尾新增（含一個傳 home 的 helper）：

```ts
function classifyWithHome(src: string, rules: PermissionRules, home: string | null) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules, home);
}

Deno.test("classify: settings ~ allow + // command upgrades to allow", () => {
  assertEquals(
    classifyWithHome(
      "/home/me/proj//tool.sh --x",
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      "/home/me",
    ).kind,
    "allow",
  );
});

Deno.test("classify: settings absolute allow + // command upgrades (home null)", () => {
  assertEquals(
    onlyWith("/opt/t//run.sh --x", rulesOf({ allow: ["Bash(/opt/t/run.sh *)"] })).kind,
    "allow",
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL（`classify` 升級層尚未把 `scope.home` 傳給 `settingsAllows` → `~` 不展開、`//` 不折疊 → 兩案例為 `ask`）

- [ ] **Step 3: 傳入 scope.home**

修改 `src/engine/classify.ts` 第 76 行：

```ts
  if (settingsAllows(inv, rules, scope.home)) return allow();
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS（新案例 + 既有 classify 測試全綠）

- [ ] **Step 5: 全套型別 / lint / 測試**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 6: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "feat(classify): pass home into settingsAllows so ~ and // normalize"
```

---

## Task 4: 子行程 e2e（main_test.ts + fixture）

**Files:**
- Modify: `src/testdata/proj-with-settings/.claude/settings.json`
- Test: `src/main_test.ts`

- [ ] **Step 1: 擴充 fixture settings 的 allow 規則**

把 `src/testdata/proj-with-settings/.claude/settings.json` 改為：

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(/opt/tools/run.sh *)", "Bash(~/tools/run.sh *)"]
  }
}
```

- [ ] **Step 2: 寫失敗測試（e2e // fold；e2e ~ expand + // fold）**

在 `src/main_test.ts` 末尾新增。先加一個可帶額外 env 的 runHook 變體，再加兩個 e2e：

```ts
/** 以子行程執行 main.ts 並附加額外環境變數（例如 HOME），回傳 stdout。 */
async function runHookWithEnv(
  payload: unknown,
  projectDir: string,
  extraEnv: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "src/main.ts"],
    clearEnv: true,
    env: { CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
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

Deno.test("e2e: absolute allow + // in command -> allow (normalization wired)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "/opt/tools//run.sh --x" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: ~ allow + // in command -> allow (HOME expands)", async () => {
  const out = await runHookWithEnv(
    { tool_name: "Bash", tool_input: { command: "/home/e2e/tools//run.sh --x" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
    { HOME: "/home/e2e" },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: ~ allow but HOME unset -> ask (no expansion)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "/home/e2e/tools//run.sh --x" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: 前兩個新 e2e FAIL（正規化尚未生效前會是 ask）。**注意**：本檔為子行程 e2e，必帶完整權限旗標。

> 若本機 `$HOME` 實際存在 `tools/run.sh` 之類干擾，無妨——fixture 用的 `/home/e2e` 與 `/opt/tools` 為純詞法比對對象，binary 不碰檔案系統。

- [ ] **Step 4: 跑測試確認通過（Task 1-3 實作後）**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: PASS（三個新 e2e + 既有 e2e 全綠）

- [ ] **Step 5: Build 後 operational verification（餵真實 JSON 給 binary）**

```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"/opt/tools//run.sh --x"},"cwd":"'"$(pwd)"'/src/testdata/proj-with-settings"}' \
  | CLAUDE_PROJECT_DIR="$(pwd)/src/testdata/proj-with-settings" ./dist/permission-checker
```
Expected: 輸出 JSON 含 `"permissionDecision":"allow"`、exit 0（`//` 折疊命中絕對 allow 規則）。

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"/allowed/link/../tool x"},"cwd":"'"$(pwd)"'/src/testdata/proj-with-settings"}' \
  | CLAUDE_PROJECT_DIR="$(pwd)/src/testdata/proj-with-settings" ./dist/permission-checker
```
Expected: `"permissionDecision":"ask"`（含 `..` 段留字面、不被任何 allow 命中 → 維持 ask，**未誤放**）。

- [ ] **Step 6: Commit**

```bash
git add src/testdata/proj-with-settings/.claude/settings.json src/main_test.ts
git commit -m "test(main): e2e for exec-path // folding and ~ expansion upgrades"
```

---

## Task 5: 文件補述（CLAUDE.md）

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 在 matcher / 優先序段落補述正規化層**

在 `CLAUDE.md` 描述 `permissions/` 的 `matcher.ts` 段落（提到 `reconstructCommand` / `settingsAllows` 之處）補一句，說明升級層的執行檔路徑正規化與 union 比對。建議在「hook 決策 vs settings.json 權限的優先序」一節末尾新增一段：

```markdown
**升級層執行檔路徑正規化（union raw+canon，比官方寬）**：`settingsAllows` 比對前，指令與 pattern 各保留
原始（raw）與正規化（canon）兩種形式，命中 ⟺ `(rawCmd vs rawPat) ∨ (canonCmd vs canonPat)`。正規化由
`scope.ts` 的 `canonicalizeExecPath` 對**執行檔 token**做純詞法處理：展開 `~`/`~/`（home 已知時）、折疊中段
`//`、移除 `.` 段；含 `..` 段、前導 `//`（UNC）、塌成空/裸根者一律留字面（三道 fail-closed，symlink 安全）。
相對路徑不對 cwd 解析。union 保證**只增不減**命中、不弱化任何 deny/ask（含空白路徑回退 raw）。官方 Claude Code
對 Bash 不做此正規化，此為本 hook 刻意的加值層（見 `docs/superpowers/specs/2026-06-26-settings-exec-path-normalization-design.md`）。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): document exec-path normalization upgrade layer"
```

---

## 完成準則（最終驗證）

- [ ] `deno task check && deno task lint && deno task test` 全綠。
- [ ] `deno task build` 成功，operational verification（Task 4 Step 5）兩例符合預期（`//` → allow、`..` → ask）。
- [ ] 既有測試零回歸（union raw↔raw 分支保證）。
