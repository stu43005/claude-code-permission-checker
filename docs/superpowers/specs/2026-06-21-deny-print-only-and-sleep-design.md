# 設計規格：對「整鏈 print-only 偽裝驗證」與「sleep 輪詢等待」回 `deny`

- 日期：2026-06-21
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部
落在當前專案內」時回 `allow`，其餘回 `ask`。目前 `deny` 僅用於**單一類別**——「遞迴遍歷磁碟根/
家目錄根的唯讀指令」（見 2026-06-14 規格），且 deny 為**硬性**：`classify` 在 builtin 回 `deny`
時短路返回，**不經** `permissions.allow` 升級層。

### 1.1 痛點

兩種 agent 行為違反使用者全域規則（CLAUDE.md），但目前不會被 hook 主動阻擋：

1. **print-only 偽裝驗證**：agent 用 `echo "結論是 X 因為 Y"`、`printf "分析：...\n"`、
   `cat <<EOF ... EOF` 等指令，把**事先寫死的結論**用機器口吻吐到 stdout，偽裝成「電腦跑出來的
   驗證結果」。這類指令沒有任何讀檔 / 計算 / 真實驗證，內容完全由 agent 預先決定——等同把腦中的
   推論換個格式轉述。目前 `echo` 一律 `allow`、`printf` 為 `ask`、`cat <<EOF` 為 `allow`。
2. **sleep 輪詢等待**：agent 用 `sleep N`（常配合 `echo waiting` 或迴圈）主動輪詢 / 等待背景工作。
   CLAUDE.md 明文禁止 Bash 輪詢（背景工作完成時 harness 會自動以 `task-notification` 喚醒）。
   目前 `sleep` 不在 allowlist → `ask`，仍可被人為批准或被 `permissions.allow` 升級為 `allow`。

使用者要求：**這兩類行為直接 `deny`（硬性、不可由 `permissions.allow` 解除），並把禁止原因回饋
給 agent**，讓 agent 理解為何被擋、改用正確做法（直接在回覆中陳述結論 / 實際讀檔跑測試 /
用 `ScheduleWakeup` 排程喚醒）。

### 1.2 核心設計約束（經使用者逐項確認）

1. **封鎖強度＝硬 deny、不可解除**：與既有遞迴根 deny 同級，優先序 `deny > ask > allow`，
   `permissions.allow` 無法解除。
2. **print-only 觸發條件＝整鏈皆 print 形態**：只有當「**這一次 hook 呼叫的整條指令鏈，每一個葉
   指令都是 print 形態**」時才 deny。只要鏈中混有任何一個真實指令（`make`、`cat file`、`grep`…），
   就**不**阻擋。此設計刻意排除「排版 / 狀態標記 echo」的誤判（如 `make && echo DONE`）。
3. **print-only 涵蓋形式**：`echo` 靜態字串、`printf` 靜態字串、`cat`/`tac` 讀 heredoc/here-string。
   **不含** heredoc 寫檔（`cmd > file << EOF`，仍維持既有 `ask`）。
4. **行為檢查 carve-out**：CLAUDE.md 判準一明許「驗證工具/直譯器本身行為」的合法用途
   （`printf "%05d\n" 42`、`echo -e "a\tb"`）。這類**不算 print 形態**，自然落回既有 classify。
5. **sleep＝獨立指令 rule、無條件 deny**：sleep 不輸出任何東西，不適合塞進 print 形態謂詞。改為
   獨立 `CommandRule`，**只要鏈中出現 `sleep` 就 deny**，不受「整鏈 print」聚合閘約束、不論引數
   與前後文（`sleep 5 && make` 也擋）。

### 1.3 已查證的事實（unbash 3.0.0 解析行為，實機 `parse()` 驗證，信心度：高）

1. **Heredoc（`<<` / `<<-`）**：解析為 `Redirect`，`operator: "<<"`、`target` 為**分隔符 Word**
   （如 `{value:"EOF"}`，**非** body）、body 文字置於 **`content`（string）**、`body` 欄位為
   `undefined`。`heredocQuoted` 在未加引號分隔符（`<<EOF`）時為 `undefined`，引號分隔符
   （`<<'EOF'`）時為 `true`。
   - 推論：未加引號 heredoc 的 `content` 可能內含 `$var` / `$(...)`（以原始字串形式存在，**未**被
     結構化成 WordPart）；要判斷 body 是否靜態，須**詞法掃描 `content` 字串**是否含 `$` / 反引號。
2. **Here-string（`<<<`）**：解析為 `Redirect`，`operator: "<<<"`、`target` 為**實際字串 Word**
   （`<<<"literal"` → target.value `"literal"`、含 DoubleQuoted part；`<<<"$VAR"` → target 含
   SimpleExpansion part）、`content` 為同字串。故 here-string 的靜態性可直接用 `isStatic(target)`。
3. **printf**：format 字串為 `suffix[0]`；`printf '%05d\n' 42` → suffix[0] 為 SingleQuoted Word
   （`isStatic` 為真、`value` 保留字面 `"%05d\\n"`），suffix[1] 為 `42`。
4. **`<<` / `<<-` / `<<<` 皆非 write redirect**：`redirect.ts` 的 `WRITE_OPERATORS` 僅含
   `>`,`>>`,`>|`,`&>`,`&>>`,`<>`；heredoc/here-string 輸入重導向不在內。`cat > f << EOF` 的 `>`
   才會被 `hasWriteRedirect` 判為寫檔。
