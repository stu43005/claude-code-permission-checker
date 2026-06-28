# 設計規格：對「直譯器執行靜態-print payload 偽裝驗證」回 `deny`

- 日期：2026-06-28
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部落在
當前專案內」時回 `allow`，其餘回 `ask`，並對三類情形回**硬 `deny`**（不可由 `permissions.allow`
解除）：① 遞迴遍歷磁碟根/家目錄根的唯讀指令；② 整鏈 print-only 偽裝（echo/printf/cat-heredoc 靜態
吐字）；③ sleep 輪詢等待（見 2026-06-21 規格）。三類 deny 皆在 `evaluate` 層、`classify` 之前短路，
不經 `settingsAllows` 升級層。

### 1.1 痛點

本工具既有的「整鏈 print-only 偽裝」硬 deny（閘②）只攔截 **shell 層**的 echo/printf/cat-heredoc 靜態
吐字。但 agent 可改用**直譯器**達成同一偽裝——寫一段「整段只有 print 印死字串」的程式交給 node/python
執行，把事先寫死的結論用程式口吻吐到 stdout、偽裝成「跑出來的驗證結果」，而閘②看不到：

```bash
cat > /tmp/verify.mjs << 'EOF'
console.log("=== <某主題> 行為驗證 ===");
console.log("1. <步驟說明>：…（全部事先寫死的結論）");
console.log("結論：<寫死的是/否判斷>");
EOF
node /tmp/verify.mjs
```

這段腳本**整段只有 `console.log` 印死字串**——沒讀任何檔、沒跑任何真實計算或查證，內容完全由 agent
事先寫死，等同把推論用 `node` 轉述、偽裝成「程式跑出來的驗證」。常見變形還包括：把同樣的寫死內容塞進
註解、只在最後 `console.log("done")`；或改用 `-e`/`-c` inline、heredoc/pipe 餵 stdin。差別只在把吐字
載具從 shell 換成 JS/Python 直譯器。

### 1.2 目標案例現況（已實機驗證，信心度：高）

以 `evaluate()` 餵入下列指令（cwd 在專案根內）實測：

| 指令形態 | 現況 verdict | 現況原因 |
|---|---|---|
| `cat > /tmp/x.mjs <<'EOF' … EOF`＋`node /tmp/x.mjs`（目標案例） | `ask` | `cat：寫入型重導向`（中央前置、不可升級） |
| `cat > ./x.mjs <<'EOF' … EOF`＋`node ./x.mjs`（寫專案內） | `ask` | 同上 |
| `node -e 'console.log("x")'` | `ask` | 未列入 allowlist（**可被** `Bash(node *)` 升級為 allow） |
| `node <<'EOF' … EOF`（heredoc 餵 stdin） | `ask` | 同上 |
| `python -c 'print("x")'` | `ask` | 同上（可被 `Bash(python *)` 升級） |

**關鍵**：目標案例（單一 Bash 呼叫的整條 chain）目前已是**不可升級的 `ask`**（因 `cat >` 的寫入
重導向是不可升級中央前置 ask），故**不會誤放行**。但 inline `-e`/`-c`、heredoc-stdin、pipe-stdin 等
直接交付向量目前是**可升級的 ask**——使用者若設 `Bash(node *)`/`Bash(python *)` 即升級為 allow。
且所有這些形態目前都**得不到硬 deny 的教育性回饋**（不像裸 echo 鏈會被閘②擋下並告知 agent）。

### 1.3 使用者要求與逐項確認的設計約束

使用者要求：把「直譯器執行**全靜態-print** payload」這類偽裝**升級為硬 `deny`**（不可由
`permissions.allow` 解除），並把禁止原因回饋給 agent。經逐項確認：

1. **目標 verdict＝硬 deny**：與既有三類 deny 同級，`evaluate` 層短路、不經 `settingsAllows`。
2. **涵蓋範圍＝最廣（四向量）**：(A) inline 旗標 `-e`/`-c`/`deno eval`；(B) heredoc 餵 stdin；
   (C) 同鏈內「靜態寫腳本檔 → 用直譯器執行同檔」；(D) pipe 餵 stdin（`靜態生產者 | 直譯器`）。
