# 唯讀指令 allowlist 擴充 + command substitution 靜態求值 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `base64` / `test` / `npm`（唯讀子指令）/ `cygpath` 的安全形式自動放行，讓 `cd "$(cygpath -u '…')"` 能推導出具體 cwd，並修掉「未加引號的 `~/…` 被當成專案內相對路徑」這個既有放行漏洞。

**Architecture:** 本專案是 Claude Code 的 `PreToolUse`（matcher: `Bash`）hook，用 Deno 寫、`deno compile` 成單一執行檔。評估管線為 `parse → walk → 四閘 → classify → combine`，全程**純詞法、不碰檔案系統**，未明確判定安全者一律 `ask`（default-deny）。本次新增一個 command substitution 靜態求值框架（`src/engine/subst_eval.ts`）供 `cwd.ts` 推導 cd 目標，新增四條指令規則，並在 `scope.ts` 的路徑解析層加入 tilde 展開語義。

**Tech Stack:** Deno / TypeScript、`unbash@4.0.1`（bash AST 解析，型別一律自 `src/deps.ts` 匯入）、`@std/assert`（測試）。

**Spec:** `docs/superpowers/specs/2026-09-22-readonly-cmds-and-subst-eval-design.md`

**專案規範（每個 Task 都適用）：**

- 驗證三件套：`deno task check && deno task lint && deno task test` 全綠才算完成。
- 新規則要 `deno task build` 後做 operational verification（餵 JSON 給 binary），不要只信單元測試。
- **不得對 subagent 套用 worktree 隔離**；一律在當前工作目錄執行。
- commit 一律以具體檔案路徑 `git add`，禁止 `git add -A` / `git add .`。

---

## 檔案結構

**新增**

| 檔案 | 責任 |
|---|---|
| `src/engine/tilde.ts` | tilde 語義的單一真相來源：`hasUnquotedLeadingTilde` 述詞 + `expandTilde` 展開 |
| `src/engine/subst_eval.ts` | command substitution 靜態求值框架 + 求值器註冊表 |
| `src/rules/commands/base64.ts` | base64 規則（獨立，`CommandSpec` 驅動） |
| `src/rules/commands/test.ts` | `test` 規則（單一一元檔案測試運算子） |
| `src/rules/commands/cygpath.ts` | cygpath 規則（三種旗標形態） |
| `src/rules/commands/npm.ts` | npm 子指令 + 操作元 allowlist |

**修改**

| 檔案 | 改動 |
|---|---|
| `src/engine/scope.ts` | `ScopeConfig` 加 `shellHome`；`resolvePath` / `resolvePathValue` 套用 tilde 語義 |
| `src/main.ts` | 新增 `shellHomeDir`（讀 `HOME`），傳入 `evaluate` |
| `src/engine/evaluate.ts` | 新增 `shellHome` 參數並往下傳 |
| `src/engine/classify.ts` | 新增 `shellHome` 參數；中央前置規則一擴充 `unknown` 分支 |
| `src/engine/cwd.ts` | `applyCd` 改用求值框架；`cd -` / `cd ~` 語義 |
| `src/rules/allowlist.ts` | 註冊四條新規則 |
| `CLAUDE.md` | 同步管線、不變量、已接受限制 |

**每個新檔都配一個 `_test.ts`**（同目錄、同名加 `_test` 後綴），這是本專案既有慣例。

---

### Task 1: tilde 語義模組

tilde 展開在三個地方需要：`cd` 目標、求值器的 argv、路徑操作元。三處語義相同，因此先做成單一模組，後續 Task 一律引用它，不各自重寫。

**Files:**
- Create: `src/engine/tilde.ts`
- Test: `src/engine/tilde_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/engine/tilde_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";

/** 取出 `cd <word>` 的第一個 argv Word。 */
function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("hasUnquotedLeadingTilde: 未加引號的 ~ 會被 bash 展開", () => {
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~")), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~/src")), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~user/x")), true);
});

Deno.test("hasUnquotedLeadingTilde: 引號抑制展開", () => {
  // `cd "~"` 的 value 同樣是 "~"，只有 word 結構能區分
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd "~"')), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd '~/x'")), false);
});

Deno.test("hasUnquotedLeadingTilde: 混合引號形態的開頭 ~ 仍會展開", () => {
  // parts = [Literal("~/"), DoubleQuoted]
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd ~/"src"')), true);
});

Deno.test("hasUnquotedLeadingTilde: 不以 ~ 開頭者一律 false", () => {
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd src")), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd "$(echo x)"')), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd a~b")), false);
});

Deno.test("expandTilde: 只支援 ~ 與 ~/<rest>", () => {
  assertEquals(expandTilde("~", "/home/u"), "/home/u");
  assertEquals(expandTilde("~/x/y", "/home/u"), "/home/u/x/y");
});

Deno.test("expandTilde: 其餘形態不可解析", () => {
  assertEquals(expandTilde("~user", "/home/u"), null);
  assertEquals(expandTilde("~user/x", "/home/u"), null);
  assertEquals(expandTilde("~+", "/home/u"), null);
  assertEquals(expandTilde("~-", "/home/u"), null);
  assertEquals(expandTilde("~+1", "/home/u"), null);
  assertEquals(expandTilde("src", "/home/u"), null);
});

Deno.test("expandTilde: shellHome 未知時不可解析", () => {
  assertEquals(expandTilde("~/x", null), null);
  assertEquals(expandTilde("~/x", "   "), null);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/tilde_test.ts`
Expected: FAIL，訊息類似 `Module not found "file:///…/src/engine/tilde.ts"`

- [ ] **Step 3: 實作**

`src/engine/tilde.ts`：

```ts
import type { Word } from "../deps.ts";

/**
 * word 是否會被 bash 施以 tilde expansion——即開頭的 `~` 未被引號保護。
 *
 * **只看 word 結構，不看 `staticValue` 的結果字串**：引號會抑制 tilde expansion，
 * 而 staticValue 已把引號資訊抹除。實測三種 word：
 *   `~/src`    parts=[]                              staticValue="~/src"  → 展開為 $HOME/src
 *   `"~"`      parts=["DoubleQuoted"]                 staticValue="~"      → 不展開，相對 ./~
 *   `~/"src"`  parts=["Literal(~/)","DoubleQuoted"]   staticValue="~/src"  → 開頭 ~ 仍展開
 * 第三列是混合形態，第一個 part 未加引號，故第二個分支不可省略。
 */
export function hasUnquotedLeadingTilde(word: Word): boolean {
  const parts = word.parts;
  if (!parts || parts.length === 0) return word.value.startsWith("~");
  const head = parts[0];
  return head.type === "Literal" && head.value.startsWith("~");
}

/**
 * 展開「支援的 tilde 形態」：恰為 `~`，或 `~/<rest>`。
 *
 * 其餘形態一律回 null（不可解析），因為本工具無從得知它們展開成什麼：
 *   `~<username>`  其他使用者的 home
 *   `~+` / `~-`    $PWD / $OLDPWD
 *   `~+N` / `~-N` / `~N`  directory stack 項目
 * 絕不可寫成「以 `~` 開頭就當成 home」——那會把 `~otheruser/x` 錯誤映射到當前使用者的 home。
 *
 * `shellHome` 必須是 bash 的 `$HOME`，不是 settings 的 `resolveHome`（後者在 Windows
 * 優先 USERPROFILE）。未知時回 null，呼叫端據此 fail-closed。
 */
export function expandTilde(value: string, shellHome: string | null): string | null {
  if (value !== "~" && !value.startsWith("~/")) return null;
  if (shellHome === null || shellHome.trim() === "") return null;
  return value === "~" ? shellHome : shellHome + value.slice(1);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/tilde_test.ts`
Expected: PASS（7 個 test 全綠）

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`
Expected: 無錯誤

```bash
git add src/engine/tilde.ts src/engine/tilde_test.ts
git commit -m "feat(engine): add tilde predicate and expansion as a single source of truth"
```

---

### Task 2: scope.ts 套用 tilde 語義（修既有放行漏洞）

**這個 Task 單獨就有安全價值**：目前 `cat ~/.ssh/id_rsa` 會被自動放行，因為未加引號的 `~/` 被當成相對路徑接到 cwd 之後、判定為專案內。

`ScopeConfig` 需要一個**與既有 `home` 分離**的 `shellHome`：既有 `home` 來自 `resolveHome`（Windows 優先 `USERPROFILE`），供 `Read(~/…)` 權限規則與 `<home>/.claude` 定位使用；bash 的 tilde expansion 只看 `HOME`。兩者不同時，用錯會拿「已授權的 USERPROFILE 路徑」核准「未授權的 HOME 路徑」。

**Files:**
- Modify: `src/engine/scope.ts`（`ScopeConfig`、`buildScopeConfig`、`rootScope`、`resolvePathValue`、`resolvePath`）
- Modify: `src/engine/evaluate.ts`、`src/engine/classify.ts`（傳遞 `shellHome`）
- Modify: `src/main.ts`（新增 `shellHomeDir`）
- Test: `src/engine/scope_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/scope_test.ts` 末尾（既有 import 若缺 `parse` / `Command` / `Word` 請補上）：

```ts
Deno.test("resolvePath: 未加引號的 ~/ 以 shellHome 展開後落在專案外 → out-of-project", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const scope = { ...rootScope("/proj"), shellHome: "/home/u" };
  assertEquals(resolvePath(wordOf("cat ~/secret"), cwd, scope), "out-of-project");
  assertEquals(resolvePath(wordOf("cat ~/.ssh/id_rsa"), cwd, scope), "out-of-project");
});

