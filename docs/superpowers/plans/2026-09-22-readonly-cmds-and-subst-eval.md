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

Deno.test("shell home 與 settings home 分離：授權的是 settings home 時，指令的 ~ 仍以 HOME 展開", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  // Read(~/cache/**) 由 settings home 解析 → 授權的是 /settings-home/cache
  const scope: ScopeConfig = {
    ...rootScope("/proj"),
    home: "/settings-home",
    shellHome: "/bash-home",
    allow: { roots: ["/settings-home/cache"], files: [] },
  };
  // 但指令中的 ~/cache/x 依 bash 語義展開為 /bash-home/cache/x —— 未被授權
  assertEquals(resolvePath(wordOf("cat ~/cache/x"), cwd, scope), "out-of-project");
});

Deno.test("shell home 展開後命中 allow 範圍 → in-project", () => {
  const cwd: CwdState = { kind: "known", path: "/proj" };
  const scope: ScopeConfig = {
    ...rootScope("/proj"),
    home: "/bash-home",
    shellHome: "/bash-home",
    allow: { roots: ["/bash-home/cache"], files: [] },
  };
  assertEquals(resolvePath(wordOf("cat ~/cache/x"), cwd, scope), "in-project");
});
```

> 這兩個測試需要 `ScopeConfig` 型別；若該測試檔尚未 import，請一併補上
> `import type { ScopeConfig } from "./scope.ts";`。

在該檔案上方（既有 helper 附近）加入 import 與 helper。注意 `resolvePath` / `resolvePathValue`
可能尚未被該測試檔 import，一併補上：

```ts
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { resolvePath, resolvePathValue } from "./scope.ts";

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

把原本 `resolvePathValue` 的本體抽成一個**不含 tilde 判斷**的內部函式，讓兩個公開入口各自套用
自己的 tilde 語義。這是必要的：`resolvePath` 對引號形態（`cat "~/secret"`）拿到的
`staticValue` 是 `"~/secret"`——引號資訊已被抹除——若直接轉呼叫帶字串 tilde 檢查的
`resolvePathValue`，會把**應該維持相對語義**的引號形態也擋成 `out-of-project`。

```ts
/** 絕對／相對路徑的範圍判定本體；呼叫端負責先處理 tilde 語義。 */
function resolveResolvedValue(value: string, cwd: CwdState, scope: ScopeConfig): PathScope {
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}

/**
 * 對「已取得的字串路徑值」做範圍檢查（三態）。
 *
 * 字串值沒有 word 結構，無從判斷開頭的 `~` 是否被引號保護：未加引號時 bash 展開為 $HOME
 * （專案外），加引號時是 `./~`（專案內）。無法區分就取安全的一邊 → fail-closed。
 * 代價是 `--flag="~/x"` 這類引號形態會被誤 ask；此形態罕見，方向安全。
 */
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  if (value.startsWith("~")) return "out-of-project";
  return resolveResolvedValue(value, cwd, scope);
}

/**
 * 解析單一參數對專案根的範圍（三態）。
 *
 * 有 word 結構可用，因此能精確區分兩種 tilde：
 *   未加引號（`~/x`、`~/"x"`）→ bash 會展開 → 以 shellHome 展開後判定，不可解析則超出範圍
 *   引號包裝（`"~/x"`）      → bash 不展開，指向 `./~/x` → 走一般相對路徑語義（維持既有行為）
 */
export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  const v = staticValue(arg);
  if (v === null) return "dynamic";
  if (hasUnquotedLeadingTilde(arg)) {
    const expanded = expandTilde(v, scope.shellHome);
    // 不支援的 tilde 形態（~user / ~+ / ~-）或 shellHome 未知 → 絕不退回相對路徑語義，
    // 那正是本次要修的漏洞（`cat ~/.ssh/id_rsa` 被判成 <project>/~/.ssh/id_rsa）。
    if (expanded === null) return "out-of-project";
    return resolveResolvedValue(expanded, cwd, scope);
  }
  // 引號形態的 `~` 走到這裡：不經 resolvePathValue 的字串 tilde 檢查，維持相對語義。
  return resolveResolvedValue(v, cwd, scope);
}
```

同時更新 `src/engine/scope_test.ts:115` 既有的 `scopeWith` helper——`shellHome` 是必要欄位，
不補會讓型別檢查失敗。**只加一行 `shellHome: null`**，其餘（四個參數、`/proj` 根、
`allowFiles`）完全保留：

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
    shellHome: null,
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
    trusted: [],
  };
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
Expected: PASS。

既有測試若失敗，只有兩種合法情形，其餘一律視為本次改動的 bug：

1. **斷言「未加引號的 `~/…` 路徑 allow / in-project」** → 那正是本次要修掉的錯誤行為。把期望改成
   `ask` / `out-of-project`，並在測試名稱補上「（tilde 展開後在專案外）」。
2. **`ScopeConfig` 物件字面缺 `shellHome`** → 補上 `shellHome: null`，或改成展開 `rootScope(...)`。

**不可**修改的既有斷言：引號形態（`"~/x"`）維持 in-project、`dangerousRoot` 對字面 `~` / `~/`
的既有判定。這兩者本次行為不變，若它們失敗代表實作有誤。

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

追加到 `src/engine/classify_test.ts`。該檔已有 `rulesOf({ allow: [...] })` helper（`classify_test.ts:15`，
接受 `Bash(...)` 形式的字串）以及既有的 invocation 建構方式——直接沿用，不要自行拼 `PermissionRules`。

`cat` 與 `git log` 在 known 且在範圍內的 cwd 下本來就 allow，正好當對照組；**不要用裸 `git`**，
`gitRule` 對無子指令的 `git` 本就回 ask，那樣測不到新守衛。

