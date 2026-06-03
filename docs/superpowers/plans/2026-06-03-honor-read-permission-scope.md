# 沿用 Read/Edit/Write 權限範圍 實現計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓本 hook 沿用 settings.json `permissions.{allow,deny,ask}` 中的 `Read()/Edit()/Write()` 規則，把「純唯讀指令但路徑落在外部已宣告唯讀位置」的判定由 `ask` 放寬為 `allow`，只放寬讀取位置、不放寬任何寫入/執行偵測。

**Architecture:** 新增 `permissions/path_scope.ts` 解析路徑規則為 `ReadScope`（目錄 root + 精確單檔）；重構 `PermissionRules` 為對稱的 `{ bash, readScope }`，載入層只讀檔不合併政策；`scope.ts` 新增 `ScopeConfig` 與 `isReadScoped`（root-first → deny→ask→allow），三態判定在外部允許範圍回 `in-project`；`classify.ts` 由 `rules.readScope` 組裝 `ScopeConfig` 並沿用於 cwd 檢查與規則閉包。

**Tech Stack:** Deno + TypeScript；`deno task check / lint / test / build`。對應設計規格：`docs/superpowers/specs/2026-06-03-honor-read-permission-scope-design.md`。

**任務排序原則：** 簽名／型別結構變更會同時波及多個既有檔案，無法半途 commit 仍維持綠。故把互鎖檔案綁進同一 task：Task 2（`PermissionRules` 結構重構＋全部建構處）、Task 3（`scope.ts` 簽名變更＋全部呼叫處）。每個 task 結束時 `deno task check && deno task lint && deno task test` 全綠。

**Commit 慣例：** ENGLISH + SEMANTIC（對齊既有 git log）。一律以具體檔案路徑 `git add`（**禁止** `git add -A`/`.`）。

---

## 檔案結構

| 檔案 | 角色 | 本計畫動作 |
|---|---|---|
| `src/permissions/path_scope.ts` | 路徑規則解析 → `ReadScope`／`PathScopeEntry`；`parsePathRule` | **新增** |
| `src/permissions/path_scope_test.ts` | `parsePathRule` 單元測試 | **新增** |
| `src/permissions/settings.ts` | `PermissionRules` 結構＋三來源載入；新增 `readScope` 建構 | 修改 |
| `src/permissions/settings_test.ts` | 載入測試 | 修改 |
| `src/permissions/matcher.ts` | `settingsAllows` 改讀 `rules.bash.*` | 修改 |
| `src/permissions/matcher_test.ts` | `rulesOf` helper 改新結構 | 修改 |
| `src/engine/scope.ts` | `toPosix` export、`ScopeConfig`/`hits`/`isReadScoped`/`rootScope`、簽名擴充 | 修改 |
| `src/engine/scope_test.ts` | 呼叫處改 `rootScope`、補放寬/否決/root-first 案例 | 修改 |
| `src/engine/classify.ts` | 組裝 `ScopeConfig`、cwd 檢查與閉包改用 `scope` | 修改 |
| `src/engine/classify_test.ts` | `rulesOf` 改新結構、補外部整合案例 | 修改 |
| `src/engine/evaluate_test.ts` | `rulesOf` helper 改新結構 | 修改 |
| `src/rules/commands/*_test.ts`（10 檔） | `ctxOf` helper 改傳 `rootScope("/proj")` | 修改 |
| `CLAUDE.md` | 補述本機制與 sandbox 限制 | 修改 |
| `src/main.ts`、`src/engine/evaluate.ts`、`combine.ts`、`walk.ts`、`rules/commands/*.ts`、`rules/types.ts` | production 簽名/行為不變 | **不改** |

---

## Task 1: parsePathRule 與 ReadScope（新檔，非破壞性）

**Files:**
- Modify: `src/engine/scope.ts`（`toPosix` 改 `export`）
- Create: `src/permissions/path_scope.ts`
- Test: `src/permissions/path_scope_test.ts`

- [ ] **Step 1: 把 `scope.ts` 的 `toPosix` 改為匯出**

在 `src/engine/scope.ts` 將：

```ts
/** 反斜線轉斜線。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
```

改為：

```ts
/** 反斜線轉斜線。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
```

（此為純新增匯出，不影響既有行為。）

- [ ] **Step 2: 寫 `path_scope_test.ts`（先失敗）**

