# git 唯讀子指令 allowlist 擴充 + `-O` orderfile 範圍檢查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 16 個純唯讀 git 子指令（`merge-base`、`rev-list`、`diff-tree` 家族等）自動放行，同時堵住兩個既有的放行缺口：`-O <orderfile>` 從未做路徑範圍檢查，以及 `git --help <sub>` / `git <sub> --help` 會 spawn 任意 man viewer。

**Architecture:** 全部變更集中在單一規則檔 `src/rules/commands/git.ts`。`parseSub` 額外回傳 `restWords: Word[]`（子指令之後的原始 Word），供新的 `scanRestArgs` 走訪函式使用——該函式在 `--` 處停止掃描，對動態 token 回 ask，對 `-O` 的兩種寫法做 `resolvePathValue` 範圍檢查。之後才擴充 `READ_SUBCOMMANDS` 集合。`--help` 封堵需要兩處改動：從 `SAFE_VALUELESS_GLOBAL` 移除（涵蓋全域位置），加 rest 層檢查（涵蓋子指令之後）。

**任務順序的安全性理由（重要）：** `-O` 範圍檢查（Task 2）**必須先於** `READ_SUBCOMMANDS` 擴充（Task 3）。反過來做的話，Task 3 的 commit 會產生一個中間狀態：`diff-tree` / `diff-files` / `diff-index` / `range-diff` / `whatchanged` 已被放行，但它們的 `-O` 尚未檢查——等於把既有的 `-O` 缺口擴大到這些新入口。每個 commit 都必須是安全的中間狀態，不能靠「後續 task 會補上」。

**Tech Stack:** Deno + TypeScript，unbash 4.0.1 AST，`@std/assert` 測試。

**Spec:** `docs/superpowers/specs/2026-08-10-git-readonly-subcommands-design.md`

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/rules/commands/git.ts` | Modify | git 指令規則的唯一實作點。本次全部行為變更都在此檔：`parseSub` 回傳值、新的 `scanRestArgs` 掃描函式、`evaluate` 的檢查順序、子指令集合。 |
| `src/rules/commands/git_test.ts` | Modify | 對應的單元測試。既有測試**不需修改**（已逐一檢視，見下），只追加新測試。 |
| `CLAUDE.md` | Modify | 專案文件中描述 git 規則的兩處：子指令 allowlist 範圍、以及攻擊面列舉。 |

**既有測試檢視結論（spec §6.13 要求）**：`git_test.ts` 中唯一含動態 token 的斷言是 `git $SUB`（第 101 行），屬**子指令位置**動態，`parseSub` 早已回 `dynamic: true` → ask，不受本次「子指令**之後**動態 token → ask」影響。其他測試檔（`evaluate_test.ts`、`cwd_test.ts`、`walk_test.ts`、`matcher_test.ts`、`settings_test.ts`）中的 git 斷言全為靜態 token。`--help` 在 `src/` 中僅出現於 `git.ts:42` 一處，無測試依賴。**因此本計畫不修改任何既有斷言**；若實作時發現有既有測試轉紅，先停下來確認是否為非預期的行為變更。

---

### Task 1: `parseSub` 回傳 `restWords` + 動態 token 收緊

`-O` 檢查建立在「能靜態看到所有引數」之上。若放行動態 token，`git diff $ARGS HEAD` 在 runtime 展開為 `git diff -O/etc/passwd HEAD` 時仍以展開前的形狀分類，Task 2 的檢查會被單一變數整個繞過。靜態分析無從區分 `$FOO` 展開成 branch 名或旗標，故 fail-safe 處理是 ask。

這是**刻意的行為收緊**：`git log $ref`、`git diff $BRANCH` 等原本 `allow`，變更後 `ask`。

**Files:**
- Modify: `src/rules/commands/git.ts:1-3`（import）
- Modify: `src/rules/commands/git.ts:68-162`（`parseSub`）
- Modify: `src/rules/commands/git.ts`（新增 `scanRestArgs`、接進 `evaluate`）
- Test: `src/rules/commands/git_test.ts`

- [ ] **Step 1: Write the failing tests**

在 `src/rules/commands/git_test.ts` 檔尾追加：

```typescript
// ── 本次新增：子指令後動態 token 收緊 ──────────────────────────────────────