3. **直譯器集合**：`node`、`nodejs`、`python`、`python3`、`deno`、`bun`、`ts-node`。
4. **carve-out＝極保守**：只有「**每一條有效敘述都是 `printfn(純字串/數字字面量)`**」才 deny；任何運算子
   /變數/函式呼叫/模板表示式/import/控制流/賦值 → **不 deny**（退回既有 ask）。寧可漏 deny（安全），
   絕不誤 deny。
5. **政策反轉（明確納入）**：本工具既有政策「巢狀直譯器＝預設 ask、可升級」對 **node/python/deno/bun/
   ts-node 這五者的全靜態-print 子集**改為硬 deny；其真實運算 payload 仍維持可升級 ask。**`bash -c`/
   `sh -c`/`eval`/`perl -e`/`source` 不在範圍**（維持既有可升級 ask）。

### 1.4 已查證事實

#### 1.4.1 直譯器旗標（research 實測）

版本：node v24.14.1、python 3.14.6、deno 2.9.0、bun 1.3.8、ts-node（官方文件）。

| 直譯器 | lang | inline eval | stdin 讀碼 | script 檔 |
|---|---|---|---|---|
| node / nodejs | js | `-e`/`--eval[=]<code>` | `-` 或無檔案位置參數 | 第一個非旗標位置參數 |
| python / python3 | py | `-c <code>`（其後選項終止） | `-` 或無參數 | 第一個非旗標位置參數 |
| deno | js | 子指令 **`deno eval <code>`**（非 `-e`） | `deno run -` | `deno run <file>` |
| bun | js | `-e`/`--eval[=]<code>` | `bun run -` | `bun <file>` / `bun run <file>` |
| ts-node | js | `-e`/`--eval <code>` | 管道（無旗標；未實機確認） | 第一個非旗標位置參數 |

- **副作用/預載旗標**（出現即「不可判定為純 print」，→ 跳過、不 deny）：node `-r`/`--require`/`--import`/
  `--env-file`；python `-m`/`-i`；deno `--preload`/`--require`/`--allow-*`/`-A`；bun `-r`/`--preload`/
  `--require`/`--import`。
- **value-flags**（解析時須正確吃掉其值，勿誤判為 script 位置參數）：各直譯器規則見 §4.2.1。
- `-p`/`--print` 的 payload 是**運算式**（非 `printfn(...)` 敘述），保守述詞天生不命中 → 不 deny
  （可接受的漏 deny）。本設計**不**特別處理 `-p`。

#### 1.4.2 unbash 4.0.1 解析行為（沿用 2026-06-21 規格，信心度：高）

1. 攤平後的 `CommandInvocation` 已帶 **`redirects`（含繼承的寫入 target 與 heredoc body/content）**
   與 **`argv`（suffix）**、**`assignments`（prefix）**、**`cwd`**。故「同葉指令的寫入重導向＋heredoc
   body」「直譯器葉指令的旗標/位置參數」皆可由 `CommandInvocation[]` 直接取得，**vectors A/B/C 不需改
   `walk.ts`**。
2. heredoc：引號分隔符（`<<'EOF'`）→ `heredocQuoted === true`、body 為 `undefined`、$ 不展開（靜態）；
   未引號且含展開 → `body` 為結構化 Word；純文字 → body `undefined`、文字在 `content`。靜態性判定沿用
   `print_only.ts` 既有的 `isHeredocPrintEligible`（引號分隔符，或 body/content 無 `$`/反引號）。
3. **Pipeline 結構**：unbash AST 有 `Pipeline` 節點（`Pipeline.commands: Statement[]`）。walk 攤平時
   各段以同 cwd 列舉、**不保留管段相鄰關係**；故 **vector D（pipe）需要獨立的 AST pass** 直接讀
   `Pipeline.commands` 取得「生產者 → 直譯器」相鄰結構（見 §4.6）。
4. `staticValue(word)` 對含任何展開/未引號 glob 的 word 回 `null`（動態）。payload 來源字串取不到靜態
   值即視為不可判定 → 不 deny。