建立 `src/permissions/path_scope_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { parsePathRule } from "./path_scope.ts";

// 跨平台斷言一律用「多字母頂層段」路徑（如 /srv/...），normalizeAbsolute 在兩平台皆不改寫。
Deno.test("parsePathRule: // absolute /** -> root", () => {
  assertEquals(parsePathRule("Read(//srv/pkg/**)", null), { kind: "root", path: "/srv/pkg" });
});

Deno.test("parsePathRule: ~/ /** -> root with home joined", () => {
  assertEquals(parsePathRule("Read(~/cache/**)", "/srv/home"), { kind: "root", path: "/srv/home/cache" });
});

Deno.test("parsePathRule: ~/ with home=null -> null", () => {
  assertEquals(parsePathRule("Read(~/cache/**)", null), null);
});

Deno.test("parsePathRule: no-glob single file -> file", () => {
  assertEquals(parsePathRule("Read(//srv/pkg/a.txt)", null), { kind: "file", path: "/srv/pkg/a.txt" });
  assertEquals(parsePathRule("Read(~/.zshrc)", "/srv/home"), { kind: "file", path: "/srv/home/.zshrc" });
});

Deno.test("parsePathRule: mid-glob or glob-in-base -> null", () => {
  assertEquals(parsePathRule("Read(//srv/dir/*.json)", null), null);
  assertEquals(parsePathRule("Read(//srv/**/foo)", null), null);
  assertEquals(parsePathRule("Read(//srv/a*b/**)", null), null);
  assertEquals(parsePathRule("Read(//srv/foo]/**)", null), null);
});

Deno.test("parsePathRule: non-target prefix -> null", () => {
  assertEquals(parsePathRule("Read(/src/**)", null), null);
  assertEquals(parsePathRule("Read(src/**)", null), null);
  assertEquals(parsePathRule("Read(./x)", null), null);
  assertEquals(parsePathRule("Read(.env)", null), null);
});

Deno.test("parsePathRule: negation -> null; non-RRW tool -> null", () => {
  assertEquals(parsePathRule("Read(!//srv/x)", null), null);
  assertEquals(parsePathRule("Bash(ls)", null), null);
});

Deno.test("parsePathRule: Edit/Write behave same as Read", () => {
  assertEquals(parsePathRule("Edit(//srv/pkg/**)", null), { kind: "root", path: "/srv/pkg" });
  assertEquals(parsePathRule("Write(//srv/pkg/a.txt)", null), { kind: "file", path: "/srv/pkg/a.txt" });
});

Deno.test({
  name: "parsePathRule: windows // drive -> C:/ form",
  ignore: Deno.build.os !== "windows",
  fn: () => {
    assertEquals(parsePathRule("Read(//c/Users/me/**)", null), { kind: "root", path: "C:/Users/me" });
  },
});

Deno.test({
  name: "parsePathRule: linux /c stays POSIX",
  ignore: Deno.build.os === "windows",
  fn: () => {
    assertEquals(parsePathRule("Read(//c/data/**)", null), { kind: "root", path: "/c/data" });
  },
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/path_scope_test.ts`
Expected: FAIL（`Module not found` / `path_scope.ts` 不存在）

- [ ] **Step 4: 實作 `path_scope.ts`**

建立 `src/permissions/path_scope.ts`：

```ts
import { normalizeAbsolute, toPosix } from "../engine/scope.ts";

/** 由 Read()/Edit()/Write() 規則化約而來的外部唯讀範圍（路徑皆為已正規化的絕對 POSIX 形式）。 */
export interface ReadScope {
  /** 目錄 root（來自結尾 `/**` 的遞迴模式）；以 isWithin 比對「在其下」。 */
  roots: string[];
  /** 精確單一路徑（來自無 glob 的字面模式）；以正規化後字串相等比對。 */
  files: string[];
}

/** 空 ReadScope 常數。 */
export const EMPTY_READ_SCOPE: ReadScope = { roots: [], files: [] };

export type PathScopeEntry =
  | { kind: "root"; path: string } // 目錄 root，已正規化絕對 POSIX
  | { kind: "file"; path: string }; // 精確單檔，已正規化絕對 POSIX

/** glob 字元集合（自有常數，不複用 word.ts 的 GLOB_CHARS；多納入 `]` 只會更保守）。 */
const GLOB_CHARS = /[*?[\]]/;