Deno.test("dynamic token after subcommand asks", () => {
  assertEquals(v("git log $ref"), "ask");
  assertEquals(v("git diff $BRANCH HEAD"), "ask");
  assertEquals(v("git diff $(git merge-base HEAD main)"), "ask");
  assertEquals(v("git log *.md"), "ask"); // 未引號 glob 亦屬動態
});

Deno.test("dynamic token after -- still allows (pathspec cannot become a flag)", () => {
  assertEquals(v("git diff HEAD -- $FILE"), "allow");
});

Deno.test("static tokens that look exotic are still static", () => {
  // @{upstream} 不含逗號 / .. ，未被解析為 BraceExpansion → 靜態
  assertEquals(v("git rev-parse --abbrev-ref @{upstream}"), "allow");
  assertEquals(v("git log HEAD~1"), "allow");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: FAIL — `dynamic token after subcommand asks` 失敗，`git log $ref` 目前回 `allow`（`parseSub` 以哨符 `" "` 代表動態值、不 ask）。

同時確認另外兩條新測試（`dynamic token after --`、`static tokens that look exotic`）此時**已 PASS**——它們是防止過度收緊的護欄，必須在實作前後都綠。跑整個檔案（而非 `--filter`）才能看到這三條的個別狀態。

- [ ] **Step 3: 匯入 `Word` 型別**

把 `src/rules/commands/git.ts` 的 import 區塊：

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";
```

改為：

```typescript
import type { Word } from "../../deps.ts";
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";
```

- [ ] **Step 4: 讓 `parseSub` 回傳 `restWords`**

修改 `parseSub` 的簽名與全部 4 個 return 點。簽名改為：

```typescript
function parseSub(
  argv: RuleContext["argv"],
): {
  sub: string | null;
  rest: string[];
  restWords: Word[];
  dynamic: boolean;
  dangerous: string | null;
} {
```

三個早退 return 點各補上 `restWords: []`：

```typescript
    if (t === null) return { sub: null, rest: [], restWords: [], dynamic: true, dangerous };
```

```typescript
  if (i >= argv.length) return { sub: null, rest: [], restWords: [], dynamic: false, dangerous };
  const subTok = staticValue(argv[i]);
  if (subTok === null) return { sub: null, rest: [], restWords: [], dynamic: true, dangerous };
```

最後的收集迴圈與 return 改為：

```typescript
  const rest: string[] = [];
  const restWords: Word[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const r = staticValue(argv[j]);
    rest.push(r ?? " "); // 動態值以哨符代表（既有 has() / includes() 檢查沿用）
    restWords.push(argv[j]); // 原始 Word，供 scanRestArgs 精確判定動態
  }
  return { sub: subTok, rest, restWords, dynamic: false, dangerous };
```

- [ ] **Step 5: 新增 `scanRestArgs`（本任務只實作動態 token 與 `--` 停止）**

在 `src/rules/commands/git.ts` 的 `has()` helper 之後、`gitRule` 之前插入：

```typescript
/**
 * 走訪子指令之後的引數。
 *
 * - 遇 `--` 停止：其後是 pathspec，不再有旗標語義。
 * - 動態 token → ask：靜態分析無法排除其展開為 `-O` 等旗標，放行等於讓旗標檢查可被單一變數繞過。
 *
 * 回傳 null 代表本掃描無異議（由呼叫端續行既有判定）。
 */
function scanRestArgs(
  sub: string,
  restWords: Word[],
  _ctx: RuleContext,
): RuleVerdict | null {
  let k = 0;
  while (k < restWords.length) {
    const t = staticValue(restWords[k]);
    if (t === "--") return null; // pathspec 區，停止掃描
    if (t === null) {
      return ask(`git ${sub}：子指令引數含動態 token，無法排除其展開為 -O 等旗標`);
    }
    k += 1;
  }
  return null;
}
```

- [ ] **Step 6: 接進 `evaluate`**

先把 `evaluate` 開頭的解構加上 `restWords`：

```typescript
    const { sub, rest, restWords, dynamic, dangerous } = parseSub(ctx.argv);
```

然後在既有 `git grep -O` 檢查**之後**、`if (READ_SUBCOMMANDS.has(sub)) return allow();` **之前**插入：

```typescript
    // 子指令引數掃描（動態 token / -O orderfile 範圍）。
    // 刻意置於 grep -O 檢查之後，使 `git grep -O` 維持既有的「執行任意 pager」理由；
    // 也刻意置於 switch 之前，故 branch / tag / config / stash / remote 同受此掃描。
    const scanned = scanRestArgs(sub, restWords, ctx);
    if (scanned) return scanned;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: PASS（全部測試，含既有的 `git $SUB` → ask）。

- [ ] **Step 8: Type check**

Run: `deno task check`

Expected: 無錯誤（`_ctx` 前綴底線避開未使用參數警告；Task 2 會用到它）。

- [ ] **Step 9: Commit**

```bash
git add src/rules/commands/git.ts src/rules/commands/git_test.ts
git commit -m "fix(rules): ask on dynamic tokens after a git subcommand

Static analysis cannot tell whether \$FOO expands to a branch name or to
-O/etc/passwd, so tolerating dynamic tokens would let a single variable bypass
the orderfile scope check added next. parseSub now also returns the raw Words
so scanRestArgs can distinguish a dynamic token from a literal sentinel.

Deliberate tightening: git log \$ref and git diff \$BRANCH move from allow to
ask. Tokens after -- are pathspecs and stay allowed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `-O` orderfile 範圍檢查

`git diff -O<file>` 的 orderfile 會被 git 實際開啟讀取，但現行規則完全未做範圍檢查——`git diff -O/etc/passwd HEAD~1 HEAD` 目前判 `allow`。`-O` 支援黏寫 `-O<file>` 與空格 `-O <file>` 兩種寫法（git 拒絕 `-rO<file>` 這類 bundling，無需處理）。

本任務**只用既有 allowlist 中的子指令**（`diff` / `log` / `show`）測試，因為新子指令尚未加入（Task 3 才加）——用尚未放行的子指令測 `ask` 會得到假陽性（它們此時因 `default: ask` 就會過）。

**Files:**
- Modify: `src/rules/commands/git.ts`（`scanRestArgs`）
- Test: `src/rules/commands/git_test.ts`

- [ ] **Step 1: Write the failing tests**

在 `src/rules/commands/git_test.ts` 檔尾追加：

```typescript
// ── 本次新增：-O orderfile 範圍檢查 ───────────────────────────────────────

Deno.test("-O orderfile attached form: in-project allows, outside asks", () => {
  assertEquals(v("git diff -Osrc/order.txt HEAD"), "allow");
  assertEquals(v("git diff -O/etc/passwd HEAD"), "ask");
  assertEquals(v("git log -O../outside.txt"), "ask");
});

Deno.test("-O orderfile space form: in-project allows, outside asks", () => {
  assertEquals(v("git diff -O src/order.txt HEAD"), "allow");
  assertEquals(v("git diff -O /etc/passwd HEAD"), "ask");
  assertEquals(v("git show -O /tmp/x HEAD"), "ask");
});

Deno.test("-O edge cases ask", () => {
  assertEquals(v("git diff HEAD -O"), "ask"); // 末尾缺值
  assertEquals(v('git diff -O "$F" HEAD'), "ask"); // 值為動態
});

Deno.test("-O after -- is a pathspec, not a flag", () => {
  assertEquals(v("git diff HEAD -- -O/etc/passwd"), "allow");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: FAIL — `-O orderfile attached form` 與 `-O orderfile space form` 失敗（`git diff -O/etc/passwd HEAD` 目前回 `allow`）。

`-O edge cases ask` 此時可能已 PASS（`"$F"` 是動態 token，Task 1 已涵蓋；`git diff HEAD -O` 則尚未）；`-O after --` 應已 PASS。這些狀態差異是正常的，Step 4 之後全部必須綠。

- [ ] **Step 3: 在 `scanRestArgs` 中加入 `-O` 兩種形式的處理**

把 Task 1 建立的 `scanRestArgs` 整個替換為（注意參數 `_ctx` 改名為 `ctx`，並更新 doc comment）：

```typescript
/**
 * 走訪子指令之後的引數。
 *
 * - 遇 `--` 停止：其後是 pathspec，不再有旗標語義。
 * - 動態 token → ask：靜態分析無法排除其展開為 `-O` 等旗標，放行等於讓旗標檢查可被單一變數繞過。
 * - `-O <file>` / `-O<file>`（orderfile）：git 會實際開啟讀取該路徑，故做範圍檢查。
 *   不處理 bundling（`-rO<file>`）——git 本身即拒絕該形式。
 *
 * 回傳 null 代表本掃描無異議（由呼叫端續行既有判定）。
 */
function scanRestArgs(
  sub: string,
  restWords: Word[],
  ctx: RuleContext,
): RuleVerdict | null {
  const outOfScope = `git ${sub}：-O orderfile 路徑超出專案範圍`;
  let k = 0;
  while (k < restWords.length) {
    const t = staticValue(restWords[k]);
    if (t === "--") return null; // pathspec 區，停止掃描
    if (t === null) {
      return ask(`git ${sub}：子指令引數含動態 token，無法排除其展開為 -O 等旗標`);
    }
    // 空格形式：-O <file>
    if (t === "-O") {
      const valWord = restWords[k + 1];
      if (valWord === undefined) return ask(`git ${sub}：-O 缺少 orderfile 值`);
      const val = staticValue(valWord);
      if (val === null) {
        return ask(`git ${sub}：-O 的 orderfile 值為動態，無法判定範圍`);
      }
      if (ctx.resolvePathValue(val) !== "in-project") return ask(outOfScope);
      k += 2;
      continue;
    }
    // 黏寫形式：-O<file>
    if (t.startsWith("-O") && t.length > 2) {
      if (ctx.resolvePathValue(t.slice(2)) !== "in-project") return ask(outOfScope);
      k += 1;
      continue;
    }
    k += 1;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: PASS（全部測試）。

- [ ] **Step 5: Type check + lint**

Run: `deno task check && deno task lint`

Expected: 兩者皆無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/git.ts src/rules/commands/git_test.ts
git commit -m "fix(rules): scope-check git -O orderfile paths

git opens the -O <orderfile> path for reading, but it was never scope-checked:
git diff -O/etc/passwd HEAD was classified allow. Both the attached (-O<file>)
and space (-O <file>) forms are now resolved through resolvePathValue and ask
when outside the project. Bundling (-rO<file>) needs no handling - git itself
rejects it.

Lands before the allowlist expansion so no intermediate commit exposes the
gap on newly allowed subcommands.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 擴充 `READ_SUBCOMMANDS`

`-O` 防護（Task 2）已就位，現在擴充 allowlist 才不會產生不安全的中間狀態。

**Files:**
- Modify: `src/rules/commands/git.ts:45-49`
- Test: `src/rules/commands/git_test.ts`

- [ ] **Step 1: Write the failing tests**

在 `src/rules/commands/git_test.ts` 檔尾追加：

```typescript
// ── 本次新增：純唯讀子指令擴充 ──────────────────────────────────────────────

Deno.test("newly added read-only subcommands allow", () => {
  assertEquals(v("git merge-base HEAD main"), "allow");
  assertEquals(v("git rev-list --count HEAD"), "allow");
  assertEquals(v("git name-rev HEAD"), "allow");
  assertEquals(v("git whatchanged -1"), "allow");
  assertEquals(v("git range-diff a..b c..d"), "allow");
  assertEquals(v("git cherry origin/main"), "allow");
  assertEquals(v("git diff-tree -r HEAD"), "allow");
  assertEquals(v("git diff-files -p"), "allow");
  assertEquals(v("git diff-index --cached HEAD"), "allow");
  assertEquals(v("git check-ignore src/x.ts"), "allow");
  assertEquals(v("git check-attr diff src/x.ts"), "allow");
  assertEquals(v("git check-ref-format refs/heads/x"), "allow");
  assertEquals(v("git count-objects -v"), "allow");
  assertEquals(v("git var GIT_AUTHOR_IDENT"), "allow");
  assertEquals(v("git annotate README.md"), "allow");
  assertEquals(v("git version"), "allow");
});

Deno.test("excluded subcommands still ask", () => {
  assertEquals(v("git ls-remote origin"), "ask"); // 網路存取
  assertEquals(v("git help log"), "ask"); // spawn man / browser
  assertEquals(v("git verify-commit HEAD"), "ask"); // spawn gpg
  assertEquals(v("git verify-tag v1"), "ask"); // spawn gpg
  assertEquals(v("git symbolic-ref HEAD"), "ask"); // 有寫入形式
  assertEquals(v("git worktree list"), "ask");
  assertEquals(v("git submodule status"), "ask");
  assertEquals(v("git notes list"), "ask");
  assertEquals(v("git bisect log"), "ask");
  assertEquals(v("git merge-tree a b"), "ask");
});

Deno.test("-O scope check also covers the newly added subcommands", () => {
  assertEquals(v("git diff-index -Osrc/order.txt HEAD"), "allow");
  assertEquals(v("git diff-tree -O/etc/passwd HEAD"), "ask");
  assertEquals(v("git range-diff -O /tmp/x a..b c..d"), "ask");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: FAIL — `newly added read-only subcommands allow` 失敗（`git merge-base HEAD main` 回 `ask`），`-O scope check also covers the newly added subcommands` 也失敗（`git diff-index -Osrc/order.txt HEAD` 回 `ask`，因 `diff-index` 尚未列入 allowlist）。

`excluded subcommands still ask` 此時**已 PASS**（那些子指令本來就落 `default: ask`）；它是防止 Step 3 誤加的護欄，實作後必須仍綠。

- [ ] **Step 3: 擴充集合**

把 `src/rules/commands/git.ts:45-49` 的：

```typescript
/** 純讀取子指令（其餘子指令一律 ask）。 */
const READ_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe",
  "cat-file", "ls-files", "ls-tree", "for-each-ref", "reflog", "shortlog", "grep",
]);
```

替換為：

```typescript
/**
 * 純讀取子指令（其餘子指令一律 ask）。
 *
 * 刻意排除（皆維持 ask）：
 * - `ls-remote`：不改本地狀態，但會發網路請求、可接任意 URL（不受 curl domain allowlist 管轄）。
 * - `help`、`verify-commit`、`verify-tag`：不改儲存庫狀態，但會 spawn 外部程式（man / browser / gpg）。
 * - `symbolic-ref`、`worktree`、`submodule`、`notes`、`bisect`、`merge-tree`：有寫入形式，需個案 gate。
 */
const READ_SUBCOMMANDS = new Set<string>([
  // porcelain
  "status", "log", "diff", "show", "blame", "annotate", "describe", "shortlog",
  "grep", "reflog", "whatchanged", "range-diff", "cherry", "count-objects",
  "version",
  // plumbing
  "rev-parse", "rev-list", "merge-base", "name-rev", "var",
  "cat-file", "ls-files", "ls-tree", "for-each-ref",
  "diff-tree", "diff-files", "diff-index",
  "check-ignore", "check-attr", "check-ref-format",
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: PASS（全部測試，含既有的）。

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/git.ts src/rules/commands/git_test.ts
git commit -m "feat(rules): add 16 pure read-only git subcommands to allowlist

merge-base, rev-list, name-rev, var, diff-tree/diff-files/diff-index,
check-ignore/check-attr/check-ref-format, whatchanged, range-diff, cherry,
count-objects, annotate, version.

Excludes ls-remote (network), help/verify-* (spawns man/browser/gpg), and
subcommands with write forms (symbolic-ref, worktree, submodule, notes,
bisect, merge-tree).

The -O orderfile scope check is already in place, so these new entries do not
widen that gap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 封堵 `--help` 兩條路徑

`git help log` 已被排除，但 `git --help log`（`--help` 在 `SAFE_VALUELESS_GLOBAL` 被跳過，子指令判為 `log` → allow）與 `git log --help`（落在 rest、無人檢查）語義等價且都會 spawn man viewer。man viewer 可經 `GIT_MAN_VIEWER` 指定任意程式，屬實質的外部程式執行面。

**Files:**
- Modify: `src/rules/commands/git.ts:26-43`（`SAFE_VALUELESS_GLOBAL`）
- Modify: `src/rules/commands/git.ts`（`evaluate` 的 rest 層檢查區）
- Test: `src/rules/commands/git_test.ts`

- [ ] **Step 1: Write the failing tests**

在 `src/rules/commands/git_test.ts` 檔尾追加：

```typescript
// ── 本次新增：--help 封堵 ─────────────────────────────────────────────────

Deno.test("--help paths ask (equivalent to the excluded help subcommand)", () => {
  assertEquals(v("git --help log"), "ask"); // 全域位置
  assertEquals(v("git log --help"), "ask"); // 子指令之後
  assertEquals(v("git help log"), "ask"); // 既有
  assertEquals(v("git --help"), "ask"); // 無子指令（over-ask，可接受）
});

Deno.test("-h prints usage only and still allows", () => {
  assertEquals(v("git log -h"), "allow");
  assertEquals(v("git merge-base -h"), "allow");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: FAIL — `--help paths ask` 失敗（`git --help log` 與 `git log --help` 目前皆回 `allow`）。

`-h prints usage only and still allows` 此時**已 PASS**（`merge-base` 於 Task 3 已加入 allowlist），是防止誤把 `-h` 一起擋掉的護欄。

- [ ] **Step 3: 移除全域安全清單中的 `--help`**

在 `src/rules/commands/git.ts` 的 `SAFE_VALUELESS_GLOBAL` 中，刪除 `"--help",` 這一行，並在原位置留下說明。改動後該常數末段為：

```typescript
  "--no-lazy-fetch",
  "--version",
  // 刻意不含 "--help"：`git --help <sub>` 等同 `git help <sub>`，會 spawn man viewer
  // （可經 GIT_MAN_VIEWER 指定任意程式）。移除後它落入「未知全域旗標」分支 → ask。
]);
```

- [ ] **Step 4: 新增 rest 層 `--help` 檢查**

在 `src/rules/commands/git.ts` 的 `evaluate` 中，緊接既有 `--ext-diff` 檢查之後插入：

```typescript
    // --help 在子指令之後同樣 spawn man viewer（git log --help ≡ git help log）
    if (rest.includes("--help")) {
      return ask(
        `git ${sub}：--help 會 spawn man viewer（可經 GIT_MAN_VIEWER 指定任意程式）`,
      );
    }
```

插入後該區塊順序為：`--ext-diff` → `--help` → `--output` → `git grep -O` → `scanRestArgs` → `READ_SUBCOMMANDS`。

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: PASS（全部測試）。

特別確認既有的 `git safe valueless global options allow with read subcommands` 仍 PASS——它不含 `--help`，不受影響。

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/git.ts src/rules/commands/git_test.ts
git commit -m "fix(rules): close --help paths equivalent to the excluded help subcommand

git --help <sub> and git <sub> --help both spawn a man viewer, which
GIT_MAN_VIEWER can point at an arbitrary program - the same external-execution
risk that keeps the help subcommand out of the allowlist. Drop --help from
SAFE_VALUELESS_GLOBAL and add a rest-level check.

-h is unaffected: it only prints usage to stdout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 交叉與回歸測試

新掃描刻意置於 `git grep -O` 檢查之後、`switch` 之前。這兩個順序決策各有必須守住的性質，需要測試釘住：`git grep -O` 的 ask 理由不能被新檢查搶走（語義不同：那是 `--open-files-in-pager`，不是 orderfile），而 `switch` 中的 gated 子指令雖然也受掃描，其既有 allow 形式不能被誤殺。

**Files:**
- Modify: `src/rules/commands/git_test.ts`（含 import 追加 `assertStringIncludes`）

- [ ] **Step 1: 追加 `assertStringIncludes` 匯入**

把 `src/rules/commands/git_test.ts:1` 的：

```typescript
import { assertEquals } from "@std/assert";
```

改為：

```typescript
import { assertEquals, assertStringIncludes } from "@std/assert";
```

- [ ] **Step 2: Write the tests**

在 `src/rules/commands/git_test.ts` 檔尾追加：

```typescript
// ── 本次新增：交叉與回歸 ──────────────────────────────────────────────────

Deno.test("git grep -O keeps its pager reason (new scan must not preempt)", () => {
  const r = gitRule.evaluate(ctxOf("git grep -O pager foo"));
  assertEquals(r.kind, "ask");
  assertStringIncludes(r.kind === "ask" ? r.reason : "", "pager");
});

Deno.test("switch-gated subcommands are also covered by the new scan", () => {
  assertEquals(v("git branch $NAME"), "ask"); // 動態 token，掃描先於 switch
  assertEquals(v("git stash list"), "allow"); // 既有 allow 形式不被誤殺
  assertEquals(v("git remote -v"), "allow");
  assertEquals(v("git branch"), "allow");
});

Deno.test("global gates still apply to newly added subcommands", () => {
  assertEquals(v("git -c core.pager=cat merge-base HEAD main"), "ask");
  assertEquals(v("git --exec-path=/tmp rev-list HEAD"), "ask");
  assertEquals(v("git --unknown-global merge-base HEAD main"), "ask");
  assertEquals(v("git --config-env=core.pager=EVIL diff-tree HEAD"), "ask");
});

Deno.test("newly added diff-family subcommands still honor existing rest gates", () => {
  assertEquals(v("git diff-tree --ext-diff HEAD"), "ask");
  assertEquals(v("git range-diff --output=x a..b c..d"), "ask");
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/git_test.ts`

Expected: PASS。

這些測試預期**一次就通過**（Task 1-4 已提供全部行為）；它們的價值是把順序決策釘住，防止日後重排檢查順序時無聲破壞。若有任何一條 FAIL，代表 Task 1-4 的接點順序寫錯了，回頭修正而非改測試。

- [ ] **Step 4: 執行完整測試套件**

Run: `deno task test`

Expected: 全綠（含 `main_test.ts` 子行程 e2e）。

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/git_test.ts
git commit -m "test(rules): pin git rule check ordering and gate interactions

Locks in two ordering decisions: the new rest scan runs after the grep -O
check (so grep keeps its pager reason) and before the switch (so gated
subcommands are scanned without their existing allow forms regressing).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 文件同步 + build + operational verification

單元測試通過不等於 binary 行為正確。本專案的規則變更**必須**餵 JSON 給編譯後的 binary 驗證真實行為。

**Files:**
- Modify: `CLAUDE.md`（兩處：子指令型規則說明、安全誤放攻擊面列舉）

- [ ] **Step 1: 更新 CLAUDE.md 的子指令 allowlist 說明**

在 `CLAUDE.md` 的「一律 allowlist 優先於 denylist」段落中，找到以 **子指令型**（git / gh） 開頭的項目：

```markdown
- **子指令型**（git / gh）：維護「唯讀子指令集合」，集合內才 allow、其餘 ask（見 `git.ts` / `gh.ts`）。
  全域選項同理：未知全域選項一律 ask（見 `git.ts` 的全域選項 allowlist）。
```

替換為：

```markdown
- **子指令型**（git / gh）：維護「唯讀子指令集合」，集合內才 allow、其餘 ask（見 `git.ts` / `gh.ts`）。
  全域選項同理：未知全域選項一律 ask（見 `git.ts` 的全域選項 allowlist）。
  `git.ts` 的 `READ_SUBCOMMANDS` 現含 30 個子指令（porcelain 15 + plumbing 15），涵蓋
  `merge-base` / `rev-list` / `name-rev` / `var` / `diff-tree`·`diff-files`·`diff-index` /
  `check-ignore`·`check-attr`·`check-ref-format` / `whatchanged` / `range-diff` / `cherry` /
  `count-objects` / `annotate` / `version` 等。**刻意排除**（維持 ask）：`ls-remote`（發網路請求、
  可接任意 URL，不受 curl domain allowlist 管轄）、`help` 與 `verify-commit`·`verify-tag`
  （spawn man / browser / gpg）、以及有寫入形式需個案 gate 的 `symbolic-ref` / `worktree` /
  `submodule` / `notes` / `bisect` / `merge-tree`。
```

- [ ] **Step 2: 更新 CLAUDE.md 的攻擊面列舉**

在「⚠️ 不要再犯的問題 → 安全誤放」段落中，找到以 **git / gh 全域選項是攻擊面** 開頭的項目，在其危險旗標列舉中把 `--ext-diff` 之後補上 `--help`。接著在該項目之後新增一個同層級的項目：

```markdown
- **git 子指令後的引數也是攻擊面**：`git.ts` 的 `scanRestArgs` 走訪子指令之後、`--` 之前的引數：
  動態 token（`git log $ref`）一律 ask——靜態分析無法排除它展開成旗標，放行等於讓旗標檢查可被單一
  變數繞過；`-O <file>` / `-O<file>`（orderfile）會被 git 實際讀取，須 `resolvePathValue` 範圍檢查。
  `--help`（無論在全域位置或子指令之後）等同 `git help`，會 spawn man viewer（`GIT_MAN_VIEWER`
  可指定任意程式）→ ask；`-h` 只印用法，不受影響。
```

- [ ] **Step 3: Build**

Run: `deno task build`

Expected: 產出 `dist/permission-checker`（macOS / Linux）或 `dist/permission-checker.exe`（Windows），無錯誤。

- [ ] **Step 4: Operational verification**

依序執行以下五條，每條都要確認 `permissionDecision` 與 `exit 0`。`$PWD` 需為本專案根目錄。

```bash
probe() {
  printf '%s' "$1" | CLAUDE_PROJECT_DIR="$PWD" ./dist/permission-checker
  echo " (exit=$?)"
}

# 1) 本次的目標指令 → 期望 allow
probe '{"tool_name":"Bash","tool_input":{"command":"git status; git diff --staged --stat; git log -30 --oneline; git branch --show-current; git merge-base HEAD main; git rev-parse --abbrev-ref @{upstream}"},"cwd":"'"$PWD"'"}'

# 2) -O 缺口已補 → 期望 ask
probe '{"tool_name":"Bash","tool_input":{"command":"git diff -O/etc/passwd HEAD~1 HEAD"},"cwd":"'"$PWD"'"}'

# 3) 排除的網路子指令 → 期望 ask
probe '{"tool_name":"Bash","tool_input":{"command":"git ls-remote origin"},"cwd":"'"$PWD"'"}'

# 4) 動態 token 收緊生效 → 期望 ask
probe '{"tool_name":"Bash","tool_input":{"command":"git log $ref"},"cwd":"'"$PWD"'"}'

# 5) --help 封堵生效 → 期望 ask
probe '{"tool_name":"Bash","tool_input":{"command":"git --help log"},"cwd":"'"$PWD"'"}'
```

Expected：第 1 條 `"permissionDecision":"allow"`；第 2-5 條 `"permissionDecision":"ask"`；五條皆 `exit=0`。

**若第 2-5 條中任一條回 `allow`，先讀 `permissionDecisionReason`**：若理由為「命中 permissions.allow」，代表該指令被使用者 settings.json 的廣域規則（如 `Bash(git diff *)`）升級了——這是本專案刻意的設計行為（指令規則自身的 ask 屬**可升級** ask），**不是 bug**，以單元測試為準。若理由並非升級所致，則是真正的 regression，回頭檢查對應 Task 的接點順序。

- [ ] **Step 5: 最終完整驗證**

Run: `deno task check && deno task lint && deno task test`

Expected: 三者全綠。

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md with expanded git allowlist and rest-argument scanning

Records the 30-subcommand READ_SUBCOMMANDS set with its deliberate exclusions,
plus the new attack surface notes: dynamic tokens after a git subcommand,
-O orderfile scope checking, and --help spawning a man viewer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 完成標準

- `deno task check`、`deno task lint`、`deno task test` 全綠。
- Operational verification 五條全部符合預期（或 `allow` 已確認為 `permissions.allow` 升級所致）。
- 既有測試零修改（若有轉紅，停下確認是否為非預期的行為變更）。
- `CLAUDE.md` 兩處皆與實作一致。
- 每個 commit 都是安全的中間狀態：`-O` 防護先於 allowlist 擴充落地。