#### 1.4.3 Claude Code hook 語意（沿用既有，信心度：高）

`permissionDecision: "deny"` 阻止工具呼叫並把 `permissionDecisionReason` 回饋給 agent，優先序
`deny > ask > allow`。deny 理由須含三要素：① 被禁止的事、② 為何禁止、③ 可行替代。

## 2. 目標與非目標

### 2.1 目標

- 在 `evaluate` 既有閘②（整鏈 print-only）之後新增**閘④（deny）**：偵測「直譯器執行全靜態-print
  payload」四向量，命中即整鏈 deny，`classify` 前短路、不可由 `permissions.allow` 升級。
- 新增 `src/engine/interp_print.ts`：
  - 純函式 `payloadIsAllStaticPrint(source: string, lang: "js" | "py"): boolean`——手寫極小、
    **fail-closed** 的 tokenizer + 窄文法比對（§4.1）。
  - 四向量的偵測入口 `interpreterPrintSprayDeny(invocations, script): boolean`（§4.2–§4.6）。
- 新增 deny 理由 helper `interpreterPrintDenyReason()`（`src/rules/types.ts`，§4.8）。
- 同步更新 CLAUDE.md：deny「三類/三閘」→「四類/四閘」、政策反轉段落、架構管線圖（§6）。
- 全程 fail-safe：任何不確定一律不 deny（退回 ask）；`evaluate` 既有 try/catch 把例外收斂成 ask；
  永遠 `exit 0`。

### 2.2 非目標（YAGNI，刻意排除）

- **不**做跨 Bash 呼叫的關聯：hook 每次呼叫無狀態，「呼叫 1 寫檔、呼叫 2 執行」無法偵測（§5.1）。
  **僅在單一 chain 內**偵測寫檔→執行。
- **不**完整解析 JS/Python 語法（不引入 acorn 等依賴；Python 側 Deno 無好 parser）。只用窄詞法器辨識
  「純 print 字面量序列」這一種形狀，其餘全部放手。
- **不**處理 `-p`/`--print` 運算式吐值（payload 非 printfn 敘述、述詞天生不命中）。
- **不**涵蓋 `bash -c`/`sh -c`/`eval`/`perl -e`/`ruby -e`/`php -r`/`source`（維持既有可升級 ask）。
- **不**改 echo/printf/cat 既有 print-only 閘②語意、**不**改寫入重導向/賦值前綴/中央前置任何既有判定。
  本功能**只收緊（新增 deny）**，不放寬任何既有判定。
- **不**改 `walk.ts` 攤平職責（vectors A/B/C 由現有 `CommandInvocation[]` 算出；vector D 由獨立 AST
  pass 讀 `script`）。**不**改 `CommandInvocation` 結構。
- **不**引入快取、**不**讀 enterprise managed-settings。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`：walk 之後、既有閘①②③ 之間插入閘④。`classify`/`combine`/`parse`/`walk`/
`scope`/各 `rules` 皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ invocations.length === 0 → allow（no-op，不變）
       ├─ 閘①(deny)：some(name === "sleep") → deny(pollingDenyReason())            （不變）
       ├─ 閘②(deny)：isAllPrintOnly(invocations) → deny(printOnlyDenyReason())      （不變）
       ├─ 閘④(deny)：interpreterPrintSprayDeny(invocations, script)                 （★新增）
       │             → deny(interpreterPrintDenyReason())
       ├─ 閘③(ask) ：函式遮蔽 → ask(functionShadowReason())                         （不變）
       └─ combine(invocations.map(classify))                                        （不變）
```

- 閘④ 列於閘②之後、閘③之前。四個產出 deny 的閘（①②④＋遞迴根 deny）彼此順序無關（`deny > ask >
  allow`）；閘④ 置於閘③（ask）之前，確保命中時硬 deny 不被遮蔽豁免降級（與閘①②同理）。
- 閘④ 在 `classify` 之前返回 → 天生硬性、不經中央前置規則、不經 `settingsAllows`。`Bash(node *)`/
  `Bash(python *)` 等**無法**解除。

## 4. 詳細設計