/**
 * 解析 "Read(...)" / "Edit(...)" / "Write(...)" 規則為外部唯讀 scope entry。
 * 只認 `//`（絕對）與 `~/`（家目錄）前綴；其餘前綴、含 glob 的複雜形式、否定模式 → null（忽略）。
 * home 為 null（無法解析家目錄）時，`~/` 規則一律回 null。
 */
export function parsePathRule(rule: string, home: string | null): PathScopeEntry | null {
  const m = /^(?:Read|Edit|Write)\((.+)\)$/.exec(rule);
  if (m === null) return null;
  const inner = m[1];
  if (inner.startsWith("!")) return null; // 否定模式不支援

  let p: string;
  if (inner.startsWith("//")) {
    p = inner.slice(1); // 去一個前導斜線：//c/foo/** -> /c/foo/**
  } else if (inner.startsWith("~/")) {
    if (home === null) return null;
    p = toPosix(home) + "/" + inner.slice(2);
  } else {
    return null; // /path（專案相對）、path、./path（cwd 相對）皆非目標前綴
  }

  if (p.endsWith("/**")) {
    let base = p.slice(0, -3);
    if (base === "") base = "/"; // //** -> 整個檔案系統
    if (GLOB_CHARS.test(base)) return null; // base 仍含 glob（如 /c/foo*/**）
    return { kind: "root", path: normalizeAbsolute(base) };
  }
  if (!GLOB_CHARS.test(p)) {
    return { kind: "file", path: normalizeAbsolute(p) };
  }
  return null; // 含 glob 但非乾淨結尾 /**
}
```

- [ ] **Step 5: 跑測試確認通過 + check + lint**

Run: `deno test --allow-env src/permissions/path_scope_test.ts`
Expected: PASS（Windows 上含 windows 案例、跳過 linux 案例；反之亦然）

Run: `deno task check && deno task lint`
Expected: 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/engine/scope.ts src/permissions/path_scope.ts src/permissions/path_scope_test.ts
git commit -m "feat(permissions): add parsePathRule for Read/Edit/Write path rules"
```

---

## Task 2: PermissionRules 重構為 bash + readScope，載入層產出 readScope

> 此 task 同時改 production（`settings.ts`、`matcher.ts`）與所有建構 `PermissionRules` 的測試 helper（`settings_test`、`matcher_test`、`classify_test`、`evaluate_test`）。必須一起改，否則 `deno task check`/`test` 失敗。

**Files:**
- Modify: `src/permissions/settings.ts`
- Modify: `src/permissions/matcher.ts:80-86`
- Modify: `src/permissions/settings_test.ts`
- Modify: `src/permissions/matcher_test.ts:109-113`
- Modify: `src/engine/classify_test.ts:1-15`
- Modify: `src/engine/evaluate_test.ts:82-85`

- [ ] **Step 1: 重構 `settings.ts`**

以下列內容取代 `src/permissions/settings.ts` 由 `PermissionRules` 介面起至 `loadPermissionRules` 結束的對應段落（`ReadText`/`defaultReadText`/`resolveHome` 既有實作維持不變，僅 `parseFile` 多收 `home` 參數、新增 `parsePathRuleList`、`emptyRules`/`loadPermissionRules` 改新結構）。

匯入區新增：

```ts
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "./path_scope.ts";
```

型別與常數：

```ts
/** Bash(...) 規則三分類（對齊 settings permissions 結構）。 */
export interface BashRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** Read/Edit/Write 化約的外部唯讀範圍三分類（與 settings 對齊；deny/ask 不在載入層合併）。 */
export interface ReadScopeRules {
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

export interface PermissionRules {
  bash: BashRules; // 原扁平的 { allow, deny, ask } 移入此層
  readScope: ReadScopeRules;
}

export const EMPTY_RULES: PermissionRules = {
  bash: { allow: [], deny: [], ask: [] },
  readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
};
```

`emptyRules()` 改為產出新結構（每次回傳全新可變物件）：

```ts
function emptyRules(): PermissionRules {
  return {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: { roots: [], files: [] },
      deny: { roots: [], files: [] },
      ask: { roots: [], files: [] },
    },
  };
}
```

`parseRuleList`（Bash，既有）維持不變。新增 `parsePathRuleList`：