```ts
Deno.test("central rule 1: cwd known 且在範圍內 → 維持 allow（對照組）", () => {
  const inv: CommandInvocation = {
    name: "git",
    argv: [wordOfArg("log")],
    assignments: [],
    redirects: [],
    cwd: { kind: "known", path: "/proj" },
  };
  assertEquals(classify(inv, "/proj").kind, "allow");
});

Deno.test("central rule 1: cwd unknown → ask", () => {
  const inv: CommandInvocation = {
    name: "git",
    argv: [wordOfArg("log")],
    assignments: [],
    redirects: [],
    cwd: { kind: "unknown" },
  };
  assertEquals(classify(inv, "/proj").kind, "ask");
});

Deno.test("central rule 1: cwd unknown 不可由 permissions.allow 升級", () => {
  const inv: CommandInvocation = {
    name: "git",
    argv: [wordOfArg("log")],
    assignments: [],
    redirects: [],
    cwd: { kind: "unknown" },
  };
  assertEquals(classify(inv, "/proj", rulesOf({ allow: ["Bash(git *)"] })).kind, "ask");
});

Deno.test("central rule 1: cwdIndependent 的指令在 unknown cwd 下也不得豁免", () => {
  // gh api 有宣告 cwdIndependent，但五道護欄的第 (2) 條要求 cwd 為 known 且 origin 為 chain-cd
  const inv: CommandInvocation = {
    name: "gh",
    argv: [wordOfArg("api"), wordOfArg("repos/o/r")],
    assignments: [],
    redirects: [],
    cwd: { kind: "unknown" },
  };
  assertEquals(classify(inv, "/proj", undefined, null, [], true).kind, "ask");
});
```

在該檔 helper 區加入：

```ts
/** 由單一 token 建出 argv 用的 Word。 */
function wordOfArg(token: string): Word {
  const cmd = parse(`x ${token}`).commands[0].command as Command;
  return cmd.suffix[0];
}
```

並在檔首補上這些 import（該測試檔目前沒有它們，缺了無法編譯）：

```ts
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import type { CommandInvocation } from "../types.ts";
```

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
Expected: PASS。

既有測試若失敗，唯一合法情形是「斷言 unknown cwd 下的指令 allow」——那正是本次要堵的繞道，
改為 `ask` 並在測試名稱補上「（unknown cwd 不再放行）」。其餘失敗一律視為實作有誤。

**注意**：Task 7 之後會有「可求值 substitution 推導出 known cwd」的正面案例，那些是 `known`
不是 `unknown`，不受本守衛影響；不要因為本 Task 而把它們一併改成 ask。

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
  assertEquals(evalSubstitutionWord(wordOf('cd "$(uname -a)"'), CWD), null);
});

Deno.test("framework: 未加引號的 substitution 一律不求值", () => {
  // bash 對未加引號的展開做 word splitting 與空值移除，語義與單一字串不同
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo foo)"), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo -n)"), CWD), null);
});

Deno.test("framework: 混合 word 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo foo)/sub"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "pre$(echo foo)"'), CWD), null);
});

Deno.test("framework: 內層有 pipeline / 多 statement / 重導向 / 賦值前綴皆不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a | tr a b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a; echo b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a > /tmp/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(FOO=1 echo a)"'), CWD), null);
});

Deno.test("framework: 動態 argv 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo $X)"'), CWD), null);
});

Deno.test("framework: argv 含未加引號 tilde 不求值", () => {
  // 外層 substitution 的雙引號不會抑制內層的 tilde expansion
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/"src")"'), CWD), null);
});

Deno.test("framework: 非 substitution 的 word 回 null", () => {
  assertEquals(evalSubstitutionWord(wordOf("cd /proj/src"), CWD), null);
});
```

```ts
Deno.test("framework: 結果過濾述詞", () => {
  // 現有求值器本身都不產生換行，故直接對述詞斷言，確保這兩條過濾規則有被執行到
  assertEquals(resultIsUsable("/proj/src"), true);
  assertEquals(resultIsUsable(""), false);
  assertEquals(resultIsUsable("a\nb"), false);
  assertEquals(resultIsUsable("a\r\nb"), false);
});
```

該測試需要 `import { evalSubstitutionWord, resultIsUsable } from "./subst_eval.ts";`。

> 「加引號但求值為空字串」與「內層加引號的字面 `~` 可求值」兩個案例需要已註冊的求值器，
> 放在下一個 Task 一併加入，讓本 Task 能獨立通過驗證。

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
   * @param cwd  該指令執行時的 cwd（unknown 時需要 cwd 的求值器應回 null）
   */
  evaluate(argv: string[], cwd: CwdState): string | null;
}

/** 已註冊的求值器。指令名重複註冊會在載入時丟錯。 */
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
export function evalSubstitutionWord(word: Word, cwd: CwdState): string | null {
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
  const out = evaluator.evaluate(argv, cwd);
  if (out === null) return null;
  return resultIsUsable(out) ? out : null;
}

/**
 * 求值結果是否可用。
 * 空字串沒有安全的解釋（bash 語義依引號與否而異：加引號是 cd 到空字串、未加引號是 cd 到 $HOME）；
 * 含換行的多行輸出作為 cd 目標無意義。兩者一律放棄。
 */
export function resultIsUsable(out: string): boolean {
  if (out === "") return false;
  return !out.includes("\n") && !out.includes("\r");
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/subst_eval_test.ts`
Expected: PASS。所有負面案例在空註冊表下本來就該回 `null`，`resultIsUsable` 的斷言也不依賴
任何求值器。

- [ ] **Step 5: 驗證與提交**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

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
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b/)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a//b)"'), CWD), "/a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname a)"'), CWD), ".");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname ./a)"'), CWD), ".");
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(dirname '')"`), CWD), ".");
});

Deno.test("dirname: 多操作元與旗標不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname /a/b /c/d)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname -z /a/b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(dirname)"'), CWD), null);
});

Deno.test("basename: 邊界語義與後綴", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b/)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename a)"'), CWD), "a");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /)"'), CWD), "/");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b.txt .txt)"'), CWD), "b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -s .txt /a/b.txt)"'), CWD), "b");
});

Deno.test("basename: -a / -z / 操作元過多不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -a /a/b /c/d)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename -z /a/b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(basename /a/b .b extra)"'), CWD), null);
});

Deno.test("pwd: 回當前 cwd；帶旗標或 cwd unknown 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), CWD), "/proj");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd -P)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(pwd)"'), { kind: "unknown" }), null);
});

Deno.test("echo: 無旗標或僅 -n、操作元不含反斜線才求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo /a/b)"'), CWD), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -n /a/b)"'), CWD), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a b)"'), CWD), "a b");
});

Deno.test("echo: -e 與含反斜線的操作元不求值", () => {
  // xpg_echo shopt 為 on 時 bash 預設就解釋反斜線，該狀態靜態不可知
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo -e /a/b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(echo '/a\tb')"`), CWD), null);
});

Deno.test("printf: 只求值 '%s' 單一操作元與無 % 無反斜線的純字面", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' /a/b)"`), CWD), "/a/b");
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf /a/b)"`), CWD), "/a/b");
});