### 4.1 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_print.ts`，新檔）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該向量
命中、整鏈 deny）**僅當**下列全部成立，否則一律 `false`：

**步驟 1：Tokenize**（線性掃描，依 lang 區分註解）
- 跳過：空白、換行、shebang（行首 `#!`…整行）、註解（js `//`…行尾、`/* … */`；py `#`…行尾）。
- 產生 token：`STRING`（js `'…'`/`"…"`/`` `…` ``；py `'…'`/`"…"`，含一般引號逸脫；**反引號/含
  `${` 的模板 → 標記 `DYNAMIC`**；**py f-string 前綴 `f"…"`/`f'…'` → `DYNAMIC`**）、`NUMBER`、
  `NAME`（識別字，含點號鏈如 `console.log`、`sys.stdout.write`）、`PUNCT`（`(` `)` `,` `;`）、
  其餘任何字元（`+ - * / = % < > [ ] { } & | ! : ? ~ ^` 等）→ `OTHER`。
- 字串逸脫、未閉合引號/括號在此層偵測；**任何未閉合 → 整體 `false`**。

**步驟 2：文法比對**（消費 token 串，須完全消費）
整個 token 串必須是「一條以上 print 敘述」的序列，每條：
```
PRINT_FN '(' ARG (',' ARG)* ')' ';'?
```
- `PRINT_FN`：js ∈ {`console.log`,`console.info`,`console.warn`,`console.error`,`console.debug`,
  `process.stdout.write`,`process.stderr.write`}；py ∈ {`print`,`sys.stdout.write`,`sys.stderr.write`}。
  以 `NAME` token 的點號鏈完全相等比對。
- `ARG`：恰為一個 `STRING` 或一個 `NUMBER`。**不允許** `NAME`（變數）、`OTHER`（運算子）、`DYNAMIC`
  （模板/f-string）、巢狀 `(`。
- 須 **≥1 條** print 敘述（零有效 token → `false`）。

**步驟 3：fail-closed**
比對過程遇到任何不吻合（`NAME` 出現在該是 `STRING`/`PRINT_FN` 的位置、`OTHER`、`DYNAMIC`、未閉合、
token 未完全消費、py `print` 出現 `=` keyword 引數）→ 立即 `false`。

**對照「真實工作」範例（皆須 `false`、不 deny）**：
`console.log(1+1)`（`OTHER` `+`）、`print(sorted([…]))`（`(` 巢狀/`NAME`）、`print(json.dumps(d))`
（`NAME`）、`console.log(JSON.stringify(x))`（`NAME`）、`import json; print(…)`（`import`→`NAME` 在
敘述首非 PRINT_FN）、`console.log(`${x}`)`（`DYNAMIC`）、`print(f"{x}")`（`DYNAMIC`）、
`console.log("a"+"b")`（`OTHER` `+`）→ 全部 `false`。
**目標案例** 整段 `console.log("…")`＋註解 → 每條吻合 → `true`。**註解＋單句 `console.log("done")`**
（全部寫死、只剩一句 no-op print 的變形）→ 註解剝除後一條 print 字面量 → `true`。

> 邊界：`console.log("a", "b")`（多字面量逗號分隔）→ `true`；`console.log()`（無引數）→ 無 ARG →
> 視實作為 0 個 ARG，文法要求 `ARG (',' ARG)*` 至少一個 → 不吻合 → `false`（保守，無妨）。

### 4.2 直譯器葉指令辨識與向量分派（`interpreterPrintSprayDeny`）

```
interpreterPrintSprayDeny(invocations, script):
  staticWrites = buildStaticWriteMap(invocations)              // 向量 C 用（§4.5）
  for inv in invocations:
    if inv.name not in INTERPRETERS: continue
    mode = recognizeInterpreter(inv)                           // §4.2
    match mode:
      InlineEval(code, lang):     if payloadIsAllStaticPrint(code, lang): return true   // 向量 A
      StdinRead(lang):            // 向量 B：該葉指令 fd0 為靜態 heredoc/here-string
        body = staticStdinBody(inv)                            // 取 heredoc/here-string 靜態內容
        if body != null and payloadIsAllStaticPrint(body, lang): return true
      ScriptFile(path, lang):     // 向量 C
        src = staticWrites.get(normalize(path, inv.cwd))
        if src != null and payloadIsAllStaticPrint(src, lang): return true
      Unknown: continue                                        // 含副作用/未知旗標 → 跳過
  if pipeStdinPrintSpray(script): return true                  // 向量 D（§4.6）
  return false
```

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。