```ts
function parsePathRuleList(value: unknown, home: string | null): ReadScope {
  const out: ReadScope = { roots: [], files: [] };
  if (!Array.isArray(value)) return out;
  for (const el of value) {
    if (typeof el !== "string") continue;
    let entry: ReturnType<typeof parsePathRule>;
    try {
      entry = parsePathRule(el, home);
    } catch {
      entry = null;
    }
    if (entry === null) continue;
    if (entry.kind === "root") out.roots.push(entry.path);
    else out.files.push(entry.path);
  }
  return out;
}
```

`parseFile` 改為多收 `home`、產出新結構：

```ts
function parseFile(content: string | null, home: string | null): PermissionRules {
  if (content === null) return emptyRules();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return emptyRules();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRules();
  const perms = (parsed as Record<string, unknown>).permissions;
  if (typeof perms !== "object" || perms === null) return emptyRules();
  const p = perms as Record<string, unknown>;
  return {
    bash: {
      allow: parseRuleList(p.allow),
      deny: parseRuleList(p.deny),
      ask: parseRuleList(p.ask),
    },
    readScope: {
      allow: parsePathRuleList(p.allow, home),
      deny: parsePathRuleList(p.deny, home),
      ask: parsePathRuleList(p.ask, home),
    },
  };
}
```

`loadPermissionRules` 改為傳 `home` 並合併兩組三桶：

```ts
export function loadPermissionRules(
  env: EnvReader,
  root: string,
  readText: ReadText = defaultReadText,
): PermissionRules {
  try {
    const paths: string[] = [
      `${root}/.claude/settings.json`,
      `${root}/.claude/settings.local.json`,
    ];
    const home = resolveHome(env);
    if (home !== null) {
      paths.push(normalizeAbsolute(`${home}/.claude/settings.json`));
    }
    const merged = emptyRules();
    for (const path of paths) {
      let rules: PermissionRules;
      try {
        rules = parseFile(readText(path), home);
      } catch {
        rules = emptyRules();
      }
      merged.bash.allow.push(...rules.bash.allow);
      merged.bash.deny.push(...rules.bash.deny);
      merged.bash.ask.push(...rules.bash.ask);
      for (const k of ["allow", "deny", "ask"] as const) {
        merged.readScope[k].roots.push(...rules.readScope[k].roots);
        merged.readScope[k].files.push(...rules.readScope[k].files);
      }
    }
    return merged;
  } catch {
    return emptyRules();
  }
}
```

- [ ] **Step 2: 更新 `matcher.ts` 的 `settingsAllows`**

`src/permissions/matcher.ts` 將：

```ts
  if (matchesAny(cmd, rules.deny)) return false;
  if (matchesAny(cmd, rules.ask)) return false;
  return matchesAny(cmd, rules.allow);
```

改為：

```ts
  if (matchesAny(cmd, rules.bash.deny)) return false;
  if (matchesAny(cmd, rules.bash.ask)) return false;
  return matchesAny(cmd, rules.bash.allow);
```

- [ ] **Step 3: 更新 `matcher_test.ts` 的 `rulesOf` helper（行 109-113）**

將：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}
```

改為（同時於檔頭匯入 `EMPTY_READ_SCOPE`）：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
  };
}
```

於 `matcher_test.ts` 的 settings 匯入加上 `EMPTY_READ_SCOPE`（來自 `./path_scope.ts`）。例如新增一行：

```ts
import { EMPTY_READ_SCOPE } from "./path_scope.ts";
```

- [ ] **Step 4: 更新 `evaluate_test.ts` 的 `rulesOf` helper（行 82-85）**

將：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}
```

改為（並於檔頭新增 `import { EMPTY_READ_SCOPE } from "../permissions/path_scope.ts";`）：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
  };
}
```

- [ ] **Step 5: 更新 `classify_test.ts` 的 `rulesOf` helper（行 12-14）**