5. **既有 `word.ts` 已把展開/glob 歸為動態**：`BraceExpansion`/`ExtendedGlob`/`ArithmeticExpansion`/
   `SimpleExpansion`/`ParameterExpansion`/`CommandExpansion`/`ProcessSubstitution` 與未加引號 glob
   字元 → `isStatic` 為假。故 `echo {1..5}`、`echo *.txt`、`echo $((1+2))`、`echo "$(cmd)"`、
   `printf "%s" "$VAR"` **本就非全靜態 → 自動不算 print 形態**，carve-out 無須為其特例。

### 1.4 已查證的 Claude Code 語意（沿用 2026-06-14 §1.3，信心度：高）

`PreToolUse` hook 的 `permissionDecision: "deny"` 會**阻止該工具呼叫**並把
`permissionDecisionReason` **回饋給模型（agent 可見）**，優先序 `deny > ask > allow`。故 deny 理由
**必須**包含三要素：① 被禁止的事、② 為何禁止、③ 可行的替代做法。

### 1.5 威脅模型與強制邊界（明確界定 deny 的完整性，避免「漏堵即漏放行」誤解）

本功能是疊加在**預設安全（default-safe）顧問式 hook** 上的**額外 deny 層**：它把使用者列舉的常見
直接偽裝形式硬 deny，但**不追求攔截所有可能的繞道**——任何「未被新 deny 命中」的形式都退回既有
classify 的 allow/ask 判定。完整性界定如下：

1. **walk() 已攤平、因而被聚合閘涵蓋的執行構造**（這些 print 形態構造會被正確 deny）：
   subshell `( … )`、brace group `{ …; }`、pipeline `a | b`、`&&` / `||` 序列、`;` 序列、
   command substitution `$( … )` / 反引號、process substitution。例：`(echo fake)`、
   `{ echo a; echo b; }`、`echo a && echo b` 皆會被聚合 deny。
2. **walk() 不深入、因而不在 print-only 閘範圍的構造**（其葉指令交既有 classify）：
   - **巢狀直譯器字串**：`bash -c '…'`、`sh -c '…'`、`eval '…'`、`source`/`.`、`python -c`、
     `perl -e`、`node -e` 等——其字串引數**不被 walk 解析**。葉指令名（`bash`/`eval`/`python`…）
     **皆不在 allowlist → `ask`**，永不靜默 allow。屬**刻意接受、已記錄**的繞道（agent 仍會被
     ask 攔下、需人工確認），非本功能保證範圍。
   - **heredoc body 內的命令替換**：unbash 把 `<<`/`<<-` 的 body 放在 `content`（原始字串、
     **未**結構化為 WordPart），walk 只列舉 `redirect.target`（對 `<<` 是分隔符、非 body），故
     **不會列舉 heredoc body 內的 `$( … )`**。§4.6 新增中央前置規則把**動態 body 的
     heredoc/here-string 從既有 allow 收緊為 `ask`**（見下）。
     > **使用者確認的取捨（2026-06-21）**：此 `ask` 為**可升級**——若使用者於 settings.json 有
     > `Bash(cat *)` 等廣域 allow，含命令替換的 heredoc body 仍可能被升級為 allow（命令替換在
     > cat 執行時會跑、且 walk 未檢查內層）。使用者**明確選擇維持可升級 ask**（不硬 deny 命令替換
     > heredoc），優先保留設計簡潔。此為**已知、刻意接受**的殘留風險：未設 `Bash(cat *)` 時落
     > ask（需人工確認），設了才可能 allow——屬使用者自負的 settings 設定風險。
3. **零葉指令（no-op）**：parse 後無可執行指令 → 既有 allow（no-op）。零指令即「什麼都不執行」、
   無從偽裝，維持 allow 安全。
4. **sleep 強制邊界＝裸 `sleep` token**（使用者明確決定）：等價等待原語
   （`bash -c 'sleep'`、`python -c 'time.sleep'`、`perl -e 'sleep'`、`read -t`、`tail -f`、
   `while …; do …; done` 計時迴圈）**不**在 sleep rule 範圍；它們皆非 allowlist 指令 → `ask`，
   屬**刻意接受、已記錄**的邊界（落 ask 非 allow）。本功能不追求攔截所有等待原語。
5. **「整鏈 print」閘的洗白繞道（使用者確認維持原設計，2026-06-21）**：聚合閘要求**每個**葉指令
   皆 print 形態才 deny，故只要鏈中夾一個非 print 指令即不擋。可被以下方式繞過：
   - **瑣碎 no-op 前綴**：`pwd; echo "假報告"`、`true && echo "已驗證"`、`: ; printf "通過"`
     （pwd/true/: 非 print 形態 → 非全鏈 print → 不 deny，落該真實指令的 ask/allow）。
   - **真實讀取洗白**：`cat README.md; printf "已驗證..."`（cat 讀真檔 → 非全鏈 print → 不 deny）。
   > **使用者確認的取捨**：使用者**明確選擇維持「整鏈 print 才擋」的乾淨結構規則**，以避免誤殺
   > 合法狀態標記（如 `make && echo DONE`、`deno task test && echo PASS`）。代價是上述洗白繞道
   > **不被 deny**——屬**已知、刻意接受**的限制。理由：偵測「真實指令是否只為洗白假報告」屬意圖
   > 判定、無法由結構可靠區分；偏向零誤殺優於追求完整封堵（符合「誤 ask 可接受、誤 allow 不可
   > 接受」，且這些繞道最差落該真實指令既有判定，多為 ask）。

**一句話總結**：本功能把使用者列舉的**常見直接形式**（裸 echo/printf/cat-heredoc 鏈、裸 sleep）
硬 deny；對巢狀 / 等價 / 洗白繞道**不保證 deny**。其中多數最差落 ask；**唯一**可能落 allow 的殘留
路徑是「含命令替換的 heredoc body + 使用者自設 `Bash(cat *)` 廣域 allow」（point 2 取捨）。以上皆為
使用者確認、刻意接受的取捨，優先保留設計簡潔與零誤殺。