#### 4.2.1 `recognizeInterpreter(inv)`（每直譯器一組規則）

掃描 `inv.argv`（靜態化；任何 `staticValue` 為 null 的旗標/位置參數 → 視情況保守處理，見下），回傳
`InlineEval(code, lang)` / `StdinRead(lang)` / `ScriptFile(path, lang)` / `Unknown`。**核心保守規則：
只要出現任何「非本表已知的純模式選擇旗標」或任何副作用/預載旗標或無法靜態解析的旗標 → 回
`Unknown`（不 deny）**。script 位置參數之後的 token 視為「程式 argv」（忽略，不影響判定）。

- **node / nodejs / bun / ts-node**（lang=js）：
  - `-e`/`--eval`（含 `--eval=X` 黏寫；或 `-e X` 取下一 token）→ `InlineEval(X, js)`；X 動態 → `Unknown`。
  - `-`（單獨 dash 位置參數）或「無位置參數且無 `-e`」→ `StdinRead(js)`。
  - 第一個非旗標位置參數 P（bun 允許 `bun P` 或 `bun run P`；ts-node `ts-node P`）→ `ScriptFile(P, js)`；
    P 動態 → `Unknown`。
  - 出現任何其他 `-`-旗標（`-p`/`--print`/`-r`/`--require`/`--import`/`--env-file`/`-A`/未知）→ `Unknown`。
  - bun：須區分 `bun run -`（stdin）、`bun run <file>`、`bun <file>`；`run` 子指令 token 後沿用上述。
- **python / python3**（lang=py）：
  - `-c X` → `InlineEval(X, py)`；X 動態 → `Unknown`。
  - `-`/無位置參數 → `StdinRead(py)`。
  - 第一個非旗標位置參數 P → `ScriptFile(P, py)`。
  - `-m`/`-i`/其他旗標 → `Unknown`。
- **deno**（lang=js）：
  - 子指令 `eval`：`deno eval <code>`（`<code>` 為位置參數）→ `InlineEval(code, js)`；含 `-p`/`--print`
    或任何 `--allow-*`/`--preload`/未知旗標 → `Unknown`。
  - 子指令 `run`：`deno run -` → `StdinRead(js)`；`deno run <file>` → `ScriptFile(file, js)`；出現任何
    `--allow-*`/`-A`/`--preload`/`--require`/未知旗標 → `Unknown`。
  - 其他子指令（`deno test`/`deno task`/…）→ `Unknown`（不屬本偵測）。

> 此辨識器**只負責分派與 fail-closed**；真正判定靜態-print 仍由 §4.1 述詞。任何辨識歧義一律 `Unknown`。

### 4.3 向量 A（inline）詳述

`recognizeInterpreter` 取得 `InlineEval(code, lang)`，`code` 為 `staticValue` 還原的字串，餵 §4.1。
例：`node -e 'console.log("x")'` → js、code=`console.log("x")` → `true` → deny。
`python -c 'print("a");print("b")'` → py → `true` → deny。
`deno eval 'console.log(1+1)'` → 述詞遇 `+` → `false` → 不 deny。

### 4.4 向量 B（heredoc/here-string 餵 stdin）詳述

`recognizeInterpreter` 回 `StdinRead(lang)` 時，取該葉指令 fd0 的有效輸入（沿用 `print_only.ts`
`isCatPassthrough` 的「fd0 最後者勝」邏輯抽出 `staticStdinBody`）：有效 stdin 為 `<<`/`<<-`/`<<<` 且
`isHeredocPrintEligible` → 取其靜態 body 字串餵 §4.1。
例：`node <<'EOF'\nconsole.log("x")\nEOF` → body=`console.log("x")` → `true` → deny。
`python <<'EOF'\nimport os; print(os.getcwd())\nEOF` → 含 import/`NAME` → `false` → 不 deny。
有效 stdin 為 `< file`（讀真實檔）/`<&n`（fd 複製）/動態 heredoc → `staticStdinBody` 回 null → 不 deny。