將：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}
```

改為（並於檔頭新增 `import { EMPTY_READ_SCOPE } from "../permissions/path_scope.ts";`）：

```ts
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
  };
}
```

- [ ] **Step 6: 更新 `settings_test.ts` 既有斷言為新結構**

於檔頭 import 區新增：

```ts
import { EMPTY_READ_SCOPE } from "./path_scope.ts";
```

於 `noHome` 宣告附近新增共用常數：

```ts
const EMPTY_NESTED = {
  bash: { allow: [], deny: [], ask: [] },
  readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
};
```

逐項修改：

1. 行 19-21 測試改名與斷言：
   ```ts
   Deno.test("EMPTY_RULES is empty bash + empty readScope", () => {
     assertEquals(EMPTY_RULES, EMPTY_NESTED);
   });
   ```
2. 行 36-41 欄位讀取改 `rules.bash.*`：
   ```ts
   assertEquals(rules.bash.allow, [
     { kind: "prefix-boundary", prefix: "npm test" },
     { kind: "exact", text: "git status" },
   ]);
   assertEquals(rules.bash.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
   assertEquals(rules.bash.ask, [{ kind: "prefix-boundary", prefix: "curl" }]);
   ```
3. 四個 fail-safe 整物件斷言（行 46、55、64、73）：把 `assertEquals(rules, { allow: [], deny: [], ask: [] });` 一律改為 `assertEquals(rules, EMPTY_NESTED);`
4. 行 83-84 改 `rules.bash.*`：
   ```ts
   assertEquals(rules.bash.allow, []);
   assertEquals(rules.bash.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
   ```
5. 行 98 改 `rules.bash.allow`：
   ```ts
   assertEquals(rules.bash.allow.map((p) => (p as { prefix: string }).prefix), ["a", "b", "c"]);
   ```

- [ ] **Step 7: 於 `settings_test.ts` 新增 readScope 載入測試**

在檔尾新增：

```ts
Deno.test("extracts Read/Edit/Write into readScope buckets; deny/ask kept separate", () => {
  const content = JSON.stringify({
    permissions: {
      allow: ["Read(//srv/a/**)", "Bash(ls:*)"],
      deny: ["Edit(//srv/b/**)"],
      ask: ["Write(//srv/c/x.txt)"],
    },
  });
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": content }),
  );
  assertEquals(rules.readScope.allow, { roots: ["/srv/a"], files: [] });
  assertEquals(rules.readScope.deny, { roots: ["/srv/b"], files: [] });
  assertEquals(rules.readScope.ask, { roots: [], files: ["/srv/c/x.txt"] });
  // Bash 與 readScope 並存、互不干擾
  assertEquals(rules.bash.allow, [{ kind: "prefix-boundary", prefix: "ls" }]);
});

Deno.test("readScope.allow unions roots across files", () => {
  const env = fakeEnv({ HOME: "/home/u", USERPROFILE: "/home/u" });
  const rules = loadPermissionRules(
    env,
    ROOT,
    fakeReadText({
      "/proj/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Read(//srv/a/**)"] } }),
      "/home/u/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Read(//srv/b/**)"] } }),
    }),
  );
  assertEquals(rules.readScope.allow.roots, ["/srv/a", "/srv/b"]);
});

Deno.test("missing/garbage file -> empty readScope (fail-safe)", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": "not json {{{" }),
  );
  assertEquals(rules.readScope.allow, EMPTY_READ_SCOPE);
  assertEquals(rules.readScope.deny, EMPTY_READ_SCOPE);
  assertEquals(rules.readScope.ask, EMPTY_READ_SCOPE);
});
```

- [ ] **Step 8: 跑 check + lint + 全測試**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（`PermissionRules` 改新結構後，所有建構處與斷言已同步）

- [ ] **Step 9: Commit**

```bash
git add src/permissions/settings.ts src/permissions/matcher.ts src/permissions/settings_test.ts src/permissions/matcher_test.ts src/engine/classify_test.ts src/engine/evaluate_test.ts
git commit -m "refactor(permissions): nest PermissionRules into bash + readScope and load readScope"
```

---

## Task 3: scope.ts 放寬 + classify.ts 整合（簽名變更，連同所有呼叫處）

> `resolvePath`/`resolvePathValue` 簽名由 `root: string` 改為 `scope: ScopeConfig`。所有直接呼叫處（`classify.ts`、`scope_test.ts`、10 個 `commands/*_test.ts` 的 `ctxOf`）必須同 task 改完，否則 `deno task check` 失敗。

**Files:**
- Modify: `src/engine/scope.ts`
- Modify: `src/engine/classify.ts`
- Modify: `src/engine/scope_test.ts`
- Modify: `src/engine/classify_test.ts`
- Modify: `src/rules/commands/{grep,awk,coreutils,deno,find,gh,git,sed,simple-flag,positional-output}_test.ts`

- [ ] **Step 1: 在 `scope.ts` 新增 ScopeConfig / hits / isReadScoped / rootScope**

於 `src/engine/scope.ts` 檔頭新增（type-only 匯入避免 runtime 循環）：

```ts
import type { ReadScope } from "../permissions/path_scope.ts";
```

於 `resolvePathValue` 之前新增：

```ts
/** 範圍設定：專案根 + 外部唯讀範圍三分類（allow/deny/ask，與 settings 對齊）。 */
export interface ScopeConfig {
  root: string;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

/** 由裸 root 字串組成「無外部放寬」的 ScopeConfig；供既有測試與不需外部範圍的呼叫端使用（向後相容）。 */
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
  };
}