Deno.test("resolvePath: 引號包裝的 ~ 維持相對語義（指向 ./~ ，確實在專案內）", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const scope = { ...rootScope("/proj"), shellHome: "/home/u" };
  assertEquals(resolvePath(wordOf('cat "~/secret"'), cwd, scope), "in-project");
});

Deno.test("resolvePath: 不支援的 tilde 形態與 shellHome 未知皆 out-of-project", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const withHome = { ...rootScope("/proj"), shellHome: "/home/u" };
  const noHome = { ...rootScope("/proj"), shellHome: null };
  assertEquals(resolvePath(wordOf("cat ~user/x"), cwd, withHome), "out-of-project");
  assertEquals(resolvePath(wordOf("cat ~+/x"), cwd, withHome), "out-of-project");
  assertEquals(resolvePath(wordOf("cat ~/x"), cwd, noHome), "out-of-project");
});

Deno.test("resolvePath: 展開後落在專案內則 in-project", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const scope = { ...rootScope("/proj"), shellHome: "/proj/home" };
  assertEquals(resolvePath(wordOf("cat ~/x"), cwd, scope), "in-project");
});

Deno.test("resolvePathValue: 以 ~ 開頭的字串值 fail-closed", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const scope = { ...rootScope("/proj"), shellHome: "/home/u" };
  // 字串值沒有 word 結構，無從判斷引號 → 一律視為超出範圍
  assertEquals(resolvePathValue("~/x", cwd, scope), "out-of-project");
});
```

在該檔案上方（既有 helper 附近）加入：

```ts
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";

/** 取出指令的第一個 argv Word。 */
function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL。`shellHome` 尚未存在於 `ScopeConfig`，型別檢查會擋下；即使忽略型別，`cat ~/secret` 目前會回 `in-project`。

- [ ] **Step 3: 實作 scope.ts**

在 `src/engine/scope.ts` 頂端的 import 加入：

```ts
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";
```

`ScopeConfig` 介面加一個欄位（放在 `home` 之後）：

```ts
  /**
   * bash 的 home（`$HOME`），**僅供 tilde 展開**。與上方 `home` 刻意分離：
   * `home` 來自 settings 的 resolveHome（Windows 優先 USERPROFILE），供權限規則
   * 與 <home>/.claude 定位使用；bash 的 tilde expansion 只看 HOME。兩者不同時混用
   * 會拿「已授權的 USERPROFILE 路徑」核准「未授權的 HOME 路徑」。
   */
  shellHome: string | null;
```

`buildScopeConfig` 加參數並填入（保留既有呼叫端相容性，故給預設值）：

```ts
export function buildScopeConfig(
  root: string,
  rules: PermissionRules,
  home: string | null,
  trustedReadRoots: string[],
  shellHome: string | null = null,
): ScopeConfig {
  return {
    root,
    home,
    shellHome,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: trustedReadRoots,
  };
}
```

`rootScope` 補上欄位：

```ts
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    home: null,
    shellHome: null,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
    trusted: [],
  };
}
```

`resolvePathValue` 開頭加 fail-closed：

```ts
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  // fail-closed：字串值沒有 word 結構，無從判斷開頭的 `~` 是否被引號保護。
  // 未加引號時 bash 展開為 $HOME（專案外），加引號時是 ./~（專案內）——無法區分就取安全的一邊。
  // 代價是 `--flag="~/x"` 這類引號形態會被誤 ask；此形態罕見，方向安全。
  if (value.startsWith("~")) return "out-of-project";
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}
```

`resolvePath` 改為先套用 tilde 語義：

```ts
/** 解析單一參數對專案根的範圍（三態）。未加引號的 leading tilde 先展開再判定。 */
export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (hasUnquotedLeadingTilde(arg)) {
    const v = staticValue(arg);
    if (v === null) return "dynamic";
    const expanded = expandTilde(v, scope.shellHome);
    // 不支援的 tilde 形態（~user / ~+ / ~-）或 shellHome 未知 → 絕不退回相對路徑語義，
    // 那正是本次要修的漏洞（`cat ~/.ssh/id_rsa` 被判成 <project>/~/.ssh/id_rsa）。
    if (expanded === null) return "out-of-project";
    return resolvePathValue(expanded, cwd, scope);
  }
  return resolvePathValue(staticValue(arg), cwd, scope);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: PASS

- [ ] **Step 5: 串接 shellHome 到呼叫端**

`src/main.ts` — 在既有 `homeDir` 之後加入：

```ts
/**
 * bash 的 home（`$HOME`），僅供 tilde 展開。
 * 刻意不重用 resolveHome：後者在 Windows 優先 USERPROFILE，而 bash tilde expansion 只看 HOME。
 */
export function shellHomeDir(env: EnvReader): string | null {
  const h = env.get("HOME");
  return h && h.trim() !== "" ? normalizeAbsolute(h) : null;
}
```

在 `main()` 內呼叫 `evaluate` 的那一行（既有寫法為
`decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);`）改為：

```ts
    let shellHome: string | null = null;
    try {
      shellHome = shellHomeDir(Deno.env);
    } catch {
      shellHome = null; // env 權限失敗 → tilde 一律不可解析（fail-safe）
    }
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted, shellHome);
```

`src/engine/evaluate.ts` — `evaluate` 簽名加最後一個參數並往下傳：

```ts
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
  shellHome: string | null = null,
): Decision {
```

同檔內兩處使用點改為：

```ts
    const scope = buildScopeConfig(root, rules, home, trustedReadRoots, shellHome);
```

```ts
    return combine(
      invocations.map((inv) =>
        classify(inv, root, rules, home, trustedReadRoots, sessionCwdInScope, shellHome)
      ),
    );
```

`src/engine/classify.ts` — `classify` 簽名加最後一個參數，並傳給 `buildScopeConfig`：

```ts
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
  sessionCwdInScope = false,
  shellHome: string | null = null,
): RuleVerdict {
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots, shellHome);
```

- [ ] **Step 6: 執行全部測試，確認沒有既有測試回歸**

Run: `deno task test`
Expected: PASS。若有既有測試斷言「`~/…` 路徑 allow」，那正是本次要修掉的錯誤行為——把該測試的期望改成 `ask`，並在測試名稱補上 `（tilde 展開後在專案外）`。

- [ ] **Step 7: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/engine/scope.ts src/engine/scope_test.ts src/engine/evaluate.ts src/engine/classify.ts src/main.ts
git commit -m "fix(engine): expand unquoted leading tilde before scope checks"
```

---

### Task 3: 中央前置規則一擴充 unknown cwd

目前規則一只在 `inv.cwd.kind === "known"` 時檢查，於是把 cd 目標寫成動態即可整個跳過——實測 `cd "$(echo D:/外部)" && git log --oneline -3` 現在回 allow，而等價的靜態寫法回 ask。

`src/main.ts` 的 `initialCwd` 在缺 `cwd` 欄位時 fallback 到專案根，因此**初始 cwd 恆為 known**；任何 `unknown` 必然源自鏈內 `cd` 或 `git -C <動態>`。

**Files:**
- Modify: `src/engine/classify.ts:29-35`（`centralPreflightAsk` 規則一）
- Test: `src/engine/classify_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/classify_test.ts`（沿用該檔既有的 invocation 建構方式；若該檔以 `parse` + `walk` 建 invocation，照既有 helper 寫）：

```ts
Deno.test("central rule 1: cwd unknown → 不可升級 ask", () => {
  const inv: CommandInvocation = {
    name: "git",
    argv: [],
    assignments: [],
    redirects: [],
    cwd: { kind: "unknown" },
  };
  const v = classify(inv, "/proj");
  assertEquals(v.kind, "ask");
});

Deno.test("central rule 1: cwd unknown 不可由 permissions.allow 升級", () => {
  const inv: CommandInvocation = {
    name: "git",
    argv: [],
    assignments: [],
    redirects: [],
    cwd: { kind: "unknown" },
  };
  const rules: PermissionRules = {
    ...EMPTY_RULES,
    bash: { allow: ["git *"], deny: [], ask: [] },
  };
  assertEquals(classify(inv, "/proj", rules).kind, "ask");
});
```

> 註：第二個測試的 `rules` 物件請照 `src/permissions/settings.ts` 的 `PermissionRules` 實際形狀建構（本專案既有測試已有寫法可複製）；重點是斷言「即使命中 allow 仍為 ask」。

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL。目前 unknown cwd 不觸發規則一，`git`（無參數）會取得 allow。

- [ ] **Step 3: 實作**

`src/engine/classify.ts` 的 `centralPreflightAsk`，把規則一改為：

```ts
  // 一：cwd 範圍。skipCwdCheck 由 classify 依五道護欄算出；規則二/三/四不受影響。
  if (!skipCwdCheck) {
    // 初始 cwd 恆為 known（main.ts 的 initialCwd 缺欄位時 fallback 到專案根），
    // 故 unknown 必然源自鏈內 cd 或 git -C <動態>——即「將在本工具無法確定的目錄執行」。
    // 這正是規則一要防的情形；不擋的話，把 cd 目標寫成動態就能整個跳過範圍檢查。
    if (inv.cwd.kind === "unknown") {
      return ask(`${inv.name}：工作目錄無法靜態確定（鏈內 cd 目標為動態）`);
    }
    if (!isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
      return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
    }
  }
```