## 2. 目標與非目標

### 2.1 目標

- 把 deny 從「僅遞迴根掃描」擴張為**三類**：(1) 遞迴根掃描（既有，不動）、(2) 整鏈 print-only
  偽裝（新增）、(3) sleep 輪詢（新增）。
- 新增 `src/engine/print_only.ts`：提供單指令謂詞 `isPrintOnlyForm(inv)` 與聚合判斷
  `isAllPrintOnly(invocations)`，集中所有 print 形態判定與 carve-out。echo/printf 的靜態性判定採
  **command-substitution-aware 的 `wordPrintEligible`**：靜態、或唯一動態成分為 `$( … )` 的字皆
  視為合格——配合「聚合 every() 涵蓋所有葉指令（含替換內層）」，可堵住 `echo "$(echo fake)"` 這類
  以命令替換包裝靜態文字的偽裝（見 §4.1.4）。
- 在 `src/engine/classify.ts` 新增**第 4 條中央前置規則**：帶**動態 body** 的 heredoc/here-string
  從既有 allow 收緊為 `ask`（walk 不解析 heredoc body 內的替換，此為盲點）。此 ask **可升級**
  （使用者確認維持，非硬 deny；殘留風險見 §1.5 point 2）。
- 在 `src/engine/evaluate.ts` walk 之後、classify 之前插入聚合 print-only 閘：整鏈 print → 直接
  回 `deny`（在 classify 前返回 → 天生硬性、不過 `settingsAllows`）。
- 新增 `src/rules/commands/sleep.ts`：`CommandRule` 無條件 `deny`，於 `allowlist.ts` 註冊；經
  既有 `classify.ts` 的 builtin-deny 短路而硬性、不可解除。
- 新增兩個 deny 理由 helper（與 `recursiveRootDenyReason` 並列於 `src/rules/types.ts`）：
  `printOnlyDenyReason()`、`pollingDenyReason()`。
- 全程 fail-safe：`isPrintOnlyForm` 任何不確定一律回 `false`（→ 不貢獻全鏈 print → 不誤 deny）；
  `evaluate` 既有 try/catch 仍把例外收斂成 `ask`；永遠 `exit 0`。

### 2.2 非目標（YAGNI，刻意排除）

- **不**偵測 heredoc 寫檔（`cmd > file << EOF`）為新 deny：維持既有 `ask`（寫入型重導向中央前置
  規則）。兩步偽裝 `cat > /tmp/x << EOF ... && cat /tmp/x` 因「寫檔半段 ask + 讀回專案外 ask」
  整體已是 `ask`，本功能不升級為 deny。
- **不**為「整鏈 print 但其中夾雜一個合法行為檢查」的鏈 deny（如 `printf "%05d" 42 && echo X`：
  printf 屬 carve-out → 非全鏈 print → 不 deny）。一個合法行為檢查即保護整鏈，安全方向、可接受。
- **不**改 `walk.ts` / `CommandInvocation` 結構（不新增 pipe-context 欄位）：聚合「整鏈 print」
  天然涵蓋 pipe 情境（`echo x | grep y` 中 grep 非 print 形態 → 非全鏈 print → 不 deny）。
- **不**處理 print-laundering（`echo x | cat`：cat 無 heredoc → 非 print 形態 → 不 deny）。罕見、
  可接受的弱點。
- **不**偵測迴圈語意的 sleep（`while … sleep …`）為特例：sleep 一律無條件 deny，迴圈與否不影響。
- **不**動既有的寫入重導向 / 賦值前綴 / 非唯讀指令偵測；**只新增 deny，不放寬任何既有判定**。
- **不**引入快取、**不**讀 enterprise managed-settings。

## 3. 架構與資料流

新增邏輯掛在兩處：`evaluate` 的聚合 print-only 閘、與 sleep 的 per-command rule。parse / walk
職責不變。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → walk → invocations[]
       ├─ invocations.length === 0 → allow（既有 no-op，不變）
       ├─ isAllPrintOnly(invocations) → deny(printOnlyDenyReason())   （新增；classify 前短路）
       └─ combine(invocations.map(classify))                          （既有）
             └─ classify → classifyBuiltin
                   ├─ 中央前置規則 #4：動態 body heredoc/here-string → ask  （新增；見 §4.6）
                   └─ CommandRule.evaluate
                         sleepRule.evaluate → deny(pollingDenyReason()) （新增；builtin-deny 短路）
```

### 3.1 為何 print-only 放 `evaluate` 聚合層、sleep 放 per-command rule

- **print-only 是跨指令聚合決策**（「整鏈每個指令都 print 才擋」），單一 `CommandRule` 看不到兄弟
  指令，故放 `evaluate`（方案 A，經使用者確認）。
- **sleep 是單指令無條件決策**（「只要出現就擋」，不看兄弟指令），最自然的位置就是 per-command
  rule，且能直接複用 `classify.ts:61` 既有 builtin-deny 短路，零新增短路邏輯。

### 3.2 兩類 deny 不衝突

- 整鏈 print 的鏈不可能含 sleep（sleep 非 print 形態 → 含 sleep 的鏈必非全鏈 print → 走 classify
  → sleepRule deny）。
- `evaluate` 聚合 deny 與 `combine` 內 deny 都產出 `deny`，最終皆 `deny`，無優先序衝突。

## 4. 詳細設計

### 4.1 `src/engine/print_only.ts`（新檔）

```ts
import type { CommandInvocation } from "../types.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { isStatic, staticValue } from "./word.ts";

/** 整鏈聚合：至少一個指令、且每個葉指令皆 print 形態 → 視為 print-only 偽裝。 */
export function isAllPrintOnly(invocations: CommandInvocation[]): boolean {
  return invocations.length > 0 && invocations.every(isPrintOnlyForm);
}