Deno.test("framework: 加引號但求值為空字串 → null", () => {
  // 與未加引號的 `cd $(echo -n)` 不同：這個通過了引號檢查，真正測到空結果過濾
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo -n)"'), CWD), null);
});

Deno.test("framework: 內層加引號的字面 ~ 可求值（引號抑制展開）", () => {
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(echo '~')"`), CWD), "~");
});

Deno.test("dirname / basename: 含反斜線的操作元不求值", () => {
  // GNU coreutils 在 Windows / Cygwin 上也把 `\` 當分隔符，本實作只處理 `/`；
  // 與其算錯，不如放棄（算錯會讓 Task 7 拿到錯誤的 known cwd）
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(dirname 'C:\Windows\System32')"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(basename 'C:\Windows\System32')"`), CWD), null);
});

Deno.test("printf: 其餘形態不求值", () => {
  // 格式字串永遠解釋反斜線，即使不含 %
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '/a\tb')"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(printf '%s\n' /a/b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%s' a b)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf '%b' a)"`), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf(`cd "$(printf -v x '%s' a)"`), CWD), null);
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

/**
 * 本實作只處理 `/` 分隔符。GNU coreutils 在 Windows / Cygwin 上也把 `\` 當分隔符
 * （`dirname 'C:\Windows\System32'` → `C:\Windows`），照 `/`-only 邏輯會算成 `.`——
 * 那個錯誤結果會被當成 known cwd 用於後續範圍判定，故含 `\` 的操作元一律放棄求值。
 */
function hasBackslash(value: string): boolean {
  return value.includes("\\");
}

const dirnameEvaluator: SubstEvaluator = {
  names: ["dirname"],
  evaluate(argv) {
    // 旗標（含 -z/--zero）與多操作元一律放棄：-z 改用 NUL 分隔、多操作元逐行輸出
    if (argv.length !== 1) return null;
    if (argv[0].startsWith("-")) return null;
    if (hasBackslash(argv[0])) return null;
    return dirnameOf(argv[0]);
  },
};

const basenameEvaluator: SubstEvaluator = {
  names: ["basename"],
  evaluate(argv) {
    if (argv.some(hasBackslash)) return null;
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
      // 任一以 `-` 開頭的操作元一律放棄。這比必要的更嚴——`--` 在 echo 不是選項終止符
      // （實測 `echo -- foo` 印出 `-- foo`），照理可以求值——但把「是旗標」與「長得像旗標的
      // 操作元」分開處理沒有實際需求，而多問一次是安全方向。
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

可求值旗標（實測 cygpath 3.6.7 確認輸出完全由輸入字串決定）：`-u`、`-w`、`-m`、`-t unix|windows|mixed`、`-a`、`-C <cp>`、`-i`。

**但「回操作元原樣」只對磁碟形式路徑成立。** cygpath 會套用 MSYS2 的 mount 表，把虛擬路徑對映到
實際安裝位置——實測：

```
cygpath -m /d/proj        → D:/proj                          （磁碟形式，等價）
cygpath -u 'D:/proj'      → /d/proj                          （磁碟形式，等價）
cygpath -m /mingw64/bin   → C:/Program Files/Git/mingw64/bin  （mount 對映，**不等價**）
cygpath -m /usr/bin       → C:/Program Files/Git/usr/bin      （mount 對映，**不等價**）
```

`normalizeAbsolute` 只做磁碟機正規化（`/d/x` ↔ `D:/x`），不懂 mount 表。若對 `/usr/bin` 回原樣，
後續範圍檢查會用錯誤的 cwd。因此**操作元必須是下列形態之一，否則回 `null`**：

- Windows 磁碟絕對路徑：`X:/…` 或 `X:\…`
- MSYS 磁碟形式絕對路徑：`/x/…` 或 `/x`（頂層段恰為單一字母）
- 相對路徑（不以 `/` 開頭；實測 `cygpath -u 'relative/path'` → `relative/path` 不變）

其餘以 `/` 開頭的絕對路徑（`/usr`、`/mingw64`、`/tmp`、`/proc/…`）一律不可求值。

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
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t unix 'D:/proj')"`), CWD), "D:/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath 'D:/proj')"`), CWD), "D:/proj");
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 查檔案系統的旗標不求值",
  fn() {
    // -d / -t dos / -s 都是 DOS 8.3 短名，-l 是長名還原，皆需查檔案系統
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -d 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -t dos 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -s 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -l 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -M 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 系統目錄旗標與讀檔旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -D)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -S)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -f list.txt)"`), CWD), null);
    // 輸出形式與 normalizeAbsolute 不保證等價
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -U 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w -r /d/proj)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -p /a:/b)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: -a 需要 known cwd；操作元必須恰一個",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), CWD), "sub");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -a sub)"`), { kind: "unknown" }), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u a b)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 只有磁碟形式與相對路徑可求值（mount 對映不等價）",
  fn() {
    // 磁碟形式：normalizeAbsolute 認得，等價
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -w 'C:\\proj')"`), CWD), "C:\\proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u sub/dir)"`), CWD), "sub/dir");
    // 非磁碟形式的絕對路徑由 MSYS2 mount 表決定實際位置
    // （實測 cygpath -m /usr/bin → C:/Program Files/Git/usr/bin）
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /usr/bin)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /mingw64/bin)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u /tmp)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: -C / -i 可求值；吃值旗標缺值或值無效 → null",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -C UTF8 -m /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -i -u /d/proj)"`), CWD), "/d/proj");
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj -C)"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m /d/proj -t)"`), CWD), null);
    // cygpath 會拒絕無效的 codepage，不會輸出路徑
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -C bogus -m /d/proj)"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 互斥的輸出格式旗標 → null",
  fn() {
    // cygpath 會拒絕執行，不輸出任何路徑；照樣回傳操作元等於憑空造出 cd 目標
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u -w 'D:/proj')"`), CWD), null);
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -m -t unix 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 反斜線開頭的路徑 → null",
  fn() {
    // `\d\proj` 在 Windows 是「當前磁碟機根」的絕對路徑，但 applyPath 會當成相對路徑
    assertEquals(evalSubstitutionWord(wordOf(String.raw`cd "$(cygpath -u '\d\proj')"`), CWD), null);
  },
});