> cwd 豁免路徑不需額外處理：五道護欄的第 (2) 條本就要求 `inv.cwd.kind === "known"` 且
> `origin === "chain-cd"`，unknown 永遠無法滿足，故 `skipCwdCheck` 在 unknown 下恆為 false。

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS

- [ ] **Step 5: 全量測試**

Run: `deno task test`
Expected: PASS。既有測試若有「動態 cd 後仍 allow」的斷言，改為 `ask`（這是刻意的收緊）。

- [ ] **Step 6: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "fix(engine): unknown cwd must ask - dynamic cd targets bypassed rule 1"
```

---

### Task 4: 求值框架骨架與資格檢查

框架只負責「這個 word 夠不夠格求值」，實際語義交給註冊的求值器。本 Task 先做資格檢查與空註冊表，成員在 Task 5 / 6 加入。

資格條件（全部滿足才求值，任一不成立回 `null`）：

1. `word.parts` 恰為一個 `DoubleQuoted`，且其 `parts` 恰為一個 `CommandExpansion`
2. **未加引號的 substitution 一律不求值**——bash 對其施以 word splitting 與空值移除，`cd $(echo -n)` 展開後是零個參數、實際執行 `cd`（→ `$HOME`）
3. 內層 `Script` 恰含一個 `Statement`，其 `command` 為單一 `Command`，且 Statement 與 Command 皆無 redirects、無 `background`、Command 無賦值前綴
4. 指令名靜態且命中註冊表
5. 所有 argv 靜態，且無任何 argv 命中 `hasUnquotedLeadingTilde`
6. 求值器回非 null
7. 結果不含換行字元
8. 結果非空字串

**Files:**
- Create: `src/engine/subst_eval.ts`
- Test: `src/engine/subst_eval_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/engine/subst_eval_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { evalSubstitutionWord } from "./subst_eval.ts";
import type { CwdState } from "../types.ts";

const CWD: CwdState = { kind: "known", path: "/proj" };

function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("framework: 未註冊的指令名不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(uname -a)"'), CWD, null), null);
});

Deno.test("framework: 未加引號的 substitution 一律不求值", () => {
  // bash 對未加引號的展開做 word splitting 與空值移除，語義與單一字串不同
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo foo)"), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo -n)"), CWD, null), null);
});

Deno.test("framework: 混合 word 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo foo)/sub"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "pre$(echo foo)"'), CWD, null), null);
});

Deno.test("framework: 內層有 pipeline / 多 statement / 重導向 / 賦值前綴皆不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a | tr a b)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a; echo b)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a > /tmp/x)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(FOO=1 echo a)"'), CWD, null), null);
});

Deno.test("framework: 動態 argv 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo $X)"'), CWD, null), null);
});

Deno.test("framework: argv 含未加引號 tilde 不求值", () => {
  // 外層 substitution 的雙引號不會抑制內層的 tilde expansion
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/x)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/"src")"'), CWD, null), null);
});

Deno.test("framework: 非 substitution 的 word 回 null", () => {
  assertEquals(evalSubstitutionWord(wordOf("cd /proj/src"), CWD, null), null);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: FAIL，`Module not found "…/src/engine/subst_eval.ts"`

- [ ] **Step 3: 實作骨架**

`src/engine/subst_eval.ts`：

```ts
import type { Command, Script, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { hasUnquotedLeadingTilde } from "./tilde.ts";

/**
 * 單一指令的靜態求值器。必須是純函式、不碰檔案系統、不丟例外。
 * 任何「輸出可能取決於檔案系統狀態、環境變數或執行期 shell 選項」的情形一律回 null。
 */
export interface SubstEvaluator {
  names: string[];
  /**
   * @param argv 呼叫端已確認全部靜態、且無未加引號 tilde 的引數字串
   * @param cwd  該指令執行時的 cwd（unknown 時多數求值器應回 null）
   * @param shellHome bash 的 $HOME；目前成員皆不需要，保留供未來擴充
   */
  evaluate(argv: string[], cwd: CwdState, shellHome: string | null): string | null;
}

/** 成員於 Task 5 / 6 填入。 */
const EVALUATORS: SubstEvaluator[] = [];

const INDEX = new Map<string, SubstEvaluator>();
for (const e of EVALUATORS) {
  for (const n of e.names) {
    if (INDEX.has(n)) throw new Error(`duplicate substitution evaluator for: ${n}`);
    INDEX.set(n, e);
  }
}

/** 內層 Script 若恰為「單一簡單指令、無重導向、無賦值前綴、非背景」則回該 Command。 */
function loneSimpleCommand(script: Script | undefined): Command | null {
  if (!script) return null;
  if (script.commands.length !== 1) return null;
  const stmt = script.commands[0];
  if (stmt.background) return null;
  if (stmt.redirects.length > 0) return null;
  const cmd = stmt.command;
  if (cmd.type !== "Command") return null; // pipeline / 控制流 / subshell 一律不求值
  if (cmd.redirects.length > 0) return null;
  if (cmd.prefix.length > 0) return null; // 賦值前綴可改變執行行為
  return cmd;
}

/**
 * 整個 Word 恰為單一 `"$(…)"` 且內層可靜態求值時回結果字串，否則 null。
 *
 * **只接受加了雙引號的形態**：未加引號的 `$(…)` 會被 bash 施以 word splitting 與
 * 空值移除，語義與「求值成單一字串」不同——`cd $(echo -n)` 展開後是零個參數，
 * 實際執行 `cd`（→ $HOME），而非 cd 到空字串。
 */
export function evalSubstitutionWord(
  word: Word,
  cwd: CwdState,
  shellHome: string | null,
): string | null {
  const parts = word.parts;
  // 資格 1 + 2：恰一個 DoubleQuoted，其內恰一個 CommandExpansion
  if (!parts || parts.length !== 1) return null;
  const quoted = parts[0];
  if (quoted.type !== "DoubleQuoted") return null;
  if (quoted.parts.length !== 1) return null;
  const expansion = quoted.parts[0];
  if (expansion.type !== "CommandExpansion") return null;

  // 資格 3：內層是單一簡單指令
  const cmd = loneSimpleCommand(expansion.script);
  if (cmd === null) return null;

  // 資格 4：指令名靜態且已註冊
  if (!cmd.name) return null;
  const name = staticValue(cmd.name);
  if (name === null) return null;
  const evaluator = INDEX.get(name);
  if (!evaluator) return null;

  // 資格 5：argv 全靜態，且無未加引號 tilde
  const argv: string[] = [];
  for (const w of cmd.suffix) {
    if (hasUnquotedLeadingTilde(w)) return null;
    const v = staticValue(w);
    if (v === null) return null;
    argv.push(v);
  }

  // 資格 6～8
  const out = evaluator.evaluate(argv, cwd, shellHome);
  if (out === null) return null;
  if (out.includes("\n") || out.includes("\r")) return null; // 多行輸出作為 cd 目標無意義
  if (out === "") return null; // 空字串沒有安全的解釋：bash 語義依引號與否而異
  return out;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: PASS（此時註冊表為空，所有案例都回 null，正是預期）

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/engine/subst_eval.ts src/engine/subst_eval_test.ts
git commit -m "feat(engine): add command substitution evaluation framework"
```

---

### Task 5: 純字串類求值器（dirname / basename / pwd / echo / printf）

語義依據（全部實測自 GNU coreutils 8.32 + bash 5.3.9）：

- `dirname`：`/`→`/`、`/a`→`/`、`/a/b/`→`/a`、`a`→`.`、空字串→`.`、`/a//b`→`/a`、`./a`→`.`
- `basename`：`/`→`/`、`/a/b/`→`b`、`a`→`a`、`/a/b.txt .txt`→`b`
- `echo`：多操作元以單一空格分隔；**預設不解釋反斜線**，但 bash 的 `xpg_echo` shopt 為 on 時會解釋——該 shopt 是執行期狀態、靜態不可知，故**操作元含反斜線時放棄求值**
- `printf`：**格式字串永遠解釋反斜線**（即使不含 `%`），與 echo 相反

**Files:**
- Modify: `src/engine/subst_eval.ts`
- Test: `src/engine/subst_eval_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/subst_eval_test.ts`：

```ts
Deno.test("dirname: 邊界語義", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b)"'), CWD, null), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b/)"'), CWD, null), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a//b)"'), CWD, null), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a)"'), CWD, null), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /)"'), CWD, null), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname a)"'), CWD, null), ".");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname ./a)"'), CWD, null), ".");
});

Deno.test("dirname: 多操作元與旗標不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b /c/d)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname -z /a/b)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname)"'), CWD, null), null);
});

Deno.test("basename: 邊界語義與後綴", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b)"'), CWD, null), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b/)"'), CWD, null), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename a)"'), CWD, null), "a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /)"'), CWD, null), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b.txt .txt)"'), CWD, null), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -s .txt /a/b.txt)"'), CWD, null), "b");
});

Deno.test("basename: -a / -z / 操作元過多不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -a /a/b /c/d)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -z /a/b)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b .b extra)"'), CWD, null), null);
});

Deno.test("pwd: 回當前 cwd；帶旗標或 cwd unknown 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), CWD, null), "/proj");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd -P)"'), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), { kind: "unknown" }, null), null);
});

Deno.test("echo: 無旗標或僅 -n、操作元不含反斜線才求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo /a/b)"'), CWD, null), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -n /a/b)"'), CWD, null), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a b)"'), CWD, null), "a b");
});

Deno.test("echo: -e 與含反斜線的操作元不求值", () => {
  // xpg_echo shopt 為 on 時 bash 預設就解釋反斜線，該狀態靜態不可知
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo -e /a/b)"`), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo '/a\tb')"`), CWD, null), null);
});