/** 單一 ReadScope 是否命中（roots 用 isWithin、files 用精確相等）。 */
function hits(s: ReadScope, absPosix: string): boolean {
  return s.roots.some((r) => isWithin(r, absPosix)) || s.files.some((f) => f === absPosix);
}

/**
 * 已正規化絕對 POSIX 路徑是否落在「允許讀取的位置」（政策合併在此決策層，非載入層）：
 *   專案根內 → true（永遠允許，不受外部 deny/ask 影響，保留「只放寬、不收窄」語義）；
 *   否則（外部）命中 deny → false；命中 ask → false（兩者皆否決放寬，維持 deny>ask>allow）；
 *   否則 命中 allow → true；其餘 → false。
 */
export function isReadScoped(absPosix: string, scope: ScopeConfig): boolean {
  if (isWithin(scope.root, absPosix)) return true; // root-first：專案內永遠允許
  if (hits(scope.deny, absPosix)) return false;
  if (hits(scope.ask, absPosix)) return false;
  if (hits(scope.allow, absPosix)) return true;
  return false;
}
```

- [ ] **Step 2: 更改 `resolvePathValue` / `resolvePath` 簽名為 ScopeConfig**

將既有：

```ts
export function resolvePathValue(value: string | null, cwd: CwdState, root: string): PathScope {
  if (value === null) return "dynamic";
  if (isAbsolute(value)) {
    return isWithin(root, value) ? "in-project" : "out-of-project";
  }
  if (cwd.kind === "unknown") return "dynamic";
  const resolved = resolveAgainst(cwd.path, value);
  return isWithin(root, resolved) ? "in-project" : "out-of-project";
}

export function resolvePath(arg: Word, cwd: CwdState, root: string): PathScope {
  return resolvePathValue(staticValue(arg), cwd, root);
}
```

改為：

```ts
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}