/** 單一葉指令是否為「靜態吐字」形態（echo / printf / cat·tac heredoc）。 */
export function isPrintOnlyForm(inv: CommandInvocation): boolean {
  // 共同前置：任一成立 → 不算 print 形態（保守不擋）
  if (inv.name === null) return false;                 // 動態指令名 → 本就 ask
  if (hasWriteRedirect(inv.redirects)) return false;   // 有寫檔副作用 → 非純輸出
  if (inv.assignments.length > 0) return false;        // var=val 前綴 → 可能改變執行

  switch (inv.name) {
    case "echo":   return isEchoPrintOnly(inv);
    case "printf": return isPrintfPrintOnly(inv);
    case "cat":
    case "tac":    return isCatPassthrough(inv);
    default:       return false;
  }
}
```

#### 4.1.1 `echo`

```ts
function isEchoPrintOnly(inv: CommandInvocation): boolean {
  for (const w of inv.argv) {
    if (!wordPrintEligible(w)) return false;           // 含變數/glob/算術等非替換動態 → 排除
    const v = staticValue(w);                           // 替換型 word 的 staticValue 為 null
    if (v !== null && /^-[neE]*[eE][neE]*$/.test(v)) return false; // carve-out：-e/-E 跳脫旗標
  }
  return true;
}
```

- 所有 argv 須 `wordPrintEligible`（靜態、或唯一動態成分為命令替換 `$( … )`）；任一含 `-e` / `-E`
  （跳脫詮釋旗標）即 carve-out → 非 print 形態（落回 echo 既有 `allow`）。`-n`（僅抑制換行）**不**算
  carve-out。
- `echo`（無引數）→ argv 空 → 通過 → print 形態。
- **替換包裝偽裝**：`echo "$(echo fake)"` → 外層 echo 的字僅替換動態 → 合格；又因聚合 `every()`
  涵蓋替換內層葉指令（inner `echo fake` 亦為 print 形態）→ 整鏈全 print → **deny**。對照
  `echo "$(date)"` → inner `date` 非 print 形態 → 非全鏈 print → 不 deny（落 classify，date 非
  allowlist → ask）。`echo "$VAR"` → 變數非替換 → 不合格 → 非 print 形態 → 不 deny。

#### 4.1.2 `printf`

```ts
function isPrintfPrintOnly(inv: CommandInvocation): boolean {
  for (const w of inv.argv) if (!wordPrintEligible(w)) return false; // 非替換動態 → 排除
  // 取第一個非 "--" 的位置參數作為 format
  const fmtWord = inv.argv.find((w) => staticValue(w) !== "--");
  if (!fmtWord) return true;                                  // 無 format（如僅 "--"）→ 視為純輸出
  const fmt = staticValue(fmtWord);                           // 替換型 format → null
  if (fmt !== null && hasConversionSpec(fmt)) return false;   // carve-out：靜態 format 含轉換符 → 行為檢查
  return true;                                                // format 為替換型（無法檢查轉換符）→ 視為純輸出
}