Deno.test("printf: 只求值 '%s' 單一操作元與無 % 無反斜線的純字面", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' /a/b)"`), CWD, null), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf /a/b)"`), CWD, null), "/a/b");
});

Deno.test("printf: 其餘形態不求值", () => {
  // 格式字串永遠解釋反斜線，即使不含 %
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '/a\tb')"`), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '%s\n' /a/b)"`), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' a b)"`), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%b' a)"`), CWD, null), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf -v x '%s' a)"`), CWD, null), null);
});
```

> 註：`printf '%s\n'` 的格式字串含反斜線，依「格式字串不得含反斜線」一律不求值——
> 這比 spec 舉的例子更保守，且與「格式字串永遠解釋反斜線」的實測一致。

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: FAIL，新加的案例全部回 `null`（註冊表仍為空）

- [ ] **Step 3: 實作**

在 `src/engine/subst_eval.ts` 的 `const EVALUATORS` 之前加入下列求值器，並把它們填進 `EVALUATORS` 陣列：

```ts
/** 去掉尾端斜線（但單一 "/" 保留）。 */
function stripTrailingSlashes(s: string): string {
  let out = s;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** GNU dirname 語義（純字串，不碰檔案系統）。 */
function dirnameOf(value: string): string {
  const s = stripTrailingSlashes(value);
  const idx = s.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return stripTrailingSlashes(s.slice(0, idx));
}

/** GNU basename 語義（純字串，不碰檔案系統）。 */
function basenameOf(value: string, suffix?: string): string {
  const s = stripTrailingSlashes(value);
  if (s === "/") return "/";
  const idx = s.lastIndexOf("/");
  let base = idx === -1 ? s : s.slice(idx + 1);
  if (suffix && suffix !== base && base.endsWith(suffix)) {
    base = base.slice(0, -suffix.length);
  }
  return base;
}

const dirnameEvaluator: SubstEvaluator = {
  names: ["dirname"],
  evaluate(argv) {
    // 旗標（含 -z/--zero）與多操作元一律放棄：-z 改用 NUL 分隔、多操作元逐行輸出
    if (argv.length !== 1) return null;
    if (argv[0].startsWith("-")) return null;
    return dirnameOf(argv[0]);
  },
};

const basenameEvaluator: SubstEvaluator = {
  names: ["basename"],
  evaluate(argv) {
    // `basename -s SUFFIX NAME`
    if (argv.length === 3 && argv[0] === "-s") {
      if (argv[2].startsWith("-")) return null;
      return basenameOf(argv[2], argv[1]);
    }
    // `basename NAME` / `basename NAME SUFFIX`
    if (argv.length === 1 || argv.length === 2) {
      if (argv.some((a) => a.startsWith("-"))) return null;
      return basenameOf(argv[0], argv[1]);
    }
    return null;
  },
};

const pwdEvaluator: SubstEvaluator = {
  names: ["pwd"],
  evaluate(argv, cwd) {
    if (argv.length !== 0) return null; // -P 會解 symlink，需碰檔案系統
    if (cwd.kind !== "known") return null;
    return cwd.path;
  },
};

const echoEvaluator: SubstEvaluator = {
  names: ["echo"],
  evaluate(argv) {
    let i = 0;
    if (argv[i] === "-n") i++; // -n 只影響尾端換行，而 $(...) 本就剝除尾端換行
    const operands = argv.slice(i);
    if (operands.length === 0) return null;
    for (const o of operands) {
      // 任一旗標（-e/-E/其他）→ 放棄；`--` 在 echo 不是選項終止符（實測 `echo -- foo` 印 "-- foo"），
      // 故一律保守處理
      if (o.startsWith("-")) return null;
      // 含反斜線時，輸出取決於執行期的 xpg_echo shopt（靜態不可知）→ 放棄
      if (o.includes("\\")) return null;
    }
    return operands.join(" ");
  },
};

const printfEvaluator: SubstEvaluator = {
  names: ["printf"],
  evaluate(argv) {
    if (argv.length === 0) return null;
    const fmt = argv[0];
    // 格式字串永遠解釋反斜線（即使不含 %），故含反斜線一律放棄
    if (fmt.includes("\\")) return null;
    if (fmt.startsWith("-")) return null; // -v var 會賦值而非輸出
    if (fmt === "%s") {
      if (argv.length !== 2) return null; // 格式會重複套用到所有參數
      if (argv[1].includes("\\")) return null;
      return argv[1];
    }
    if (!fmt.includes("%") && argv.length === 1) return fmt;
    return null;
  },
};
```

把 `EVALUATORS` 改為：

```ts
const EVALUATORS: SubstEvaluator[] = [
  dirnameEvaluator,
  basenameEvaluator,
  pwdEvaluator,
  echoEvaluator,
  printfEvaluator,
];
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/engine/subst_eval.ts src/engine/subst_eval_test.ts
git commit -m "feat(engine): add string-only substitution evaluators"
```

---

### Task 6: cygpath 求值器

**只在 Windows 啟用**，非 Windows 一律回 `null`：cygpath 是 Cygwin/MSYS2 工具，在 Linux/macOS 不存在；而求值所依賴的「`/d/x` 與 `D:/x` 等價」正是 `scope.ts` 的 `normalizeAbsolute` 僅在 Windows 套用的磁碟機正規化。

可求值旗標（實測 cygpath 3.6.7 確認輸出完全由輸入字串決定）：`-u`、`-w`、`-m`、`-t unix|windows|mixed`、`-a`、`-C <cp>`、`-i`。求值結果即「操作元路徑原樣」——`-u`/`-w`/`-m` 只改變磁碟機與斜線的書寫形式，而 `applyPath` 隨即呼叫 `normalizeAbsolute`，`D:/x`、`D:\x`、`/d/x` 在 Windows 上會正規化成同一字串。

不可求值：`-d`、`-t dos`、`-s`、`-l`（皆需查檔案系統；實測 `cygpath -d '/d/nonexistent'` → `cannot create short name`、exit 2；`cygpath -w -l '/c/PROGRA~1'` → `C:\Program Files`）、`-M`、`-D`/`-H`/`-O`/`-P`/`-S`/`-W`/`-F`/`-A`（輸出系統目錄）、`-f`/`-o`（讀檔）、`-U`/`-r`/`-p`（輸出形式與 `normalizeAbsolute` 不保證等價）。

**Files:**
- Modify: `src/engine/subst_eval.ts`
- Test: `src/engine/subst_eval_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/subst_eval_test.ts`：

```ts
const WIN_ONLY = { ignore: Deno.build.os !== "windows" };

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 純轉換旗標求值為操作元原樣",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD, null), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj)"`), CWD, null), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w /d/proj)"`), CWD, null), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t unix 'D:/proj')"`), CWD, null), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath 'D:/proj')"`), CWD, null), "D:/proj");
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 查檔案系統的旗標不求值",
  fn() {
    // -d / -t dos / -s 都是 DOS 8.3 短名，-l 是長名還原，皆需查檔案系統
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -d 'D:/proj')"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t dos 'D:/proj')"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -s 'D:/proj')"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -l 'D:/proj')"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -M 'D:/proj')"`), CWD, null), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 系統目錄旗標與讀檔旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -D)"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -S)"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -f list.txt)"`), CWD, null), null);
    // 輸出形式與 normalizeAbsolute 不保證等價
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -U 'D:/proj')"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -r /d/proj)"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -p /a:/b)"`), CWD, null), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: -a 需要 known cwd；操作元必須恰一個",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), CWD, null), "sub");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), { kind: "unknown" }, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u a b)"`), CWD, null), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u)"`), CWD, null), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 未知旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -Z 'D:/proj')"`), CWD, null), null);
  },
});