export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  return resolvePathValue(staticValue(arg), cwd, scope);
}
```

> 註：`resolveAgainst` 內部已 `normalizeAbsolute`；絕對值改為先 `normalizeAbsolute(value)` 再丟 `isReadScoped`（後者以 `isWithin`/精確相等比對正規化值）。

- [ ] **Step 3: 整合 `classify.ts`**

將 `src/engine/classify.ts` 的匯入：

```ts
import { isWithin, resolvePath, resolvePathValue } from "./scope.ts";
```

改為（移除未用的 `isWithin`，新增 `isReadScoped`、`normalizeAbsolute`、`ScopeConfig`）：

```ts
import { isReadScoped, normalizeAbsolute, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
```

`classifyBuiltin` 改為收 `scope`、cwd 檢查改用 `isReadScoped`、閉包改傳 `scope`：

```ts
function classifyBuiltin(inv: CommandInvocation, scope: ScopeConfig): RuleVerdict {
  if (inv.name === null) return ask("動態指令名，無法判定");

  const rule = lookupRule(inv.name);
  if (!rule) return ask(`未列入 allowlist 的指令：${inv.name}`);

  // 中央前置規則之一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）
  if (inv.cwd.kind === "known" && !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // 中央前置規則之二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }
  // 中央前置規則之三：環境變數賦值前綴
  if (inv.assignments.length > 0) {
    return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);
  }

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
  });
}
```

`classify` 改為由 `rules.readScope` 組裝 `scope`：

```ts
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
): RuleVerdict {
  const scope: ScopeConfig = {
    root,
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

- [ ] **Step 4: 更新 `scope_test.ts` 的直接呼叫處與 import**

匯入行 4 由：

```ts
import { isWithin, normalizeAbsolute, resolvePath, type PathScope } from "./scope.ts";
```

改為：

```ts
import { isReadScoped, isWithin, normalizeAbsolute, resolvePath, rootScope, type PathScope, type ScopeConfig } from "./scope.ts";
```

把所有直接呼叫 `resolvePath(..., "/proj")` 的第三引數 `"/proj"` 改為 `rootScope("/proj")`：
- 行 68-73 的多行呼叫：第三引數 `"/proj",` → `rootScope("/proj"),`
- 行 79、86、93、100、107：`, "/proj")` → `, rootScope("/proj"))`

- [ ] **Step 5: 於 `scope_test.ts` 新增 isReadScoped 與放寬測試**

於檔尾新增：

```ts
function scopeWith(
  allowRoots: string[] = [],
  denyRoots: string[] = [],
  askRoots: string[] = [],
  allowFiles: string[] = [],
): ScopeConfig {
  return {
    root: "/proj",
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
  };
}

Deno.test("isReadScoped: project root always in (root-first)", () => {
  assertEquals(isReadScoped("/proj/a", rootScope("/proj")), true);
});

Deno.test("isReadScoped: external allow root widens to in-scope", () => {
  assertEquals(isReadScoped("/srv/pkg/x", scopeWith(["/srv/pkg"])), true);
});

Deno.test("isReadScoped: external not covered -> false", () => {
  assertEquals(isReadScoped("/etc/passwd", scopeWith(["/srv/pkg"])), false);
});

Deno.test("isReadScoped: deny vetoes external allow", () => {
  assertEquals(isReadScoped("/srv/pkg/secret", scopeWith(["/srv/pkg"], ["/srv/pkg/secret"])), false);
});

Deno.test("isReadScoped: ask vetoes external allow", () => {
  assertEquals(isReadScoped("/srv/pkg/secret", scopeWith(["/srv/pkg"], [], ["/srv/pkg/secret"])), false);
});

Deno.test("isReadScoped: project path NOT demoted by external deny (root-first)", () => {
  assertEquals(isReadScoped("/proj/a", scopeWith([], ["/proj"])), true);
});

Deno.test("isReadScoped: allow file exact match only (no recurse)", () => {
  const s = scopeWith([], [], [], ["/srv/f.txt"]);
  assertEquals(isReadScoped("/srv/f.txt", s), true);
  assertEquals(isReadScoped("/srv/f.txt/child", s), false);
});
```

- [ ] **Step 6: 更新 10 個 `commands/*_test.ts` 的 `ctxOf` helper**

對下列每一檔，於 `import { resolvePath, resolvePathValue } from "../../engine/scope.ts";` 加上 `rootScope`：

```ts
import { resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
```

並把 `ctxOf` 內：

```ts
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
```

改為：

```ts
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
```

檔案清單（10 檔）：`grep_test.ts`、`awk_test.ts`、`coreutils_test.ts`、`deno_test.ts`、`find_test.ts`、`gh_test.ts`、`git_test.ts`、`sed_test.ts`、`simple-flag_test.ts`、`positional-output_test.ts`。

- [ ] **Step 7: 於 `classify_test.ts` 新增外部整合測試**

於檔頭新增匯入：

```ts
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "../permissions/path_scope.ts";
```

新增 helper（由 `Read()` 規則字串組出含 readScope.allow 的 rules）：

```ts
function rulesWithRead(readAllow: string[]): PermissionRules {
  const allow: ReadScope = { roots: [], files: [] };
  for (const r of readAllow) {
    const e = parsePathRule(r, null);
    if (e?.kind === "root") allow.roots.push(e.path);
    else if (e?.kind === "file") allow.files.push(e.path);
  }
  return {
    bash: { allow: [], deny: [], ask: [] },
    readScope: { allow, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
  };
}
```

新增測試：

```ts
Deno.test("external Read() allow widens read-only command -> allow", () => {
  const r = onlyWith("grep needle /srv/pkg/a.ts", rulesWithRead(["Read(//srv/pkg/**)"]));
  assertEquals(r.kind, "allow");
});

Deno.test("external path not covered by Read() -> ask", () => {
  assertEquals(onlyWith("grep needle /etc/passwd", rulesWithRead(["Read(//srv/pkg/**)"])).kind, "ask");
});

Deno.test("write redirect inside external allow dir still asks", () => {
  assertEquals(onlyWith("grep x /srv/pkg/a > /srv/pkg/out", rulesWithRead(["Read(//srv/pkg/**)"])).kind, "ask");
});

Deno.test("cwd inside external allow dir, read-only command -> allow", () => {
  const invs = walk(parseCommand("cd /srv/pkg && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT, rulesWithRead(["Read(//srv/pkg/**)"])).kind, "allow");
});
```

- [ ] **Step 8: 跑 check + lint + 全測試**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 9: Commit**

```bash
git add src/engine/scope.ts src/engine/classify.ts src/engine/scope_test.ts src/engine/classify_test.ts src/rules/commands/grep_test.ts src/rules/commands/awk_test.ts src/rules/commands/coreutils_test.ts src/rules/commands/deno_test.ts src/rules/commands/find_test.ts src/rules/commands/gh_test.ts src/rules/commands/git_test.ts src/rules/commands/sed_test.ts src/rules/commands/simple-flag_test.ts src/rules/commands/positional-output_test.ts
git commit -m "feat(engine): widen scope to honor readScope allowed-read locations"
```

---

## Task 4: CLAUDE.md 文件 + Operational verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 於 `CLAUDE.md`「hook 決策 vs settings.json 權限的優先序」一節補述本機制**

在該節末尾追加一段（緊接既有「讀取來源：…」項目之後）：

```markdown
此外，本檢查器也沿用 `permissions.{allow,deny,ask}` 中的 `Read()/Edit()/Write()` 規則放寬「讀取位置」：
凡純唯讀指令（allowlist 內）其路徑落在使用者以這些規則 allow 宣告、且未被 deny/ask 否決的外部目錄／
單檔時，視為 in-project 而放行。只認 `//`（絕對）與 `~/`（家目錄）前綴、`/**` 目錄與無 glob 單檔；
其餘形式（中段 glob、裸檔名、專案/ cwd 相對前綴）一律忽略、維持 ask。判定為 root-first：專案內路徑
永遠 in-project，外部路徑才依 deny → ask → allow 決定（deny/ask 皆否決放寬）。**只放寬讀取位置，
不放寬任何寫入型重導向／賦值前綴／非唯讀指令偵測**。

⚠️ sandbox 限制：若啟用 `sandbox.filesystem`，專案外路徑會在 OS 層被擋，與本 hook 的 allow 無關；
此時還需把該目錄加入 sandbox 的 `allowRead` 才能真正讀取。
```

- [ ] **Step 2: Commit 文件**

```bash
git add CLAUDE.md
git commit -m "docs: note Read/Edit/Write scope widening and sandbox limit"
```

- [ ] **Step 3: 建置並做 Operational verification（真實行為，非僅單元測試）**

Run（建置）：`deno task build`
Expected: 產出 `dist/permission-checker.exe`（Windows）

Run（外部路徑被 `Read()` 涵蓋 → 期望 allow）：

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude"
printf '%s\n' '{ "permissions": { "allow": ["Read(//c/extcache/**)"] } }' > "$TMP/.claude/settings.json"
echo '{"tool_name":"Bash","tool_input":{"command":"grep -r needle /c/extcache/pkg"},"cwd":"'"$TMP"'"}' \
  | CLAUDE_PROJECT_DIR="$TMP" ./dist/permission-checker.exe
```

Expected: 輸出 decision 為 **allow**、exit 0。

Run（外部路徑未被任何規則涵蓋 → 期望 ask）：

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"grep -r needle /c/other"},"cwd":"'"$TMP"'"}' \
  | CLAUDE_PROJECT_DIR="$TMP" ./dist/permission-checker.exe
```

Expected: 輸出 decision 為 **ask**、exit 0。

> 若第一例未回 allow：先確認 `$TMP/.claude/settings.json` 內容正確、且測試路徑 `/c/extcache/...`
> 在 `Read(//c/extcache/**)` 化約的 root（Windows 上為 `C:/extcache`）之下；再確認未啟用 sandbox。
> dist/ 已 gitignore，不入版控，無需 commit。

---

## 完成準則

- `deno task check && deno task lint && deno task test` 全綠（每個 task 結束時皆成立）。
- Operational verification 兩例分別回 allow / ask。
- 安全不變量（spec §6）維持：寫入重導向／賦值前綴／非唯讀指令仍 ask；deny/ask 否決放寬；專案內不被外部 deny/ask 降級；fail-safe 永不丟例外、永遠 exit 0。