### 4.5 向量 C（同鏈寫腳本檔 → 執行同檔）詳述

`buildStaticWriteMap(invocations)`：掃所有葉指令，蒐集「**靜態寫出檔案**」：
- 葉指令有**寫入重導向** `>`/`>>`（`hasWriteRedirect`）且 target 為**靜態路徑** P（`staticValue`），且其
  「被寫入的內容」可由本葉指令靜態取得：
  - `cat`/`tac` 搭靜態 heredoc/here-string（`isHeredocPrintEligible`）→ 內容＝heredoc body。
  - `echo`/`printf` 靜態 payload（沿用 `print_only.ts` 的 `wordPrintEligible`/`staticValue`，組出輸出
    字串；printf 僅在無格式化轉換符時內容可確定）→ 內容＝還原的輸出字串。
- 以 `normalizeAbsolute(P, inv.cwd)` 為 key 存入 map（值＝內容字串）。
- **歧義即放棄**：同一正規化 path 被多筆寫入（內容可能不同）→ 該 key 標記為「不可判定」、不納入 map
  （保守，不 deny）。path 動態、或內容無法靜態確定 → 不納入。

`recognizeInterpreter` 回 `ScriptFile(P, lang)` 時，以 `normalizeAbsolute(P, inv.cwd)` 查 map；命中且
`payloadIsAllStaticPrint(內容, lang)` → deny。
例（目標案例）：`cat > /tmp/x.mjs <<'EOF'\nconsole.log("…")\nEOF; node /tmp/x.mjs` → map[`/tmp/x.mjs`]
＝heredoc body（全 console.log 字面量）；`node /tmp/x.mjs` → ScriptFile → 述詞 `true` → **deny**。
`echo 'console.log("x")' > x.mjs; node x.mjs` → 同理 deny。
`cat > x.py <<'EOF'\nimport sys; print(sys.argv)\nEOF; python x.py` → 述詞遇 import → `false` → 不 deny。

> lang 一律由**執行的直譯器**決定（不靠副檔名）：`cat > x.txt <<'EOF'…EOF; node x.txt` 仍以 js 判定。

### 4.6 向量 D（pipe 餵 stdin）詳述

`pipeStdinPrintSpray(script)`：獨立唯讀 AST pass，遞迴走訪 `script` 找 `Pipeline` 節點，只處理
**恰兩段** `producer | interpreter`（`Pipeline.commands.length === 2`；多段 `a | b | node` →
保守跳過、不 deny）：
- 右段（消費者）解出的葉指令名 ∈ INTERPRETERS 且 `recognizeInterpreter` 回 `StdinRead(lang)`（即無
  script 檔、無 inline 旗標、無副作用旗標）。
- 左段（生產者）為**靜態 print 生產者**：`echo`/`printf` 靜態（`isPrintOnlyForm` 為真且能還原輸出
  字串）或 `cat`/`tac` 靜態 heredoc/here-string。取其「輸出字串」＝餵給直譯器 stdin 的 source。
- `payloadIsAllStaticPrint(source, lang)` → deny。
例：`echo 'console.log(1)' | node` → 左 echo 輸出 `console.log(1)`、右 node StdinRead js → `true` →
deny。`cat <<'EOF'\nprint("x")\nEOF | python` → deny。`grep x f | node` → 左非靜態生產者 → 不 deny。

> 生產者「輸出字串」還原：echo＝argv 以空白接合（尊重 `-n`/`-e` 既有語意過於複雜時保守跳過）；printf
> 僅無格式化轉換符時可還原；cat/tac＝heredoc body。任何無法靜態還原 → 不 deny。

### 4.7 閘④ 接線（`src/engine/evaluate.ts`）

於閘②之後、閘③之前插入：

```ts
// 閘 ④（deny）：直譯器執行全靜態-print payload（四向量）——classify 前短路、不可升級
if (interpreterPrintSprayDeny(invocations, script)) {
  return { verdict: "deny", reason: interpreterPrintDenyReason() };
}
```