Deno.test({
  ignore: Deno.build.os === "windows",
  name: "cygpath: 非 Windows 平台一律不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD, null), null);
  },
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: FAIL（Windows 上正面案例回 null）

- [ ] **Step 3: 實作**

在 `src/engine/subst_eval.ts` 加入求值器：

```ts
/**
 * cygpath 可靜態求值的旗標。
 * 不吃值：-u -w -m -a -i
 * 吃值：  -t <type>（僅 unix|windows|mixed）、-C <codepage>
 * 其餘一律不求值——詳見下方 evaluate 內的分類註解。
 */
const CYGPATH_VALUELESS = new Set(["-u", "-w", "-m", "-a", "-i"]);
const CYGPATH_WITH_VALUE = new Set(["-t", "-C"]);
const CYGPATH_SAFE_TYPES = new Set(["unix", "windows", "mixed"]);

const cygpathEvaluator: SubstEvaluator = {
  names: ["cygpath"],
  evaluate(argv, cwd) {
    // cygpath 只存在於 Cygwin/MSYS2；求值所依賴的「/d/x ≡ D:/x」也只在 Windows 成立
    // （normalizeAbsolute 的磁碟機正規化以 Deno.build.os 鎖定）。
    if (Deno.build.os !== "windows") return null;

    let needsKnownCwd = false;
    const operands: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (!t.startsWith("-")) {
        operands.push(t);
        continue;
      }
      if (CYGPATH_VALUELESS.has(t)) {
        if (t === "-a") needsKnownCwd = true; // 相對路徑以行程 cwd 展開
        continue;
      }
      if (CYGPATH_WITH_VALUE.has(t)) {
        i++;
        if (i >= argv.length) return null;
        // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）
        if (t === "-t" && !CYGPATH_SAFE_TYPES.has(argv[i])) return null;
        continue;
      }
      // 其餘一律不求值：
      //   -d / -s / -l  短名與長名還原，需查檔案系統（-d 對不存在路徑 exit 2）
      //   -M            回報 binary/text，需查檔案系統
      //   -D -H -O -P -S -W -F -A  輸出系統目錄，與輸入無關
      //   -f / -o       從檔案或 stdin 讀取操作元／選項
      //   -U / -r / -p  輸出形式（/proc/cygdrive、\\?\、PATH 列表）與 normalizeAbsolute 不保證等價
      return null;
    }

    if (operands.length !== 1) return null;
    if (needsKnownCwd && cwd.kind !== "known") return null;
    // -u/-w/-m 只改變磁碟機與斜線的書寫形式；呼叫端的 applyPath 隨即 normalizeAbsolute，
    // 在 Windows 上 D:/x、D:\x、/d/x 會正規化成同一字串，故回操作元原樣即可。
    return operands[0];
  },
};
```

把 `cygpathEvaluator` 加進 `EVALUATORS` 陣列。

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/engine/subst_eval.ts src/engine/subst_eval_test.ts
git commit -m "feat(engine): add cygpath substitution evaluator (Windows only)"
```

---

### Task 7: cwd.ts 接線與 cd 語義修正

`applyCd` 目前只接受靜態 token，參數為 command substitution 時回 `unknown`——這正是 `cd "$(cygpath -u 'D:/proj')"` 之後所有相對路徑操作元解析失敗的原因。

同時修兩個既有缺陷：`staticValue` 對 `-` 與 `~` 分別回字面 `"-"`、`"~"`，被 `applyPath` 當成相對路徑接成 `<cwd>/-`、`<cwd>/~`，於是 cwd 被判定成一個**專案內的錯誤路徑**而放行。

**Files:**
- Modify: `src/engine/cwd.ts`（`applyCd`）
- Modify: `src/engine/walk.ts`（`applyCd` 呼叫點需傳 `shellHome`）
- Test: `src/engine/cwd_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/cwd_test.ts`（沿用該檔既有的 helper 取得 `Command`）：

```ts
Deno.test("applyCd: cd - 靜態不可知 → unknown", () => {
  assertEquals(applyCd(cmdOf("cd -"), { kind: "known", path: "/proj" }, null).kind, "unknown");
});

Deno.test("applyCd: cd ~ 以 shellHome 展開", () => {
  const r = applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }, "/home/u");
  assertEquals(r, { kind: "known", path: "/home/u", origin: "chain-cd" });
  const r2 = applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "/home/u");
  assertEquals(r2, { kind: "known", path: "/home/u/src", origin: "chain-cd" });
});

Deno.test("applyCd: cd ~ 在 shellHome 未知時 unknown", () => {
  assertEquals(applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }, null).kind, "unknown");
});

Deno.test('applyCd: cd "~" 引號抑制展開，維持相對語義', () => {
  const r = applyCd(cmdOf('cd "~"'), { kind: "known", path: "/proj" }, "/home/u");
  assertEquals(r, { kind: "known", path: "/proj/~", origin: "chain-cd" });
});

Deno.test("applyCd: 混合引號 tilde 形態 → unknown", () => {
  // `cd ~/"src"` 的開頭 ~ 仍會展開，但後段是引號內容；不臆測混合展開結果
  assertEquals(applyCd(cmdOf('cd ~/"src"'), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
});

Deno.test("applyCd: 可求值的 substitution 推導出具體 cwd", () => {
  const r = applyCd(cmdOf('cd "$(dirname /proj/src/a.ts)"'), { kind: "known", path: "/proj" }, null);
  assertEquals(r, { kind: "known", path: "/proj/src", origin: "chain-cd" });
});

Deno.test("applyCd: 不可求值的 substitution 仍為 unknown", () => {
  assertEquals(applyCd(cmdOf('cd "$(uname -a)"'), { kind: "known", path: "/proj" }, null).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd $(dirname /a/b)"), { kind: "known", path: "/proj" }, null).kind, "unknown");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: FAIL（`applyCd` 目前只有兩個參數，型別檢查即失敗）

- [ ] **Step 3: 實作 cwd.ts**

`src/engine/cwd.ts` 的 import 加入：

```ts
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";
import { evalSubstitutionWord } from "./subst_eval.ts";
```

`applyCd` 改為：

```ts
/**
 * `cd` 之後的新 threaded cwd。無參數（=$HOME）、動態參數、或不可解析的形態 → unknown。
 *
 * 取值順序：
 *   1. 未加引號的 leading tilde → 僅 `~` / `~/<rest>` 形態可展開（需 shellHome）；
 *      混合引號形態（`~/"src"`）與 `~user` / `~+` / `~-` 一律 unknown。
 *   2. `cd -`（回上一個工作目錄）靜態不可知 → unknown。
 *   3. 靜態 token → 直接使用。
 *   4. 單一 `"$(…)"` 且內層可靜態求值 → 用求值結果。
 */
export function applyCd(cmd: Command, cwd: CwdState, shellHome: string | null): CwdState {
  if (cmd.suffix.length === 0) return UNKNOWN; // cd 無參數 = $HOME
  const target = cmd.suffix[0];

  if (hasUnquotedLeadingTilde(target)) {
    const v = staticValue(target);
    if (v === null) return UNKNOWN;
    // parts 非空 = 混合引號形態（如 ~/"src"）：開頭 ~ 會展開、後段是引號內容，
    // 正確模擬需逐 part 重建語義 → 保守放棄。
    if (target.parts && target.parts.length > 0) return UNKNOWN;
    const expanded = expandTilde(v, shellHome);
    if (expanded === null) return UNKNOWN;
    return applyPath(cwd, expanded);
  }

  const val = staticValue(target);
  if (val === "-") return UNKNOWN; // cd - 回上一個工作目錄，靜態不可知
  if (val !== null) return applyPath(cwd, val);

  const evaluated = evalSubstitutionWord(target, cwd, shellHome);
  if (evaluated === null) return UNKNOWN;
  return applyPath(cwd, evaluated);
}
```

- [ ] **Step 4: 更新 walk.ts 的呼叫點**

`src/engine/walk.ts` 需要把 `shellHome` 一路傳到 `applyCd`。`walk` 的簽名加一個選填參數，並在 `walkNode` 之間傳遞：

```ts
export function walk(
  script: Script,
  initialCwd: CwdState,
  root: string,
  shellHome: string | null = null,
): CommandInvocation[] {
```

`walkNode` 同樣加參數，並把 `case "Command"` 內的呼叫改為：

```ts
      if (persistent && isCd(node)) return applyCd(node, cwd, shellHome);
```

> 實作提示：`walkNode` 在檔內有多處遞迴呼叫，逐一補上新參數即可；`deno task check`
> 會指出任何遺漏的呼叫點。

`src/engine/evaluate.ts` 的 `walk` 呼叫改為：

```ts
    const invocations = walk(script, initialCwd, root, shellHome);
```

- [ ] **Step 5: 執行測試確認通過**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: PASS

- [ ] **Step 6: 全量測試與驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

- [ ] **Step 7: 提交**

```bash
git add src/engine/cwd.ts src/engine/cwd_test.ts src/engine/walk.ts src/engine/evaluate.ts
git commit -m "feat(engine): derive cd targets from evaluable substitutions; fix cd - and cd ~"
```

---

### Task 8: base64 規則

**不得併入 `fileReaderRule`。** `base64` 的 `-w`/`--wrap` 吃一個整數值，若加進 `fileReaderRule` 的 `valueFlags`，該設定會套用到該規則的**全部** `names`——而 GNU `md5sum`/`sha256sum` 的 `-w` 是 `--warn`（不吃值）。屆時 `md5sum -c -w /outside/checksums` 的路徑操作元會被當成 value-flag 的值而跳過，在專案內 cwd 下取得 allow，但 md5sum 實際會讀取該外部檔。

**Files:**
- Create: `src/rules/commands/base64.ts`
- Test: `src/rules/commands/base64_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/rules/commands/base64_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { base64Rule } from "./base64.ts";
import { fileReaderRule } from "./coreutils.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("base64: 無操作元讀 stdin → allow", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -d")).kind, "allow");
});

Deno.test("base64: 專案內檔案 → allow", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -d src/a.ts")).kind, "allow");
});

Deno.test("base64: -w 吃值，其值不得被當成路徑", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 --wrap=0 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0")).kind, "allow");
});

Deno.test("base64: 專案外檔案 → ask", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 /etc/passwd")).kind, "ask");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0 /etc/passwd")).kind, "ask");
});

Deno.test("base64: 未知旗標與動態 token → ask", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 -Z src/a.ts")).kind, "ask");
  assertEquals(base64Rule.evaluate(ctxOf("base64 $X")).kind, "ask");
});

Deno.test("迴歸：base64 的 -w arity 不得外溢到 fileReaderRule 其他成員", () => {
  // md5sum 的 -w 是不吃值的 --warn，其後的路徑仍是操作元，必須被範圍檢查擋下
  assertEquals(fileReaderRule.evaluate(ctxOf("md5sum -c -w /outside/checksums")).kind, "ask");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/base64_test.ts`
Expected: FAIL，`Module not found "…/base64.ts"`

- [ ] **Step 3: 實作**

`src/rules/commands/base64.ts`：

```ts
import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";

/**
 * GNU base64（coreutils 8.32）實測旗標：
 *   -d/--decode、-i/--ignore-garbage  不吃值
 *   -w/--wrap                         **吃值**（整數；0 = 不換行）
 * 無任何輸出到檔案的旗標，輸出恆為 stdout；無操作元時讀 stdin；只接受單一 FILE。
 *
 * 刻意獨立於 fileReaderRule：那裡的 valueFlags 會套用到全部 names，而 md5sum /
 * sha256sum 的 -w 是不吃值的 --warn，混用會讓 `md5sum -c -w /outside/checksums`
 * 失去唯一的路徑操作元而誤放行。
 */
const BASE64_SPEC: CommandSpec = {
  flags: [
    ...["-d", "--decode", "-i", "--ignore-garbage"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-w", "--wrap"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
};

export const base64Rule: CommandRule = flagGatedReader({
  names: ["base64"],
  spec: () => BASE64_SPEC,
});
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/base64_test.ts`
Expected: FAIL —— `base64Rule` 尚未註冊到 allowlist 不影響本測試，但若失敗訊息顯示
`lookupRule` 相關錯誤，請確認測試直接呼叫 `base64Rule.evaluate`（不經 allowlist）。

Run 再次: `deno test --allow-env src/rules/commands/base64_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/rules/commands/base64.ts src/rules/commands/base64_test.ts
git commit -m "feat(rules): add standalone base64 rule with its own flag arity"
```

---

### Task 9: test 規則

只允許「單一一元檔案測試運算子 + 一個操作元」形態：argv 恰為 2 個 token。

刻意排除（實測 bash 5.3.9 確認）：

- `-a`：一元時是 `-e` 的舊別名、二元時是邏輯 AND，語義由參數個數決定
- `-o`：一元時測 shell option、二元時是邏輯 OR
- `-t`：操作元是 fd 整數，不是路徑
- `-n`/`-z`（字串）、`-v`/`-R`（變數名）
- 所有二元運算子、邏輯運算子、多運算子組合
- argv 少於或多於 2 個——特別是 `test -f`（單參數時 `-f` 只是非空字串，不是運算子）

`[` 不納入：實測 `[ -f x ]` 的 `CommandInvocation.name` 為 `null`（`[` 是 glob 字元，被 `word.ts` 的詞法 glob 偵測判為動態），`classify` 步驟一會直接 ask，規則永遠不會被呼叫。

**Files:**
- Create: `src/rules/commands/test.ts`
- Test: `src/rules/commands/test_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/rules/commands/test_test.ts`（`ctxOf` 複製自 Task 8 的測試檔，改 import `testRule`）：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { testRule } from "./test.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("test: 一元檔案測試 + 專案內路徑 → allow", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f src/a.ts")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -d src")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -e node_modules/tarn/README.md")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -s src/a.ts")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -L src/a.ts")).kind, "allow");
});