/** format 是否含真實轉換符（%d/%s/%f/…），排除字面 %%。 */
function hasConversionSpec(fmt: string): boolean {
  const stripped = fmt.replace(/%%/g, "");
  return /%[-+ 0#]*[0-9.*]*[diouxXeEfFgGaAcsbq]/.test(stripped);
}
```

- 含轉換符（`printf "%05d\n" 42`）→ carve-out → 非 print 形態 → 落回（printf 不在 allowlist）`ask`。
- 無轉換符（`printf "結論：x\n"`、`printf "%%done\n"`）→ print 形態。

#### 4.1.3 `cat` / `tac`（heredoc / here-string passthrough）

```ts
function isCatPassthrough(inv: CommandInvocation): boolean {
  // 必須有 heredoc/here-string 輸入，且無檔案操作元
  const heredocs = inv.redirects.filter((r) =>
    r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<"
  );
  if (heredocs.length === 0) return false;                    // 無 heredoc → 非 passthrough（一般 cat 讀檔另論）
  if (hasFileOperand(inv.argv)) return false;                 // 有檔案操作元 → 讀真實檔，非純吐字
  return heredocs.every(isHeredocStatic);                     // 所有 heredoc body 須靜態
}

/** argv 是否含「非旗標位置參數」（檔名）；動態 token 也保守視為可能的檔名。 */
function hasFileOperand(argv): boolean {
  return argv.some((w) => {
    const v = staticValue(w);
    return v === null || !v.startsWith("-");
  });
}

/** heredoc/here-string body 是否靜態（無 $ / 反引號展開）。 */
function isHeredocStatic(r): boolean {
  if (r.operator === "<<<") {
    return r.target ? isStatic(r.target) : true;              // here-string：target 為實際字串 Word
  }
  // << / <<- ：body 在 content 字串；引號分隔符 → 必靜態；否則詞法掃 $ / 反引號
  if (r.heredocQuoted === true) return true;
  const content = r.content ?? "";
  return !/[$`]/.test(content);
}
```

- `cat <<EOF\nhello\nEOF` → 有 heredoc、無檔案操作元、body 靜態 → print 形態 → deny。
- `cat <<'EOF'\n$x\nEOF` → 引號分隔符 → body 視為靜態 → print 形態 → deny。
- `cat <<EOF\n$(rm x)\nEOF` → content 含 `$` → 非靜態 → 非 print 形態 → 落回既有 classify（不誤 deny
  真有命令替換的 heredoc）。
- `cat <<<"literal"` → here-string target 靜態 → print 形態 → deny；`cat <<<"$VAR"` → target 動態
  → 非 print 形態。
- `cat file` / `cat`（無 heredoc）→ `heredocs.length === 0` → 非 print 形態（一般讀檔由
  `fileReaderRule` 既有判定）。

> 型別取用：`Redirect.operator` / `target` / `content` / `heredocQuoted` 皆由 `src/deps.ts` 的
> `Redirect` 型別提供（見 §1.3）。`CommandInvocation.argv` 為 `Word[]`、`redirects` 為 `Redirect[]`。
> `isHeredocStatic` 與 `isHeredocDynamic`（其否定，見 §4.6）**export** 供 `classify.ts` 的第 4 條
> 中央前置規則重用，避免動態判定邏輯重複。

#### 4.1.4 `wordPrintEligible`（command-substitution-aware 靜態合格判定）

```ts
import type { Word, WordPart } from "../deps.ts";
import { isStatic } from "./word.ts";

/**
 * Word 是否「print 合格」：靜態，或其**唯一**動態成分為命令替換 $( … )。
 * 變數展開（Simple/Parameter）、算術、brace、未引號 glob、process substitution → 不合格。
 * 配合聚合 every()（替換內層葉指令亦各自受 isPrintOnlyForm 檢查），可堵替換包裝偽裝，
 * 又不誤殺 echo "$(realcmd)"（內層 realcmd 非 print 形態 → 整鏈非全 print → 不 deny）。
 */
export function wordPrintEligible(w: Word): boolean {
  if (isStatic(w)) return true;
  if (!w.parts) return false;
  return w.parts.every(partPrintEligible);
}

/** 動態成分只允許 CommandExpansion；DoubleQuoted/LocaleString 遞迴檢查內層。 */
function partPrintEligible(p: WordPart): boolean {
  if (p.type === "CommandExpansion") return true;          // $( … ) / 反引號
  if (p.type === "Literal") return true;                   // 字面（含被引號保護的 glob）
  if (p.type === "SingleQuoted" || p.type === "AnsiCQuoted") return true;
  if (p.type === "DoubleQuoted" || p.type === "LocaleString") {
    return p.parts.every(partPrintEligible);
  }
  return false;                                             // Simple/Parameter/Arithmetic/Brace/ExtGlob/ProcSubst
}
```

> 註：`partPrintEligible` 對頂層未引號 `Literal` 一律 true（不再詞法擋 glob）——但 `wordPrintEligible`
> 已先 `isStatic(w)` 短路靜態字（含詞法 glob 判定）；走到 parts 迴圈者必含至少一個展開類 part，
> 未引號 glob 的純字面 Word 無 parts、已由 `isStatic` 涵蓋，故不漏。implementer 若不確定，可改以
> `word.ts` 既有 `topPartIsDynamic` 為基礎，僅把 `CommandExpansion` 從「動態」名單豁免；兩種寫法
> 等價，擇一即可（測試需涵蓋 §8 的 `echo "$(echo x)"` / `echo "a$VAR"` / `echo "a$(c)b"` 案例）。

### 4.2 `src/engine/evaluate.ts`（聚合閘接線）

於既有 no-op 檢查之後、`combine(...)` 之前插入：

```ts
const invocations = walk(script, initialCwd, root);
if (invocations.length === 0) {
  return { verdict: "allow", reason: "無可執行指令（no-op）" };
}
if (isAllPrintOnly(invocations)) {
  return { verdict: "deny", reason: printOnlyDenyReason() };   // 新增：硬 deny，classify 前短路
}
return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
```

- 在 `classify` 之前返回 → 不經 `settingsAllows` → 硬性、`permissions.allow` 無法解除。
- 仍在既有 try/catch 內 → 任何例外退化為 `ask`。

### 4.3 `src/rules/commands/sleep.ts`（新檔）

```ts
import type { CommandRule } from "../types.ts";
import { deny } from "../types.ts";
import { pollingDenyReason } from "../types.ts";

export const sleepRule: CommandRule = {
  names: ["sleep"],
  evaluate: () => deny(pollingDenyReason()),
};
```

- 無條件 deny，不看 argv / 前後文。
- 經 `classify.ts:61`（`if (v.kind === "deny") return v;`）短路 → 硬性、不過 `settingsAllows`。

### 4.4 `src/rules/allowlist.ts`（註冊 sleep）

匯入 `sleepRule` 並加入 `RULES` 陣列（name `sleep` 不可與既有重複；載入時偵測重複）。

### 4.5 deny 理由 helper（`src/rules/types.ts`）

與既有 `recursiveRootDenyReason` 並列。兩者皆含三要素（被禁止的事 / 為何禁止 / 替代）：

```ts
/** 整鏈 print-only 偽裝驗證的 deny 理由（回饋給 agent）。 */
export function printOnlyDenyReason(): string {
  return `已禁止：此指令鏈的每個指令都只是把靜態文字輸出到 stdout（echo / printf / cat heredoc），` +
    `未讀取任何檔案、未執行任何真實計算或驗證——內容完全由你事先寫死，等同把推論用機器口吻轉述、` +
    `偽裝成「電腦跑出來的結果」。若你已有結論，請直接寫在回覆文字中；若需驗證，請實際讀取檔案、` +
    `執行測試、或執行會產生真實副作用的指令，而非用 echo/printf/heredoc 重述寫死的內容。`;
}

/** sleep 輪詢 / 等待的 deny 理由（回饋給 agent）。 */
export function pollingDenyReason(): string {
  return `已禁止：sleep 用於輪詢 / 等待，本工具的唯讀情境下無正當用途，且背景工作完成時 harness ` +
    `會自動以 task-notification 重新喚醒你，不需主動等待。若需排程下次喚醒，請改用 ScheduleWakeup，` +
    `不要用 Bash sleep 輪詢。`;
}
```

- **反例（禁止）**：`deny("sleep 被禁止")`、`deny("print-only")`——只描述、未解釋、未給替代。

### 4.6 第 4 條中央前置規則：動態 body heredoc/here-string → `ask`（`src/engine/classify.ts`）

**動機（堵 walk 盲點）**：walk 把 `<<`/`<<-` 的 body 放在 `redirect.content`（原始字串、未結構化），
且只列舉 `redirect.target`（對 `<<` 是分隔符、非 body），故 **heredoc body 內的命令替換不被 walk
列舉、不會被任何指令規則檢查**。例：`cat <<EOF\n$(rm -rf x)\nEOF` 現況落 `allow`（cat 無位置參數 →
`fileReaderRule` allow），但 cat 執行時 body 內的 `$(rm -rf x)` 會真正執行。此為既有盲點；本功能
把它從 allow **收緊為 ask**（非完全封堵——見下「升級層互動」與 §1.5 point 2 之使用者確認取捨）。

**規則**：於 `classifyBuiltin` 既有三條中央前置規則**之後、個別 rule 之前**新增第 4 條：

```ts
// 中央前置規則之四：動態 body 的 heredoc/here-string（walk 無法檢查其內嵌替換）
if (inv.redirects.some(isHeredocDynamic)) {
  return ask(`${inv.name}：heredoc/here-string body 含未經檢查的展開或命令替換`);
}
```

其中（與 §4.1.3 `isHeredocStatic` 同檔、互為否定，自 `print_only.ts` export 重用）：

```ts
/** redirect 是否為「帶動態 body」的 heredoc/here-string。 */
export function isHeredocDynamic(r: Redirect): boolean {
  if (r.operator === "<<<") return r.target ? !isStatic(r.target) : false;
  if (r.operator === "<<" || r.operator === "<<-") {
    if (r.heredocQuoted === true) return false;            // 引號分隔符 → 無展開 → 靜態
    return /[$`]/.test(r.content ?? "");                   // 未引號且含 $ / 反引號 → 動態
  }
  return false;                                             // 非 heredoc/here-string
}
```

**與 print-only 閘的關係**：靜態 body 的 heredoc（`isHeredocStatic` true）若整鏈皆 print → 已在
`evaluate` 層 deny，不會走到此規則；動態 body → 非 print 形態 → 非全鏈 print → 進 classify → 此規則
→ `ask`。**只 ask、不 deny**：因為動態 heredoc 不必然是偽裝（可能是合法但含替換的輸入），保守交
人工確認即可（使用者確認維持可升級 ask、不硬 deny 命令替換 heredoc，見 §1.5 point 2）。

**順序與互動**：置於賦值前綴規則之後、`rule.evaluate` 之前；不影響既有寫入重導向規則
（`cat > f << EOF` 的 `>` 仍先被寫入重導向規則判 ask）。對 `permissions.allow` 升級層：此為 `ask`
（非 deny），命中 `permissions.allow` 仍可正常升級為 allow（與既有 ask 行為一致；使用者明示放行
某含 heredoc 指令時不被此規則永久擋住）。

## 5. 與 `permissions.allow` 升級層的互動

- **整鏈 print-only deny** 在 `evaluate` 層、`classify` 之前返回，根本不進入 `settingsAllows`：
  `permissions.allow`（如 `Bash(echo *)`）無法解除。
- **sleep deny** 經 `classify.ts` builtin-deny 短路（`v.kind === "deny"` 先於 `settingsAllows`）：
  `permissions.allow`（如 `Bash(sleep *)`）無法解除。
- 兩者皆符合「硬 deny、不可解除」，與既有遞迴根 deny 一致。

## 6. 不變量（改動後）

- **default-safe**：未明確判定安全唯讀者一律 `ask`；本功能只新增 deny，不改 allow/ask 對其餘指令
  的判定。
- **deny 三類**：(1) 遞迴遍歷磁碟根/家目錄根、(2) 整鏈 print-only 偽裝、(3) sleep 輪詢。優先序
  `deny > ask > allow`。
- **deny 漏判是安全的**：`isPrintOnlyForm` 任何不確定 → `false` → 不貢獻全鏈 print → 退回正常
  classify（allow/ask），**絕不**誤放行；sleep 名稱比對漏判 → 退回既有（不在 allowlist → ask）。
- **堵命令替換包裝的 allow 漏洞**：命令替換包裝偽裝（`echo "$(echo fake)"`，內外皆 print）由
  substitution-aware 謂詞 + 聚合 every() 升級為 deny（原為 allow）。
- **已記錄、使用者確認接受的殘留繞道（非本功能保證封堵範圍，見 §1.5）**：
  - 動態 body heredoc 由第 4 條中央前置規則從 allow 收緊為 **ask**，但此 ask **可被** `Bash(cat *)`
    等廣域 allow 升級——使用者選擇維持可升級 ask（不硬 deny 命令替換 heredoc）。
  - 「整鏈 print」閘的洗白繞道（`pwd; echo 假`、`cat README.md; printf 假`）**不 deny**——使用者
    選擇維持乾淨結構規則以零誤殺。
  - 巢狀直譯器 / 等價等待原語落 ask（非 allow）。
- **硬 deny 不可解除**：print-only 在 classify 前返回、sleep 經 builtin-deny 短路，皆不過
  `settingsAllows`。
- **永遠 `exit 0`、任何例外 → `ask`**（fail-safe 不變）。
- **只新增 deny，不放寬任何既有判定**：寫入重導向 / 賦值前綴 / 非唯讀指令偵測一律不動。

## 7. 行為對照表

| 指令 | 現況 | 之後 |
|---|---|---|
| `echo "結論是 X 因為 Y"` | allow | **deny**（整鏈 print） |
| `printf "分析：xxx\n"` | ask | **deny**（整鏈 print） |
| `cat <<EOF\n...\nEOF` | allow | **deny**（整鏈 print） |
| `cat <<<"literal"` | allow | **deny**（整鏈 print） |
| `echo a; echo b; echo c`（多行假報告） | allow | **deny**（整鏈 print） |
| `echo a && echo b` | allow | **deny**（整鏈 print） |
| `sleep 5` | ask | **deny**（sleep 無條件） |
| `sleep 5 && make` | ask（make 未列管） | **deny**（sleep 無條件） |
| `sleep 2; echo waiting` | ask | **deny**（sleep 無條件） |
| `make && echo BUILD_DONE` | ask（make 未列管） | ask（非全鏈 print；make 非 print） |
| `deno task test && echo PASS` | 視 settings | 不變（test 非 print → 非全鏈 print） |
| `cat README.md && echo ok` | allow/ask | 不變（cat README.md 非 passthrough） |
| `echo data \| grep x` | ask（grep 視範圍） | 不變（grep 非 print → 非全鏈 print） |
| `cat <<EOF...EOF \| python` | ask | 不變（python 非 print → 非全鏈 print） |
| `echo -e "a\tb"` | allow | allow（carve-out：跳脫旗標） |
| `printf "%05d\n" 42` | ask | ask（carve-out：含轉換符） |
| `echo {1..5}` / `echo *.txt` / `echo "$(date)"` | allow/ask | 不變（非全靜態 → 非 print 形態） |
| `echo x > file` | ask（寫入重導向） | ask（寫檔 → 非 print 形態） |
| `cat > /tmp/x << EOF...EOF` | ask（寫入重導向） | ask（寫檔 → 非 print 形態） |
| `FOO=1 echo x` | ask（賦值前綴） | ask（賦值 → 非 print 形態） |
| `echo "$(rm -rf /)"` | ask（內層 rm 範圍） | ask（echo 替換合格，但 rm 非 print → 非全鏈 print；rm 經 walk 列舉照判 ask） |
| `echo "$(echo fake)"` | **allow**（漏洞） | **deny**（替換包裝偽裝；內外皆 print） |
| `echo "$(date)"` | ask（date 非 allowlist） | ask（不變；date 非 print → 非全鏈 print） |
| `(echo fake)` / `{ echo a; echo b; }` | allow | **deny**（subshell/brace 已被 walk 攤平） |
| `cat <<EOF\n$(rm -rf x)\nEOF` | **allow**（漏洞） | ask（第 4 條中央規則）；註：`Bash(cat *)` 下可升級為 allow（§1.5 取捨） |
| `cat <<EOF\n$DATA\nEOF` | allow | ask（動態 heredoc body；可升級） |
| `pwd; echo "假報告"` / `true && echo "已驗證"` | allow/ask | ask/allow（**已記錄洗白繞道**：no-op 非 print → 非全鏈 print；§1.5 取捨） |
| `cat README.md; printf "已驗證"` | allow | allow（**已記錄洗白繞道**：cat 讀真檔 → 非全鏈 print；§1.5 取捨） |
| `bash -c 'echo fake'` / `eval 'echo fake'` | ask | ask（巢狀直譯器；已記錄繞道，落 ask 非 allow） |
| `python -c 'import time;time.sleep(5)'` / `read -t 5` / `tail -f x` | ask | ask（等價等待原語；已記錄繞道） |
| `find / -name x`（既有遞迴根） | deny | deny（不變） |

## 8. 測試需求

每個改動點需 allow / ask / **deny** 三面 + 邊界測試：

- `src/engine/print_only_test.ts`（新）：
  - `isAllPrintOnly` 整鏈 **deny**：`echo "結論"`、`printf "分析：x\n"`、`cat <<EOF\nx\nEOF`、
    `cat <<'EOF'\n$y\nEOF`、`cat <<<"x"`、`echo a; echo b`、`echo a && echo b`、`echo`（無引數）。
  - **對抗繞道 deny**（walk 已攤平的構造）：`(echo fake)`（subshell）、`{ echo a; echo b; }`
    （brace group）、`echo "$(echo fake)"`（替換包裝，內外皆 print）、`echo "pre $(echo x)"`。
  - 整鏈 print 閘**不** deny（含真實指令）：`make && echo DONE`、`cat f && echo ok`、
    `echo x | grep y`、`cat <<EOF\nx\nEOF | python`、`echo data | wc -l`、`echo "$(date)"`
    （inner date 非 print）、`echo "$(cat real)"`（inner cat 讀檔非 print）。
  - carve-out **不** deny：`echo -e "a\tb"`、`echo -ne "x"`、`printf "%05d\n" 42`、`printf "%s\n" "x"`。
  - 前置排除**不** deny：`echo x > f`（寫檔）、`cat > /tmp/x << EOF\nx\nEOF`（寫檔）、`FOO=1 echo x`
    （賦值）、`echo "$VAR"`（變數非替換 → 不合格）、`echo "a$VAR b"`（含變數）、`echo {1..5}`（brace）。
  - `wordPrintEligible` 邊界：`echo "$(c)"` 合格、`echo "a$(c)b"` 合格、`echo "$VAR"` 不合格、
    `echo "$(c)$VAR"` 不合格（混變數）、`echo <(cmd)`（process subst）不合格。
  - cat 邊界：`cat <<EOF\n$(cmd)\nEOF`（content 含 `$` → 非 print）、`cat <<<"$VAR"`（target 動態
    → 非 print）、`cat file`（無 heredoc → 非 print）、`cat -n <<EOF\nx\nEOF`（僅旗標、有 heredoc
    → print）。
  - printf 邊界：`printf "%%done\n"`（僅 `%%` → 無轉換符 → print）、`printf -- "結論\n"`（`--`
    後為 format → print）。
- `src/rules/commands/sleep_test.ts`（新；複製既有 `ctxOf` helper）：`sleep 1`、`sleep 0.5`、
  `sleep`（無引數）皆 **deny**；deny 理由含「已禁止」「ScheduleWakeup」「task-notification」關鍵字
  （驗證 §4.5 三要素措辭）。
- `src/engine/evaluate_test.ts`（若存在則補；否則併入 `classify_test.ts` / e2e）：整鏈 print →
  `verdict: "deny"`；`sleep 5 && make` → deny（經 classify）；`make && echo DONE` → 非 deny；
  整鏈 print 即使 rules 含 `Bash(echo *)` 仍 deny（驗證硬性不可解除）；`sleep 1` 即使 rules 含
  `Bash(sleep *)` 仍 deny。
- `src/engine/classify_test.ts`（第 4 條中央前置規則）：`cat <<EOF\n$(cmd)\nEOF` → ask、
  `cat <<EOF\n$DATA\nEOF` → ask、`cat <<'EOF'\n$x\nEOF`（引號 → 靜態 body，非此規則）、
  `cat <<<"$VAR"` → ask、`cat <<<"x"`（靜態，非此規則）；此 ask 命中 `Bash(cat *)` 可升級為 allow
  （驗證非 deny、可升級）。`isHeredocDynamic` 單元測試（`<<` 引號/未引號含 `$`/不含 `$`、`<<<`
  靜態/動態 target、非 heredoc operator）。
- **巢狀繞道落 ask（非 allow）測試**：`bash -c 'echo fake'`、`eval 'echo fake'`、
  `python -c 'time.sleep(5)'`、`read -t 5`、`tail -f x` → 皆 `ask`（非 allowlist；驗證 §1.5 邊界
  「最差落 ask」）。
- `src/rules/types_test.ts`（或併入 sleep/print_only 測試）：`printOnlyDenyReason()` /
  `pollingDenyReason()` 各含三要素（禁止字樣 / 原因 / 替代）。
- `src/main_test.ts`（e2e 子行程）：餵 `echo "結論是 X"` 期望 `permissionDecision: "deny"` 且
  `exit 0`；餵 `sleep 1` 期望 deny；餵 `make && echo DONE` 期望非 deny。

**Operational verification（build 後必做）**：

```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"echo \"結論是 X\""},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny、exit 0
echo '{"tool_name":"Bash","tool_input":{"command":"sleep 5"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny
echo '{"tool_name":"Bash","tool_input":{"command":"make && echo DONE"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望非 deny（ask）
```

## 9. 文件更新（`CLAUDE.md`）

- 開頭「這是什麼」段的 deny 描述：從「僅對遞迴遍歷磁碟根/家目錄根回 deny」改為**三類 deny**
  （遞迴根掃描、整鏈 print-only 偽裝、sleep 輪詢）。
- 「架構（評估管線）」段：補 `evaluate` 在 walk 後、classify 前的聚合 print-only 閘；補
  `print_only.ts` 模組職責；補 `sleep.ts` rule。
- 「三條中央前置規則」段：改為**四條**，補第 4 條「動態 body heredoc/here-string → ask」（walk
  盲點，從 allow 收緊為可升級 ask）。
- 補威脅模型 / 強制邊界（§1.5）：記錄使用者確認、刻意接受的殘留繞道——巢狀直譯器
  （`bash -c`/`eval`/`python -c`）與等價等待原語（`read -t`/`tail -f`）落 ask；「整鏈 print」閘的
  洗白繞道（`pwd; echo 假`、`cat file; printf 假`）不 deny；含命令替換的 heredoc body 為可升級 ask
  （`Bash(cat *)` 下可能 allow）。
- 「核心不變量」段：deny 三類、`isPrintOnlyForm` 漏判退回 classify（不誤放行）、print-only 在
  classify 前短路 / sleep 經 builtin-deny 短路皆硬性不可解除。
- 「hook 決策 vs settings.json 權限的優先序」段：補 print-only / sleep 兩類硬 deny 不可由
  `permissions.allow` 解除。

## 10. 變更檔案清單

| 檔案 | 變更 |
|---|---|
| `src/engine/print_only.ts` | 新檔：`isAllPrintOnly`、`isPrintOnlyForm`、`wordPrintEligible`、`isHeredocStatic`/`isHeredocDynamic`（export）及 echo/printf/cat 子判定 + carve-out |
| `src/engine/evaluate.ts` | walk 後、classify 前插入 `isAllPrintOnly` 聚合 deny 短路 |
| `src/engine/classify.ts` | `classifyBuiltin` 新增第 4 條中央前置規則：動態 body heredoc/here-string → ask |
| `src/rules/commands/sleep.ts` | 新檔：`sleepRule` 無條件 deny |
| `src/rules/allowlist.ts` | 註冊 `sleepRule` |
| `src/rules/types.ts` | 新增 `printOnlyDenyReason()`、`pollingDenyReason()` helper |
| `src/engine/print_only_test.ts` | 新檔：謂詞 + 聚合三面 + 邊界測試 |
| `src/rules/commands/sleep_test.ts` | 新檔：sleep deny + 理由測試 |
| `src/engine/evaluate_test.ts` 或 `classify_test.ts` | 聚合 deny / 硬性不可解除 / 第 4 條中央前置規則 / 巢狀繞道落 ask 測試 |
| `src/main_test.ts` | e2e：echo 結論 deny、sleep deny、make && echo 非 deny |
| `CLAUDE.md` | deny 三類、管線、不變量、優先序段更新 |