Deno.test({
  ...WIN_ONLY,
  name: "cygpath: 未知旗標不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -Z 'D:/proj')"`), CWD), null);
  },
});

Deno.test({
  ignore: Deno.build.os === "windows",
  name: "cygpath: 非 Windows 平台一律不求值",
  fn() {
    assertEquals(evalSubstitutionWord(wordOf(`cd "$(cygpath -u 'D:/proj')"`), CWD), null);
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

/** 互斥的輸出格式旗標：同時給多個時 cygpath 會拒絕執行，不會輸出任何路徑。 */
const CYGPATH_OUTPUT_MODES = new Set(["-u", "-w", "-m", "-t"]);
/** -C 接受的 codepage 值（其餘值 cygpath 會報錯）。 */
const CYGPATH_CODEPAGES = new Set(["ANSI", "OEM", "UTF8"]);

const cygpathEvaluator: SubstEvaluator = {
  names: ["cygpath"],
  evaluate(argv, cwd) {
    // cygpath 只存在於 Cygwin/MSYS2；求值所依賴的「/d/x ≡ D:/x」也只在 Windows 成立
    // （normalizeAbsolute 的磁碟機正規化以 Deno.build.os 鎖定）。
    if (Deno.build.os !== "windows") return null;

    let needsKnownCwd = false;
    let outputModes = 0;
    const operands: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (!t.startsWith("-")) {
        operands.push(t);
        continue;
      }
      if (CYGPATH_OUTPUT_MODES.has(t)) outputModes++;
      if (CYGPATH_VALUELESS.has(t)) {
        if (t === "-a") needsKnownCwd = true; // 相對路徑以行程 cwd 展開
        continue;
      }
      if (CYGPATH_WITH_VALUE.has(t)) {
        i++;
        if (i >= argv.length) return null;
        // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）；未知類型 cygpath 會報錯
        if (t === "-t" && !CYGPATH_SAFE_TYPES.has(argv[i])) return null;
        // -C 的值必須是 cygpath 認得的 codepage，否則它會報錯而非輸出路徑
        if (t === "-C" && !CYGPATH_CODEPAGES.has(argv[i].toUpperCase())) return null;
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
    // 輸出格式旗標互斥：`cygpath -u -w x` 會被 cygpath 拒絕、不輸出路徑，
    // 若這裡照樣回傳操作元，等於憑空造出一個並不存在的 cd 目標。
    if (outputModes > 1) return null;
    // 只有磁碟形式與相對路徑可回原樣：-u/-w/-m 對它們只改變磁碟機與斜線的書寫形式，
    // 而呼叫端的 applyPath 隨即 normalizeAbsolute，D:/x、D:\x、/d/x 會正規化成同一字串。
    // 其餘絕對路徑會經 MSYS2 mount 表對映（實測 `cygpath -m /usr/bin` →
    // `C:/Program Files/Git/usr/bin`），normalizeAbsolute 不懂 mount 表 → 必須放棄。
    if (!isNormalizationEquivalent(operands[0])) return null;
    return operands[0];
  },
};

/**
 * 該路徑經 cygpath 轉換後，是否與 normalizeAbsolute 的語義等價。
 * 成立的三種形態：Windows 磁碟絕對（X:/ 或 X:\）、MSYS 磁碟形式（/x 或 /x/…）、相對路徑。
 * 其餘以 `/` 開頭者由 MSYS2 mount 表決定實際位置，不等價。
 */
function isNormalizationEquivalent(p: string): boolean {
  if (/^[A-Za-z]:[/\\]/.test(p)) return true; // X:/… 或 X:\…
  // 反斜線開頭（`\d\proj`）在 Windows 是「當前磁碟機根」的絕對路徑，但 applyPath 會把它
  // 當成相對路徑接到 cwd 之後 → 兩者指向不同目錄，不可求值。
  if (p.startsWith("\\")) return false;
  if (!p.startsWith("/")) return true; // 相對路徑
  return /^\/[A-Za-z](\/|$)/.test(p); // /x 或 /x/…
}
```

把 `cygpathEvaluator` 加進 `EVALUATORS`（**保留前一個 Task 註冊的五個成員**，並確保
`cygpathEvaluator` 的 `const` 宣告位於 `EVALUATORS` 初始化之前）：

```ts
const EVALUATORS: SubstEvaluator[] = [
  dirnameEvaluator,
  basenameEvaluator,
  pwdEvaluator,
  echoEvaluator,
  printfEvaluator,
  cygpathEvaluator,
];
```

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

`applyCd` 需要 bash 的 `$HOME` 才能展開 `cd ~`，但它被 `walk` 的遍歷深處呼叫
（`walkNode` 內約 15 處遞迴、`walkSequence` 約 12 處），逐層加參數會污染整條簽名。
改為**在 `walk` 的單一入口設定一個模組級值**：`walk()` 進入時寫入、`finally` 清除，
`walkNode` 的 cd 分支直接讀取。`walk` 是同步、非重入（內部不會再呼叫 `walk`）、
單一執行緒，因此這個值在一次遍歷內恆定且不會外洩。

`applyCd` 的第三個參數為**選填、預設 `null`**，因此 `src/engine/print_only.ts:230` 的
既有兩參數呼叫與既有測試都不需改動——該路徑拿不到 shell home，tilde 形態會回 `UNKNOWN`，
方向保守。

**Files:**
- Modify: `src/engine/cwd.ts`（`applyCd`）
- Modify: `src/engine/walk.ts`（`walk` 入口設定 shell home；cd 分支傳入）
- Modify: `src/engine/evaluate.ts`（把 `shellHome` 傳給 `walk`）
- Test: `src/engine/cwd_test.ts`（追加）

- [ ] **Step 1: 寫失敗測試**

追加到 `src/engine/cwd_test.ts`（沿用該檔既有的 `cmdOf` helper）：

```ts
Deno.test("applyCd: cd - 靜態不可知 → unknown", () => {
  assertEquals(applyCd(cmdOf("cd -"), { kind: "known", path: "/proj" }).kind, "unknown");
});

Deno.test("applyCd: cd ~ / cd ~/x 以 shell home 展開", () => {
  assertEquals(
    applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }, "/home/u"),
    { kind: "known", path: "/home/u", origin: "chain-cd" },
  );
  assertEquals(
    applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "/home/u"),
    { kind: "known", path: "/home/u/src", origin: "chain-cd" },
  );
});

Deno.test("applyCd: home 在專案內時展開結果仍在專案內", () => {
  assertEquals(
    applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "/proj/home"),
    { kind: "known", path: "/proj/home/src", origin: "chain-cd" },
  );
});

Deno.test("applyCd: shell home 未知 → unknown", () => {
  assertEquals(applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, null).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "   ").kind, "unknown");
});

Deno.test("applyCd: 不支援的 tilde 形態即使 home 已知也 unknown", () => {
  assertEquals(applyCd(cmdOf("cd ~user/x"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~+"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~-"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
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
  const r = applyCd(cmdOf('cd "$(dirname /proj/src/a.ts)"'), { kind: "known", path: "/proj" });
  assertEquals(r, { kind: "known", path: "/proj/src", origin: "chain-cd" });
});

Deno.test("applyCd: 不可求值的 substitution 仍為 unknown", () => {
  assertEquals(applyCd(cmdOf('cd "$(uname -a)"'), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd $(dirname /a/b)"), { kind: "known", path: "/proj" }).kind, "unknown");
});

Deno.test("applyCd: 求值結果為 - 時也要擋下", () => {
  // basename ./- → "-"；bash 會把它當成 cd -（回上一個工作目錄），不是相對路徑 "./-"
  assertEquals(applyCd(cmdOf(`cd "$(basename ./-)"`), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf(`cd "$(printf '%s' -)"`), { kind: "known", path: "/proj" }).kind, "unknown");
  // 求值出的字面 ~ 由 bash 視為普通字元（tilde expansion 早於 substitution），故維持相對語義
  const r = applyCd(cmdOf(`cd "$(echo '~')"`), { kind: "known", path: "/proj" });
  assertEquals(r, { kind: "known", path: "/proj/~", origin: "chain-cd" });
});

Deno.test({
  ignore: Deno.build.os !== "windows",
  name: "applyCd: cygpath 推導出專案內 cwd（本次的主要需求）",
  fn() {
    const r = applyCd(cmdOf(`cd "$(cygpath -u 'D:/proj/src')"`), { kind: "known", path: "D:/proj" });
    assertEquals(r, { kind: "known", path: "D:/proj/src", origin: "chain-cd" });
  },
});

Deno.test("walk: shell home 傳達到巢狀結構中的 cd ~", () => {
  const { script } = parseCommand("{ cd ~/src && cat a.ts; }");
  const invs = walk(script, { kind: "known", path: "/proj" }, "/proj", "/home/u");
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/home/u/src", origin: "chain-cd" });
});
```

> 最後一個測試需要 `import { walk } from "./walk.ts";` 與 `import { parseCommand } from "./parse.ts";`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: FAIL。`cd -` 目前被當成相對路徑接成 `/proj/-`、`cd ~` 接成 `/proj/~`，
substitution 形態則全部回 unknown，`walk` 也還不接受第四個參數。

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
 *   1. 未加引號的 leading tilde → 僅 `~` / `~/<rest>` 且 shellHome 已知時展開；
 *      混合引號形態（`~/"src"`）與 `~user` / `~+` / `~-` 一律 unknown。
 *      引號包裝的 `"~"` 不命中述詞，走步驟 3 的相對語義——那對它是正確的。
 *   2. 靜態 token → 直接使用。
 *   3. 單一 `"$(…)"` 且內層可靜態求值 → 用求值結果。
 * 步驟 2 與 3 取得的值都要再經 `applyTarget` 過濾 `-`。
 *
 * `shellHome` 選填：未提供時 tilde 形態一律 unknown（fail-safe）。
 */
export function applyCd(cmd: Command, cwd: CwdState, shellHome: string | null = null): CwdState {
  if (cmd.suffix.length === 0) return UNKNOWN; // cd 無參數 = $HOME
  const target = cmd.suffix[0];

  if (hasUnquotedLeadingTilde(target)) {
    const v = staticValue(target);
    if (v === null) return UNKNOWN;
    // parts 非空 = 混合引號形態（如 ~/"src"）：開頭 ~ 會展開、後段是引號內容，
    // 正確模擬需逐 part 重建語義 → 保守放棄。
    if (target.parts && target.parts.length > 0) return UNKNOWN;
    const expanded = expandTilde(v, shellHome);
    if (expanded === null) return UNKNOWN; // ~user / ~+ / ~- 或 home 未知
    return applyPath(cwd, expanded);
  }

  const val = staticValue(target);
  if (val !== null) return applyTarget(cwd, val);

  const evaluated = evalSubstitutionWord(target, cwd);
  if (evaluated === null) return UNKNOWN;
  return applyTarget(cwd, evaluated);
}

/**
 * 把已取得的 cd 目標字串接上 cwd。`-` 必須在這裡擋，而不是只擋原始 token——
 * 求值結果同樣可能是 `-`（`basename ./-`、`printf '%s' -`），而 bash 對 `cd -` 的解讀
 * 是「回上一個工作目錄」，不是相對路徑 `./-`。
 */
function applyTarget(cwd: CwdState, value: string): CwdState {
  if (value === "-") return UNKNOWN;
  return applyPath(cwd, value);
}
```

> 求值出的字面 `~`（`cd "$(echo '~')"`）**不**需要擋：bash 的 tilde expansion 早於
> command substitution，展開結果中的 `~` 只是普通字元，相對語義 `<cwd>/~` 是正確的。

- [ ] **Step 4: 讓 shell home 到達 walk 深處的 applyCd**

`src/engine/walk.ts`：`walk` 加第四個選填參數，在入口寫入模組級值、`finally` 清除，
`walkNode` 的 cd 分支讀取它。**不動 `walkSequence` / `walkNode` 的簽名**。

```ts
/**
 * 本次遍歷的 bash home（`$HOME`），供 `applyCd` 展開 `cd ~`。
 * 由 `walk` 在入口設定、finally 清除。`walk` 是同步、非重入、單執行緒，
 * 故此值在一次遍歷內恆定，也不會外洩到下一次呼叫。
 */
let walkShellHome: string | null = null;

export function walk(
  script: Script,
  startCwd: CwdState,
  _root: string,
  shellHome: string | null = null,
): CommandInvocation[] {
  walkShellHome = shellHome;
  try {
    const out: CommandInvocation[] = [];
    walkSequence(script.commands, startCwd, out, [], true);
    return out;
  } finally {
    walkShellHome = null;
  }
}
```

> 上面的函式主體請沿用該檔既有的內容（目前是建立 `out`、呼叫 `walkSequence`、回傳 `out`），
> 只包上 `walkShellHome` 的設定與清除。

`walkNode` 的 `case "Command"` 分支改為：

```ts
      if (persistent && isCd(node)) return applyCd(node, cwd, walkShellHome);
```

`src/engine/evaluate.ts` 的 `walk` 呼叫改為：

```ts
    const invocations = walk(script, initialCwd, root, shellHome);
```

`src/engine/print_only.ts:230` **維持現狀不改**（兩參數呼叫）：該路徑取不到 shell home，
tilde 形態會得到 `UNKNOWN`，方向保守。

- [ ] **Step 5: 執行測試確認通過**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: PASS

- [ ] **Step 6: 全量測試與驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠。

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
  // 關鍵斷言：`0` 若被誤當成路徑操作元，它本身會解析成專案內的 /proj/0 而測不出錯。
  // 改用一個「當成路徑就會超出範圍」的值，才真正釘住 -w 吃值這件事。
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w /etc/passwd src/a.ts")).kind, "allow");
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
Expected: PASS（測試直接呼叫 `base64Rule.evaluate`，不經 allowlist，故不需先註冊）

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

Deno.test("test: tilde 操作元依引號與否分流", () => {
  // 未加引號 → bash 展開為 $HOME（專案外）。ctxOf 的 rootScope 未設 shellHome → 不可解析 → ask
  assertEquals(testRule.evaluate(ctxOf("test -f ~/secret")).kind, "ask");
  // 加引號 → bash 不展開，指向 /proj/~/secret（專案內）→ allow
  assertEquals(testRule.evaluate(ctxOf('test -f "~/secret"')).kind, "allow");
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
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -D")), true);
});

Deno.test("cygpath 形態 C：帶路徑操作元 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -D /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -F 0 /outside/x")).kind, "ask");
});

Deno.test("cygpath：-t 未知值 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t nonsense src/a.ts")).kind, "ask");
});

Deno.test("cygpath：-p 與查檔案系統的旗標併用 → ask", () => {
  // -p 的操作元是 PATH 列表，整串丟給 resolvePath 會被當成單一路徑而誤判
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -s -p src:/c/Windows")).kind, "ask");
  // 但 -p 單用（純字串轉換）仍 allow
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -p /a:/b")).kind, "allow");
});

Deno.test("cygpath：形態 B 的每個旗標都不得取得 cwd 豁免", () => {
  for (const flag of ["-d", "-s", "-l", "-M"]) {
    assertEquals(
      cygpathRule.cwdIndependent?.(ctxOf(`cygpath ${flag} src/a.ts`)),
      false,
      `${flag} 不應豁免`,
    );
  }
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -t dos src/a.ts")), false);
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
  /** 出現任何形態 C（輸出系統目錄）旗標。 */
  systemDir: boolean;
  /** 出現 -p（操作元是 PATH 列表，不是單一路徑）。 */
  pathList: boolean;
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
  let systemDir = false;
  let pathList = false;
  const operands: Word[] = [];
  const argv = ctx.argv;
  const fail = (reason: string): Scan => ({ queriesFs, systemDir, pathList, askReason: reason, operands });

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) return fail("cygpath：含動態 token，無法靜態判定");
    if (!t.startsWith("-") || t === "-") {
      operands.push(argv[i]);
      continue;
    }
    if (ASK_FLAGS.has(t)) {
      return fail(`cygpath：${t} 會從檔案讀取操作元／選項或操作行程`);
    }
    if (SHAPE_B.has(t)) {
      queriesFs = true;
      continue;
    }
    if (t === "-p") {
      pathList = true;
      continue;
    }
    if (SHAPE_C_VALUELESS.has(t)) {
      systemDir = true;
      continue;
    }
    if (SHAPE_A_VALUELESS.has(t)) continue;
    if (SHAPE_A_WITH_VALUE.has(t) || SHAPE_C_WITH_VALUE.has(t)) {
      if (SHAPE_C_WITH_VALUE.has(t)) systemDir = true;
      i++;
      if (i >= argv.length) return fail(`cygpath：${t} 缺少值`);
      const v = staticValue(argv[i]);
      if (v === null) return fail("cygpath：旗標值為動態 token");
      if (t === "-t") {
        // -t dos 等同 -d（DOS 8.3 短名，需查檔案系統）；其餘未知值不在 allowlist 內
        if (v === "dos") queriesFs = true;
        else if (!SAFE_TYPES.has(v)) return fail(`cygpath：未列入安全集合的 -t 值 ${v}`);
      }
      continue;
    }
    return fail(`cygpath：未列入安全集合的旗標 ${t}`);
  }
  return { queriesFs, systemDir, pathList, askReason: null, operands };
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
    // 形態 C 不接受路徑操作元：輸出與輸入無關，給了操作元代表意圖不明
    if (s.systemDir && s.operands.length > 0) {
      return ask("cygpath：輸出系統目錄的形態不接受路徑操作元");
    }
    if (s.queriesFs) {
      // -p 的操作元是以 : / ; 分隔的 PATH 列表，cygpath 會逐項查詢。
      // 整串丟給 resolvePath 會被當成單一路徑而誤判，故與查檔案系統的形態併用時一律 ask。
      if (s.pathList) {
        return ask("cygpath：-p 的操作元是 PATH 列表，無法逐項做範圍檢查");
      }
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

Deno.test("npm: 版本後綴也必須合法（否則是本地目錄 spec）", () => {
  // npm-package-arg 把 `pkg@..` 解析成指向上層目錄的本地 spec
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@..")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@.")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@. "')).kind, "ask"); // 尾隨空白
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@@bad")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf('npm view "not a package"')).kind, "ask");
  // 合法的 range / tag 仍放行
  assertEquals(npmRule.evaluate(ctxOf("npm view pkg@latest")).kind, "allow");
  assertEquals(npmRule.evaluate(ctxOf('npm view "pkg@^1.2.3"')).kind, "allow");
});

Deno.test("npm: 安全吃值旗標缺值、空值或被旗標當成值 → ask", () => {
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp=")).kind, "ask");
  // 關鍵：--otp 不得把後面的危險旗標當成自己的值而讓它躲過檢查
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp --cache=/outside")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp --registry=http://evil")).kind, "ask");
  assertEquals(npmRule.evaluate(ctxOf("npm view markdown-it --otp 123456")).kind, "allow");
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

/** 套件名：字母數字開頭，其後允許 . _ - 與字母數字。 */
const PKG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * 版本／range／tag 後綴：允許字母數字與常見 range 符號（. - + ^ ~ > < = * | 空白）。
 * **不得含 `/`、`\`、`:`，也不得含獨立的 `.` 或 `..` 段**——`pkg@..` 會被
 * npm-package-arg 解析成指向上層目錄的本地 spec。
 */
const PKG_SUFFIX = /^[A-Za-z0-9.\-+^~><=*|]+$/;

function isValidSuffix(suffix: string): boolean {
  if (suffix === "") return false;
  // 不允許任何空白：`pkg@. ` 的尾隨空白會讓「純由 . 組成」的檢查失效，
  // 而 npm-package-arg 仍把它解析成本地目錄 spec
  if (/\s/.test(suffix)) return false;
  if (!PKG_SUFFIX.test(suffix)) return false;
  // 排除純由 . 組成的形態（`.`、`..`、`...`）與含 `..` 者
  if (/^\.+$/.test(suffix)) return false;
  if (suffix.includes("..")) return false;
  return true;
}

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
    if (!PKG_NAME.test(scope)) return false;
    rest = rest.slice(slash + 1);
  }
  if (rest === "" || rest.includes("/")) return false;
  const at = rest.indexOf("@");
  if (at === -1) return PKG_NAME.test(rest);
  // 有版本後綴：名稱與後綴都必須合法。只驗名稱會放過 `pkg@..`（本地目錄 spec）。
  return PKG_NAME.test(rest.slice(0, at)) && isValidSuffix(rest.slice(at + 1));
}

/**
 * npm：子指令 + 操作元雙層 allowlist。
 *
 * 注意本規則**管不到**的事：所有 npm 呼叫都會在 dispatch 子指令前載入設定，沿目錄樹向上找
 * local prefix 並讀取該處 `.npmrc`——實測在祖先目錄放 package.json 與設定 logs-dir 的 .npmrc，
 * `npm view` 的 debug log 就會寫進該處。同一機制亦可重導 cache 與 registry。這是 npm 的既有
 * 設定模型，無法靠挑選子指令規避，也不由本規則處理；放行 npm 即等於接受這層行為。
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
          if (eq !== -1) {
            if (t.slice(eq + 1) === "") return ask(`npm：${name} 的值為空`);
            continue;
          }
          i++; // 吃掉下一個 token 當值
          if (i >= tokens.length) return ask(`npm：${name} 缺少值`);
          // 下一個 token 若長得像旗標，npm 的解析器會把它當成獨立選項而非本旗標的值。
          // 若這裡照吃，`npm view x --otp --cache=/outside` 會讓 --cache 整個躲過檢查。
          if (tokens[i].startsWith("-")) return ask(`npm：${name} 的值缺失（其後是另一個旗標）`);
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
- Modify: `src/rules/allowlist_test.ts`（`npm` 已不再是「未涵蓋指令」）
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

- [ ] **Step 2: 更新 allowlist_test.ts 的涵蓋清單**

`src/rules/allowlist_test.ts:11` 的「未涵蓋指令」清單目前含 `"npm"`，註冊後會失敗。
把 `npm` 從該清單移到上方的「已涵蓋」清單，並一併加入本次其他三條：

```ts
Deno.test("known commands resolve to a rule", () => {
  for (const name of ["cat", "echo", "cd", "sed", "awk", "find", "sort", "yq", "tree", "file", "date", "xxd", "uniq", "grep", "rg", "git", "diff", "base64", "test", "cygpath", "npm"]) {
    assertEquals(lookupRule(name) !== undefined, true, `expected rule for ${name}`);
  }
});

Deno.test("excluded / unknown commands resolve to undefined", () => {
  for (const name of ["rm", "mv", "mkdir", "less", "bash", "tee", "xargs"]) {
    assertEquals(lookupRule(name), undefined, `expected no rule for ${name}`);
  }
});
```

Run: `deno task test`
Expected: PASS。若拋出 `duplicate rule for command: …`，表示該指令名已被既有規則涵蓋，需先移除舊的涵蓋再註冊。

- [ ] **Step 3: 寫 e2e 測試**

既有 helper 的實際簽名（照用，不要改動它們）：

- `runHook(payload: unknown, projectDir: string): Promise<string>` — 回傳 stdout 字串
- `runHookWithEnv(payload: unknown, env: Record<string, string>): Promise<string>` — **兩個參數**，
  專案目錄透過 `env.CLAUDE_PROJECT_DIR` 傳入
- `projWithAllow(allow: string[]): Promise<string>` — 建暫存專案目錄並寫入
  `.claude/settings.json` 的 `permissions.allow`，回傳目錄路徑

追加到 `src/main_test.ts`：

```ts
/** 由指令字串組出 hook payload，並取出決策。 */
async function decisionOf(command: string, projectDir: string): Promise<string> {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command }, cwd: projectDir },
    projectDir,
  );
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