Deno.test("test: 專案外路徑 → ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f /etc/passwd")).kind, "ask");
});

Deno.test("test: 雙重語義的 -a / -o 一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -a src/a.ts")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -o emacs")).kind, "ask");
});

Deno.test("test: 操作元非路徑的運算子一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -t 0")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -n foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -z foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -v HOME")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -R HOME")).kind, "ask");
});

Deno.test("test: 參數個數不是 2 一律 ask", () => {
  // 單參數時 `-f` 只是非空字串，不是運算子
  assertEquals(testRule.evaluate(ctxOf("test -f")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -f src/a.ts -a -f src/b.ts")).kind, "ask");
});

Deno.test("test: 二元與邏輯運算子一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test a = b")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test 1 -eq 2")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test src/a.ts -nt src/b.ts")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test ! -f src/a.ts")).kind, "ask");
});

Deno.test("test: 動態操作元 → ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f $X")).kind, "ask");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/test_test.ts`
Expected: FAIL，`Module not found "…/test.ts"`

- [ ] **Step 3: 實作**

`src/rules/commands/test.ts`：

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 一元**檔案測試**運算子：其操作元是會被讀取 metadata 的檔案路徑。
 *
 * 刻意排除（實測 bash 5.3.9）：
 *   -a  一元時是 -e 的舊別名、二元時是邏輯 AND（語義由參數個數決定）
 *   -o  一元時測 shell option、二元時是邏輯 OR
 *   -t  操作元是 fd 整數，不是路徑
 *   -n -z        操作元是字串
 *   -v -R        操作元是變數名
 */
const FILE_TEST_OPS = new Set([
  "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-L", "-p",
  "-r", "-s", "-S", "-u", "-w", "-x", "-O", "-G", "-N",
]);

/**
 * `test`：只允許「單一一元檔案測試運算子 + 一個操作元」。
 *
 * 參數個數是 POSIX test 的語義關鍵——實測 `test -f` 回 0，因為單參數時 `-f` 只是
 * 「非空字串」而非運算子。故 argv 必須恰為 2 個 token。
 *
 * `[` 不由本規則涵蓋：`[ -f x ]` 的指令名會被 word.ts 的詞法 glob 偵測判為動態
 * （`[` 是 glob 字元），classify 步驟一即回 ask，規則不會被呼叫。
 */
export const testRule: CommandRule = {
  names: ["test"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (ctx.argv.length !== 2) {
      return ask("test：只支援「單一一元檔案測試運算子 + 一個操作元」形態");
    }
    const op = staticValue(ctx.argv[0]);
    if (op === null || !FILE_TEST_OPS.has(op)) {
      return ask("test：運算子未列入一元檔案測試安全集合");
    }
    if (ctx.resolvePath(ctx.argv[1]) !== "in-project") {
      return ask(`test：路徑超出專案範圍或無法靜態解析（${ctx.argv[1].value}）`);
    }
    return allow();
  },
  // 不宣告 cwdIndependent：操作元為相對路徑時依賴 cwd 解析。
};
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/test_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/rules/commands/test.ts src/rules/commands/test_test.ts
git commit -m "feat(rules): add test rule for unary file-test operators"
```

---

### Task 10: cygpath 規則

依「是否查詢檔案系統」分三種形態，三者的操作元處理與 cwd 豁免資格不同。不分類會產生自相矛盾的契約：既宣告 `cwdIndependent`（跳過中央前置規則一）、又聲稱操作元受規則一約束。

- **形態 A（純字串轉換）**：`-u -w -m -t unix|windows|mixed -a -C <cp> -i -U -r -p -h -V` → 操作元不做範圍檢查、宣告 `cwdIndependent`
- **形態 B（查檔案系統 metadata）**：`-d -t dos -s -l -M` → 操作元做 `resolvePath` 範圍檢查、**不**宣告 `cwdIndependent`
- **形態 C（輸出系統目錄）**：`-D -H -O -P -S -W -F <id> -A` → 不吃路徑操作元，allow 且 `cwdIndependent`
- **一律 ask**：`-f`（讀檔取操作元）、`-o`（讀檔取選項）、`-c`（關閉 HANDLE）、任何未知旗標

**Files:**
- Create: `src/rules/commands/cygpath.ts`
- Test: `src/rules/commands/cygpath_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/rules/commands/cygpath_test.ts`（`ctxOf` 複製自 Task 8 的測試檔）：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cygpathRule } from "./cygpath.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("cygpath 形態 A：純字串轉換，操作元不做範圍檢查", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -u /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -m /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t unix /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -p /a:/b")).kind, "allow");
});

Deno.test("cygpath 形態 A：宣告 cwdIndependent", () => {
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -u /outside/x")), true);
});

Deno.test("cygpath 形態 B：查檔案系統，操作元需在專案內", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -d src/a.ts")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -d /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -s /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -l /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -M /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t dos /outside/x")).kind, "ask");
});

Deno.test("cygpath 形態 B：不得宣告 cwdIndependent", () => {
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -d src/a.ts")), false);
});

Deno.test("cygpath 形態 C：輸出系統目錄，無操作元", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -D")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -S")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -F 0")).kind, "allow");
});

Deno.test("cygpath：讀檔旗標與未知旗標 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -f list.txt")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -o opts.txt")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -c 123")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -Z /x")).kind, "ask");
});