- 仍在既有 try/catch 內 → `interpreterPrintSprayDeny` 任何例外 → `evaluate` 收斂為 ask（fail-safe）。
- `script` 已存在於 `evaluate`（parse 結果），直接傳入；無新參數穿透。

### 4.8 deny 理由 helper（`src/rules/types.ts`）

```ts
/** 直譯器執行全靜態-print payload 偽裝驗證的 deny 理由（回饋給 agent）。 */
export function interpreterPrintDenyReason(): string {
  return `已禁止：你正用直譯器（node/python/deno/bun/ts-node）執行一段「每一行都只是 console.log/print ` +
    `印死字串」的程式——無論是 -e/-c inline、heredoc/pipe 餵 stdin、或先寫檔再執行同檔，內容都完全由你 ` +
    `事先寫死，沒讀任何檔、沒做任何真實計算或查證，等同把推論用程式口吻轉述、偽裝成「跑出來的驗證結果」。` +
    `若你已有結論，請直接寫在回覆文字中；若需查證第三方套件/程式行為，請實際讀取其原始碼、執行會真正 ` +
    `計算或讀檔的程式、或跑真實測試，而非用直譯器重述寫死的內容。`;
}
```

## 5. 威脅模型與邊界（明確界定 deny 完整性，避免「漏堵即漏放行」誤解）

本功能是疊加的**額外 deny 層**：把使用者列舉的常見直譯器-print 偽裝硬 deny，但**不追求攔截所有
繞道**；任何未被閘④命中的形式退回既有 classify 的 allow/ask。完整性界定：

### 5.1 已知、刻意接受的限制（退回 ask/既有判定，本功能不新增任何 allow 路徑）

1. **跨 Bash 呼叫拆分（無解，stateless）**：呼叫 1 `cat > /tmp/x.mjs <<'EOF'…EOF`（→ ask，寫入重導向）、
   呼叫 2 `node /tmp/x.mjs`（若使用者設 `Bash(node *)` → 升級 allow）。hook 無跨呼叫狀態，**無法**偵測。
   屬既有 `permissions.allow` 行為，本功能不新增、亦無法硬擋。**單一 chain 內**的寫檔→執行則被閘④
   涵蓋（向量 C）。
2. **非範圍直譯器**：`bash -c`/`sh -c`/`eval`/`source`/`perl -e`/`ruby -e`/`php -r` → 維持既有可升級
   ask（§2.2）。
3. **動態 token**：直譯器名動態（`$CMD -e …`）、payload 動態（`-e "$CODE"`）、script 路徑動態、
   heredoc 未引號含展開 → 不可靜態判定 → 不 deny（退回 ask）。
4. **`-p`/`--print` 運算式吐值**、**多段 pipeline**（`a|b|node`）、**副作用旗標併用**（`node -r x -e …`）
   → 保守跳過、不 deny。
5. **間接寫檔/執行**：用 `tee`、`sed -n w`、`dd` 等非列舉寫檔形態，或經變數傳 path → 不 deny。

> 上述 ask 多數**可被** `settingsAllows` 升級（使用者自設 `Bash(node *)` 等）——屬使用者自負的 settings
> 風險；本功能不新增此升級路徑，亦不硬擋這些繞道。被閘④命中的全靜態-print 形態則**不可**升級。

### 5.2 零誤 deny 保證（最重要）

§4.1 述詞 fail-closed：任何運算子/變數/呼叫/模板/import/控制流/未閉合/無法靜態還原 → `false`（不 deny）。
故所有「真實工作」payload（含算術、排序、格式轉換、讀檔、序列化驗證等）一律**不被 deny**，最差退回
既有 ask。deny 僅命中「純 printfn(字面量) 序列」這一窄形狀。

## 6. CLAUDE.md / 文件同步

- 「這是什麼」段：deny「三類」→「四類」，加入「④ 直譯器執行全靜態-print payload 偽裝」。
- 「核心不變量 / deny 三類」→「四類/四閘」：補閘④（evaluate 層、classify 前短路、不可由
  `permissions.allow` 解除）。