Deno.test("e2e: 本次的真實指令改為自動放行", async () => {
  const proj = await projWithAllow([]);
  try {
    await Deno.writeTextFile(`${proj}/deno.json`, "{}");
    assertEquals(await decisionOf("base64 -d deno.json | head -40", proj), "allow");
    assertEquals(await decisionOf("test -f deno.json && cat deno.json | head -100", proj), "allow");
    assertEquals(
      await decisionOf("npm view markdown-it version && npm view marked version", proj),
      "allow",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test("e2e: 動態 cd 目標不再繞過 cwd 檢查", async () => {
  const proj = await projWithAllow([]);
  try {
    assertEquals(await decisionOf('cd "$(uname -a)" && git log --oneline -3', proj), "ask");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test({
  ignore: Deno.build.os !== "windows",
  name: "e2e: cygpath 推導 cwd 後，相對路徑讀取被正確判定（本次主要需求）",
  async fn() {
    const proj = await projWithAllow([]);
    try {
      await Deno.writeTextFile(`${proj}/deno.json`, "{}");
      // 專案內：推導出的 cwd 在範圍內 → 相對路徑可解析 → allow
      assertEquals(await decisionOf(`cd "$(cygpath -u '${proj}')" && cat deno.json`, proj), "allow");
      // 專案外：推導出的 cwd 落在範圍外 → 中央前置規則一 → ask
      assertEquals(await decisionOf(`cd "$(cygpath -u 'C:/Windows')" && cat deno.json`, proj), "ask");
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  },
});
```

tilde 相關的 e2e **必須用 `runHookWithEnv` 顯式給 `HOME`**——`runHook` 會清空環境，
用它只測得到「HOME 未設定」那一條分支：

```ts
/** 帶環境變數跑 hook 並取出決策。 */
async function decisionWithEnv(
  command: string,
  proj: string,
  env: Record<string, string>,
): Promise<string> {
  const out = await runHookWithEnv(
    { tool_name: "Bash", tool_input: { command }, cwd: proj },
    { CLAUDE_PROJECT_DIR: proj, ...env },
  );
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

Deno.test("e2e: 未加引號的 ~ 展開為 HOME，落在專案外 → ask", async () => {
  const proj = await projWithAllow([]);
  try {
    const env = { HOME: "/bash-home", USERPROFILE: "/bash-home" };
    for (
      const cmd of [
        "cat ~/secret",
        "cat ~/.ssh/id_rsa",
        "grep x ~/secret",
        "head -5 ~/secret",
        "test -f ~/secret",
        "base64 ~/secret",
        "cat ~user/secret",
        "cat ~+/secret",
        "cat ~-/secret",
      ]
    ) {
      assertEquals(await decisionWithEnv(cmd, proj, env), "ask", cmd);
    }
    // 引號形態指向 <proj>/~/secret，仍在專案內 → allow
    assertEquals(await decisionWithEnv('cat "~/secret"', proj, env), "allow");
    // HOME 未設定 → 不可解析 → ask
    assertEquals(
      await decisionWithEnv("cat ~/x", proj, { USERPROFILE: "/settings-home" }),
      "ask",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test("e2e: Read(~/cache/**) 以 settings home 解析，指令的 ~ 以 HOME 展開", async () => {
  // settings 側的 ~ 走 resolveHome（Windows 優先 USERPROFILE）；指令側的 ~ 走 HOME。
  // 兩者不同時，授權的路徑與實際讀取的路徑不同 → 必須 ask。
  const proj = await projWithAllow(["Read(~/cache/**)"]);
  try {
    assertEquals(
      await decisionWithEnv("cat ~/cache/x", proj, {
        HOME: "/bash-home",
        USERPROFILE: "/settings-home",
      }),
      "ask",
    );
    // 兩者相同時，授權與實際讀取一致 → allow
    assertEquals(
      await decisionWithEnv("cat ~/cache/x", proj, {
        HOME: "/same-home",
        USERPROFILE: "/same-home",
      }),
      "allow",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});
```

> 第二個測試在非 Windows 平台上 `resolveHome` 優先 `HOME`，兩個斷言會同為 allow。
> 以 `Deno.test({ ignore: Deno.build.os !== "windows", … })` 包住第一個斷言，
> 或把該測試整體標為 Windows-only。

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
# 逐條印出決策並斷言 exit 0——不可讓 echo 蓋掉 binary 的離開碼
failures=0
run() {
  out=$(echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$1},\"cwd\":\"D:/claude-code-permission-checker\"}" \
    | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe)
  rc=$?
  printf '%s\n  [exit=%s]\n' "$out" "$rc"
  if [ "$rc" -ne 0 ]; then
    echo "  !!! 違反不變量：hook 必須永遠 exit 0"
    failures=$((failures + 1))
  fi
}

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

# 推導 cwd 後的相對路徑讀取（本次主要需求）
run '"cd \"$(cygpath -u '\''D:/claude-code-permission-checker'\'')\" && cat deno.json"'   # 期望 allow
run '"cat ~/.ssh/id_rsa"'                                                                  # 期望 ask

echo "exit 非 0 的次數：$failures"
[ "$failures" -eq 0 ] || echo "!!! operational verification 未通過"
```

Expected：標示 allow 的回 `permissionDecision: "allow"`、標示 ask 的回 `"ask"`，
且 `failures` 為 0（hook 必須永遠 exit 0）。

> ⚠️ 若某條 builtin 應為 ask 的指令回了 allow 且 reason 提到「命中 permissions.allow」，
> 那是 settings.json 的合法升級、不是 bug（見 CLAUDE.md 的說明）。但若回 allow 的是
> **寫入重導向／賦值前綴／範圍外 `<`／cwd 超範圍**，那就是 regression，必須修。

- [ ] **Step 7: 更新 CLAUDE.md**

在 CLAUDE.md 中同步下列四處（維持既有文件風格與語氣）：

1. 「架構（評估管線）」的 `walk.ts` 段落：補上 `applyCd` 會先試 `staticValue`、再試
   `subst_eval.ts` 的求值框架，以及 `cd -` / `cd ~` 的語義。
2. 新增 `src/engine/tilde.ts` 與 `src/engine/subst_eval.ts` 的職責說明。
3. 「四條中央前置規則」的規則一：補上 `cwd.kind === "unknown"` 也 ask，並說明初始 cwd 恆為 known。
4. 「⚠️ 不要再犯的問題」新增三則：
   - `resolvePath` 對未加引號的 leading tilde 必須先展開（shell home 用 `HOME`，不可用
     `resolveHome`——後者在 Windows 優先 `USERPROFILE`），`resolvePathValue` 對以 `~` 開頭的
     字串 fail-closed；引號形態（`"~/x"`）必須維持相對語義，不可一併擋掉。
   - cygpath 的「回操作元原樣」只對磁碟形式與相對路徑成立：`cygpath -m /usr/bin` 會經 MSYS2
     mount 表變成 `C:/Program Files/Git/usr/bin`，而 `normalizeAbsolute` 不懂 mount 表。
   - `base64` 的 `-w` 吃值，但 `md5sum`/`sha256sum` 的 `-w` 是不吃值的 `--warn`——旗標 arity
     不可跨指令共用，否則會讓 checksum 工具的路徑操作元被當成旗標值而漏檢。

5. 「已接受 over-deny / 已接受繞道」區塊補上本次的兩條**已接受限制**（spec 已裁決，文件需同步）：
   - **`cd` 一律視為成功**：目標目錄不存在時 bash 會留在原地，後續相對路徑解析到別處。
     已知的兩個純詞法收緊方案（只信任 `&&` 之後的 cd、或要求 cd 前後兩個 cwd 都通過檢查）
     因誤殺與改動面被擱置，不是無解。
   - **npm 的設定探索與寫入位置不納入判定**：所有 npm 呼叫都在 dispatch 前沿目錄樹向上讀
     `.npmrc`，該檔可重導 `cache` / `logs-dir` / `registry`；npm 也會寫入並輪替刪除自己的
     debug log。放行 `npm view`/`ping`/`whoami` 即等於接受這層行為。

同時在 `rules/` 段落補上新增的四條規則檔，並在「架構」段落補上 `src/engine/tilde.ts`
與 `src/engine/subst_eval.ts`。

- [ ] **Step 8: 最終提交**

```bash
git add src/rules/allowlist.ts src/rules/allowlist_test.ts src/main_test.ts CLAUDE.md
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