Deno.test("cygpath：動態 token → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -u $X")).kind, "ask");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/cygpath_test.ts`
Expected: FAIL，`Module not found "…/cygpath.ts"`

- [ ] **Step 3: 實作**

`src/rules/commands/cygpath.ts`：

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";
import type { Word } from "../../deps.ts";

/** 形態 A：純字串轉換，不碰檔案系統。不吃值者。 */
const SHAPE_A_VALUELESS = new Set(["-u", "-w", "-m", "-a", "-i", "-U", "-r", "-p", "-h", "-V"]);
/** 形態 A：吃值者（-t 的值另外檢查，dos 屬形態 B）。 */
const SHAPE_A_WITH_VALUE = new Set(["-t", "-C"]);
const SAFE_TYPES = new Set(["unix", "windows", "mixed"]);
/** 形態 B：查詢檔案系統 metadata（短名、長名還原、檔案 mode）。 */
const SHAPE_B = new Set(["-d", "-s", "-l", "-M"]);
/** 形態 C：輸出系統目錄，與輸入無關。不吃值者。 */
const SHAPE_C_VALUELESS = new Set(["-D", "-H", "-O", "-P", "-S", "-W", "-A"]);
/** 形態 C：吃值者。 */
const SHAPE_C_WITH_VALUE = new Set(["-F"]);
/** 一律 ask：讀檔取操作元／選項、行程管理。 */
const ASK_FLAGS = new Set(["-f", "-o", "-c"]);

interface Scan {
  /** 出現任何形態 B 旗標（含 -t dos）。 */
  queriesFs: boolean;
  /** 需要 ask 的理由；null 表示通過。 */
  askReason: string | null;
  operands: Word[];
}

/** 單一 memoized 掃描：evaluate 與 cwdIndependent 讀同一份結果。 */
const CACHE = new WeakMap<RuleContext, Scan>();

function scan(ctx: RuleContext): Scan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const result = doScan(ctx);
  CACHE.set(ctx, result);
  return result;
}

function doScan(ctx: RuleContext): Scan {
  let queriesFs = false;
  const operands: Word[] = [];
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) {
      return { queriesFs, askReason: "cygpath：含動態 token，無法靜態判定", operands };
    }
    if (!t.startsWith("-") || t === "-") {
      operands.push(argv[i]);
      continue;
    }
    if (ASK_FLAGS.has(t)) {
      return { queriesFs, askReason: `cygpath：${t} 會從檔案讀取操作元／選項或操作行程`, operands };
    }
    if (SHAPE_B.has(t)) {
      queriesFs = true;
      continue;
    }
    if (SHAPE_A_VALUELESS.has(t) || SHAPE_C_VALUELESS.has(t)) continue;
    if (SHAPE_A_WITH_VALUE.has(t) || SHAPE_C_WITH_VALUE.has(t)) {
      i++;
      if (i >= argv.length) {
        return { queriesFs, askReason: `cygpath：${t} 缺少值`, operands };
      }
      const v = staticValue(argv[i]);
      if (v === null) {
        return { queriesFs, askReason: "cygpath：旗標值為動態 token", operands };
      }
      // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）
      if (t === "-t" && !SAFE_TYPES.has(v)) queriesFs = true;
      continue;
    }
    return { queriesFs, askReason: `cygpath：未列入安全集合的旗標 ${t}`, operands };
  }
  return { queriesFs, askReason: null, operands };
}

/**
 * cygpath：依旗標分三種形態。
 *
 * 形態 A（純字串轉換）不對操作元做範圍檢查——cygpath 在此形態下只轉換路徑字串的書寫
 * 形式，不開檔、不讀內容，也不回報該路徑的任何檔案系統狀態，故不洩漏「使用者自己打進
 * 指令的字串」以外的資訊。
 *
 * 形態 B（`-d`/`-t dos`/`-s`/`-l`/`-M`）會查詢檔案系統 metadata（實測 `cygpath -d`
 * 對不存在路徑 exit 2、`cygpath -w -l '/c/PROGRA~1'` 回 `C:\Program Files`），
 * 屬 `test -e` 同等級的資訊洩漏，故操作元必須做範圍檢查，且不得享有 cwd 豁免。
 */
export const cygpathRule: CommandRule = {
  names: ["cygpath"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const s = scan(ctx);
    if (s.askReason !== null) return ask(s.askReason);
    if (s.queriesFs) {
      for (const op of s.operands) {
        if (ctx.resolvePath(op) !== "in-project") {
          return ask(`cygpath：查詢檔案系統的形態，路徑超出專案範圍（${op.value}）`);
        }
      }
    }
    return allow();
  },
  cwdIndependent(ctx: RuleContext): boolean {
    const s = scan(ctx);
    // 查檔案系統的形態依賴 cwd 解析相對操作元 → 不豁免
    return s.askReason === null && !s.queriesFs;
  },
};
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/cygpath_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/rules/commands/cygpath.ts src/rules/commands/cygpath_test.ts
git commit -m "feat(rules): add cygpath rule with three flag shapes"
```

---

### Task 11: npm 規則

allowlist 的判準是「**不把本機專案內容當成輸出**」。必須先認清一件本工具管不到的事：**所有** npm 呼叫（含 `view`/`ping`/`whoami`）都會在 dispatch 子指令前載入設定，沿目錄樹向上找 local prefix 並讀取該處 `.npmrc`——這無法靠挑選子指令避免，已記在 spec 的已接受限制。

本規則能控制的是另一件事：子指令是否會把探索到的本機專案內容**讀出來當輸出**。實測在兩層深的空目錄中 `npm pkg get name` 印出父層 package.json 的 name、`npm prefix` 印出父層路徑、`npm ls` 印出父層專案——這些一律排除。

**允許的形態：**

- `view`/`info`/`show`/`v` + **至少一個操作元**（無操作元時 npm 改為檢視當前專案）
- `ping`、`whoami`
- 無子指令時僅 `npm --version` / `npm -v`

**操作元必須是 registry package spec**：npm 以 `npm-package-arg` 解析操作元，也接受目錄、檔案、tarball、URL 與 git spec 並實際讀取本機目標。實測 `npm view <含 package.json 的目錄>` 會印出該 package.json 的內容；`npm view archive.tgz` 被當成 `file:archive.tgz`（ENOENT），而 `npm view definitely-not-a-real-pkg-xyz` 才走 registry（E404）。

**Files:**
- Create: `src/rules/commands/npm.ts`
- Test: `src/rules/commands/npm_test.ts`

- [ ] **Step 1: 寫失敗測試**

`src/rules/commands/npm_test.ts`（`ctxOf` 複製自 Task 8 的測試檔）：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { npmRule } from "./npm.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("npm: view 帶 registry package spec → allow", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it version")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view marked")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm info markdown-it@14.3.0")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view @scope/pkg@1.2.3")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --json")).kind, "allow");
});

Deno.test("npm: ping / whoami / --version → allow", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm ping")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm whoami")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm --version")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf("npm -v")).kind, "allow");
});

Deno.test("npm: 無操作元的 view 會檢視當前專案 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view --json")).kind, "ask");
});

Deno.test("npm: 會輸出本機專案內容的子指令 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm ls")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm outdated")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm explain markdown-it")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm root")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm prefix")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm pkg get name")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm config get registry")).kind, "ask");
});

Deno.test("npm: 有副作用的子指令 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm install")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm version 1.2.3")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm docs markdown-it")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm publish")).kind, "ask");
});

Deno.test("npm: 非 registry spec 的操作元 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view /outside/dir")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ./x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ../x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view file:./x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view https://example.com/x.tgz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view C:/x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view ~/x")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view -notaflag")).kind, "ask");
});

Deno.test("npm: 帶 tarball 副檔名的裸名會被當成本地檔 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tgz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tar.gz")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view archive.tar")).kind, "ask");
});

Deno.test("npm: 危險旗標 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --prefix /outside")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --userconfig /outside/.npmrc")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --registry http://evil")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it -g")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it -w ws")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --script-shell /bin/sh")).kind, "ask");
});