- 架構評估管線圖：在閘②後補閘④。
- 「已接受繞道」段的「巢狀直譯器（預設 ask、可升級）」：明確標註 **node/python/deno/bun/ts-node 的全
  靜態-print 子集現為硬 deny**；其真實運算 payload 與 `bash -c`/`eval`/`perl -e` 等仍維持可升級 ask。
- 補一行：跨呼叫拆分為已知 stateless 限制（§5.1）。

## 7. 測試與「誤 deny」稽核

### 7.1 `interp_print_test.ts`（述詞單元測試，deny 與不-deny 兩面 + 邊界）

- **deny（`true`）**：js 多行 `console.log("…")`；py 多行 `print("…")`；含 `//`/`#`/`/* */` 註解＋print；
  shebang＋print；`console.error`/`process.stdout.write`/`sys.stdout.write` 變體；多字面量逗號分隔；
  數字字面量 `console.log(42)`；同行 `print("a");print("b")`。
- **不-deny（`false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、`json.dumps`、
  變數 `console.log(x)`、模板 `` `${x}` ``、py f-string、`import`/`require`、`if`/`for`、賦值、
  未閉合括號/引號、空 payload、`console.log()`、`print("x", end="")`（kwargs `=`）。

### 7.2 向量整合測試（`evaluate_test.ts` 或 `interp_print_test.ts`）

- 向量 A：每直譯器 `-e`/`-c`/`deno eval` 全 print → deny；含運算 → ask。
- 向量 B：`node`/`python`/`bun run -`/`deno run -` heredoc-stdin 全 print → deny；`< file` → 不 deny。
- 向量 C：**目標案例**（`cat > /tmp/x.mjs <<'EOF'…EOF; node /tmp/x.mjs`）→ deny；`echo … > f; node f`
  → deny；寫專案內同理；含 import 的 body → ask；path 不符 → ask；同 path 多寫 → ask。
- 向量 D：`echo 'console.log(1)' | node` → deny；`grep x f | node` → 不 deny；多段 pipe → 不 deny。
- 直譯器辨識：`node -r x -e 'console.log(1)'`（副作用旗標）→ Unknown → 不 deny；`deno run -A x.ts`
  → Unknown → 不 deny；動態 `node -e "$C"` → 不 deny。

### 7.3 不可升級 e2e（`main_test.ts`，子行程）

- settings `permissions.allow` 含 `Bash(node *)`／`Bash(python *)`：向量 A/B/C/D 全 print 仍 **deny**
  （證明閘④ 不經 settingsAllows）。
- 對照：`node -e 'console.log(JSON.stringify(x))'`＋`Bash(node *)` → **allow**（真實運算可升級，未被閘④
  命中），證明只擋全靜態-print 子集。

### 7.4 誤 deny 稽核清單

對映 §7.1 的「真實工作」範例清單（算術、`sorted`、混型別比較、格式轉換、`json.dumps`、讀檔計算）
逐一斷言 **非 deny**（ask 或 allow）。任一誤 deny 即視為 regression。

### 7.5 Operational verification（build 後）

`deno task build` 後餵痛點對應 JSON（`cat > /tmp/verify.mjs <<'EOF' …全 console.log 字面量… EOF` 接
`node /tmp/verify.mjs`）→ 期望 `deny`、`exit 0`、reason 為 `interpreterPrintDenyReason()`。另餵真實運算
版確認非 deny。

### 7.6 全綠

`deno task check && deno task lint && deno task test` 全綠。

## 8. 風險與未決

- **ts-node `-` stdin** 未實機確認（research 註記）：保守僅以「無位置參數＋無旗標」配 heredoc/pipe
  觸發 StdinRead；若 ts-node 實際語意不同，最差是漏 deny（安全方向）。
- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但因 fail-closed，誤判方向恆為
  「不 deny」（漏 deny），不會誤 deny。測試需覆蓋逸脫與未閉合案例固化此性質。
- **效能**：閘④ 對每次 Bash 呼叫多一趟 invocations 掃描＋（命中直譯器時）一趟極小詞法；payload 通常
  短，額外成本可忽略。
```