Deno.test("npm: 未知旗標與動態 token → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --totally-new-flag")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view $X")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm $SUB markdown-it")).kind, "ask");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/npm_test.ts`
Expected: FAIL，`Module not found "…/npm.ts"`

- [ ] **Step 3: 實作**

`src/rules/commands/npm.ts`：

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 查 registry、不把本機專案內容當成輸出的子指令。
 * 刻意不含 ls/outdated/explain/root/prefix/pkg get/config get——實測它們會沿目錄樹
 * 向上找 package.json 並把父層專案的內容印出來（`npm pkg get name` 印出父層 name、
 * `npm prefix` 印出父層路徑、`npm ls` 印出父層專案），而那個位置可能落在允許範圍外、
 * 且沒有操作元可供本工具檢查。
 */
const VIEW_SUBCOMMANDS = new Set(["view", "info", "show", "v"]);
/** 不吃操作元、也不輸出本機專案內容的子指令。 */
const NO_OPERAND_SUBCOMMANDS = new Set(["ping", "whoami"]);

/** 只影響輸出格式或查詢範圍的旗標（不吃值）。 */
const SAFE_VALUELESS_FLAGS = new Set([
  "--json", "-j", "--long", "-l", "--parseable", "-p",
  "--unicode", "--no-unicode", "--color", "--no-color",
  "--offline", "--prefer-offline", "--prefer-online",
]);
/** 安全且吃值的旗標。 */
const SAFE_VALUE_FLAGS = new Set(["--otp"]);
/** 無子指令時允許的單獨旗標。 */
const VERSION_FLAGS = new Set(["--version", "-v"]);

/**
 * registry package spec 形態。npm 以 npm-package-arg 解析操作元，除 registry spec 外
 * 也接受目錄、檔案、tarball、URL 與 git spec 並實際讀取本機目標——實測
 * `npm view <含 package.json 的目錄>` 會印出該 package.json 的內容。
 *
 * 允許：可選 `@scope/` 前綴 + 套件名 + 可選 `@version|range|tag`。
 * 拒絕：以 . / ~ - 開頭、含 \ 或 :、除 scope 外再含 /、以 tarball 副檔名結尾。
 */
const TARBALL_SUFFIXES = [".tgz", ".tar", ".tar.gz"];

function isRegistrySpec(value: string): boolean {
  if (value === "") return false;
  if (/^[.~/\-]/.test(value)) return false;
  if (value.includes("\\") || value.includes(":")) return false;
  // 實測：裸名帶 tarball 副檔名會被判為本地檔（`npm view archive.tgz` → file:archive.tgz, ENOENT）
  const lower = value.toLowerCase();
  if (TARBALL_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  let rest = value;
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash === -1) return false; // `@foo` 不是合法 scope spec
    const scope = rest.slice(1, slash);
    if (scope === "" || scope.includes("@")) return false;
    rest = rest.slice(slash + 1);
  }
  if (rest === "" || rest.includes("/")) return false;
  // 版本後綴：取第一個 `@` 之前為套件名
  const at = rest.indexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  return name !== "" && !name.startsWith(".");
}

/**
 * npm：子指令 + 操作元雙層 allowlist。
 *
 * 注意本規則**管不到**的事：所有 npm 呼叫都會在 dispatch 子指令前載入設定，沿目錄樹
 * 向上找 local prefix 並讀取該處 `.npmrc`（實測祖先的 `.npmrc` 可重導 logs-dir）。
 * 該限制記在 spec 的「Non-goals / Accepted limitations」，不由本規則處理。
 */
export const npmRule: CommandRule = {
  names: ["npm"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const tokens: string[] = [];
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t === null) return ask("npm：含動態 token，無法靜態判定");
      tokens.push(t);
    }

    let subcommand: string | null = null;
    const operands: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-") && t !== "-") {
        if (VERSION_FLAGS.has(t)) continue;
        const eq = t.indexOf("=");
        const name = eq === -1 ? t : t.slice(0, eq);
        if (SAFE_VALUELESS_FLAGS.has(name)) {
          if (eq !== -1) return ask(`npm：未列入安全集合的旗標形式 ${t}`);
          continue;
        }
        if (SAFE_VALUE_FLAGS.has(name)) {
          if (eq === -1) i++; // 吃掉值
          continue;
        }
        // 未列入安全集合者一律 ask——同時涵蓋 --prefix/--userconfig/--globalconfig/
        // --cache/--script-shell/--node-options/--editor/-g/--global/
        // --foreground-scripts/--registry/-w/--workspace，並免疫 npm 版本漂移
        return ask(`npm：未列入安全集合的旗標 ${name}`);
      }
      if (subcommand === null) subcommand = t;
      else operands.push(t);
    }

    if (subcommand === null) {
      // 無子指令：只有 `npm --version` / `npm -v` 安全
      return tokens.some((t) => VERSION_FLAGS.has(t))
        ? allow()
        : ask("npm：無子指令，只有 --version / -v 可自動放行");
    }

    if (NO_OPERAND_SUBCOMMANDS.has(subcommand)) {
      if (operands.length > 0) return ask(`npm ${subcommand}：不預期的操作元`);
      return allow();
    }

    if (!VIEW_SUBCOMMANDS.has(subcommand)) {
      return ask(`npm：子指令 ${subcommand} 未列入唯讀 allowlist`);
    }

    // 無操作元時 view 會改為檢視「當前專案」，觸發向上探索 → ask
    if (operands.length === 0) {
      return ask("npm view：無操作元時會檢視當前專案（向上探索 package.json）");
    }
    // 第一個操作元是 package spec，其餘是輸出欄位選擇（如 `npm view pkg version`）
    if (!isRegistrySpec(operands[0])) {
      return ask(`npm view：操作元不是 registry package spec（${operands[0]}）`);
    }
    return allow();
  },
  // 不宣告 cwdIndependent：npm 的 effective prefix 由 cwd 決定。
};
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/npm_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint`

```bash
git add src/rules/commands/npm.ts src/rules/commands/npm_test.ts
git commit -m "feat(rules): add npm rule for registry-only read subcommands"
```

---

### Task 12: 註冊、端對端測試、build 與 operational verification

**Files:**
- Modify: `src/rules/allowlist.ts`
- Test: `src/main_test.ts`（追加 e2e）
- Modify: `CLAUDE.md`

- [ ] **Step 1: 註冊四條規則**

`src/rules/allowlist.ts` 加入 import 與陣列成員：

```ts
import { base64Rule } from "./commands/base64.ts";
import { testRule } from "./commands/test.ts";
import { cygpathRule } from "./commands/cygpath.ts";
import { npmRule } from "./commands/npm.ts";
```

在 `RULES` 陣列尾端加入：

```ts
  base64Rule,
  testRule,
  cygpathRule,
  npmRule,
```

- [ ] **Step 2: 執行全量測試，確認沒有重複規則名**

Run: `deno task test`
Expected: PASS。若拋出 `duplicate rule for command: …`，表示該指令名已被既有規則涵蓋，需先移除舊的涵蓋再註冊。

- [ ] **Step 3: 寫 e2e 測試**

追加到 `src/main_test.ts`（沿用該檔既有的子行程執行 helper）：

```ts
Deno.test("e2e: 本次四條真實指令", async () => {
  // gh api … | base64 -d | grep … | head -40 —— base64 不再是卡點
  assertEquals(
    (await runHook("base64 -d src/a.ts | head -40", PROJ)).permissionDecision,
    "allow",
  );
  assertEquals(
    (await runHook("test -f node_modules/tarn/README.md && cat node_modules/tarn/README.md | head -100", PROJ))
      .permissionDecision,
    "allow",
  );
  assertEquals(
    (await runHook("npm view markdown-it version && npm view marked version", PROJ)).permissionDecision,
    "allow",
  );
});

Deno.test("e2e: tilde 漏洞已堵上", async () => {
  assertEquals((await runHook("cat ~/.ssh/id_rsa", PROJ)).permissionDecision, "ask");
  assertEquals((await runHook("grep x ~/secret", PROJ)).permissionDecision, "ask");
  assertEquals((await runHook("test -f ~/secret", PROJ)).permissionDecision, "ask");
  assertEquals((await runHook("base64 ~/secret", PROJ)).permissionDecision, "ask");
});

Deno.test("e2e: 動態 cd 目標不再繞過 cwd 檢查", async () => {
  assertEquals(
    (await runHook('cd "$(uname -a)" && git log --oneline -3', PROJ)).permissionDecision,
    "ask",
  );
});
```

> 註：`runHook` / `PROJ` 請沿用 `src/main_test.ts` 既有的 helper 名稱與簽名；
> 若既有 helper 只接受指令字串，照既有形式呼叫即可。

- [ ] **Step 4: 執行 e2e 測試**

Run: `deno test --allow-run --allow-env --allow-read --allow-write --allow-sys=uid src/main_test.ts`
Expected: PASS

- [ ] **Step 5: 完整驗證與 build**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

Run: `deno task build`
Expected: 產出 `dist/permission-checker.exe`

- [ ] **Step 6: Operational verification（餵真實 JSON 給 binary）**

依 CLAUDE.md 要求，改規則後不要只信單元測試。逐條執行並記錄實際輸出：

```bash
cd /d/claude-code-permission-checker
run() { echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$1},\"cwd\":\"D:/claude-code-permission-checker\"}" \
  | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe; echo; }

# 期望 allow
run '"npm view markdown-it version && npm view marked version"'
run '"test -f deno.json && cat deno.json | head -20"'
run '"base64 -w 0 deno.json"'
run '"cygpath -u \"D:/claude-code-permission-checker\""'

# 期望 ask（安全方向）
run '"cat ~/.ssh/id_rsa"'
run '"npm view /etc"'
run '"npm ls"'
run '"cygpath -d /etc/passwd"'
run '"test -f /etc/passwd"'
```

Expected：前四條 `permissionDecision: "allow"`、後五條 `"ask"`，且**全部 exit 0**。

> ⚠️ 若某條 builtin 應為 ask 的指令回了 allow 且 reason 提到「命中 permissions.allow」，
> 那是 settings.json 的合法升級、不是 bug（見 CLAUDE.md 的說明）。但若回 allow 的是
> **寫入重導向／賦值前綴／範圍外 `<`／cwd 超範圍**，那就是 regression，必須修。

- [ ] **Step 7: 更新 CLAUDE.md**

在 CLAUDE.md 中同步下列四處（維持既有文件風格與語氣）：

1. 「架構（評估管線）」的 `walk.ts` 段落：補上 `applyCd` 會先試 `staticValue`、再試
   `subst_eval.ts` 的求值框架，以及 `cd -` / `cd ~` 的語義。
2. 新增 `src/engine/tilde.ts` 與 `src/engine/subst_eval.ts` 的職責說明。
3. 「四條中央前置規則」的規則一：補上 `cwd.kind === "unknown"` 也 ask，並說明初始 cwd 恆為 known。
4. 「⚠️ 不要再犯的問題」新增一則：`resolvePath` 對未加引號的 leading tilde 必須先展開
   （shell home 用 `HOME`，不可用 `resolveHome`——後者在 Windows 優先 `USERPROFILE`），
   `resolvePathValue` 對以 `~` 開頭的字串 fail-closed。

同時在 `rules/` 段落補上新增的四條規則檔。

- [ ] **Step 8: 最終提交**

```bash
git add src/rules/allowlist.ts src/main_test.ts CLAUDE.md
git commit -m "feat(rules): register base64/test/cygpath/npm rules and sync docs"
```

---

## 完成標準

- `deno task check && deno task lint && deno task test` 全綠
- `deno task build` 成功，且 Task 12 Step 6 的九條 operational verification 結果符合預期
- `cat ~/.ssh/id_rsa` 回 `ask`（本次修掉的既有漏洞）
- `npm view markdown-it version`、`test -f <專案內檔>`、`base64 -w 0 <專案內檔>`、
  `cygpath -u '<專案路徑>'` 回 `allow`
- 所有 hook 輸出 **exit 0**
