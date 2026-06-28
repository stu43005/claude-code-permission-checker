# 設計規格：對「直譯器執行靜態-print payload 偽裝驗證」回 `deny`

- 日期：2026-06-28
- 狀態：設計（待實作）
- 註：本版為**大幅簡化重寫**。早期版本（review round 1–33）為抵禦「刻意包裝繞過」加入大量機制
  （scope/order-aware 函式遮蔽、exec-wrapper 透視、旗標 arity 解析、敏感 env 清單、`&&`-leg 成功閘控、
  fd1 排序…）。依使用者最終決策，**威脅模型只針對「agent 用常見形態做 print-only 假驗證」，不防駭客刻意
  繞過**；故凡指令含「非偵測目標的結構」一律**跳過偵測（落 ask）或無視不影響執行的旗標**，不過度解析。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，純唯讀且全落專案內才 `allow`，
其餘 `ask`，並對三類情形回**硬 `deny`**（不可由 `permissions.allow` 解除，見 2026-06-21 規格）：
- **遞迴遍歷磁碟根/家目錄根**：於 `classify` 內以 `isDangerousRoot` 判定、對 `deny` 短路（per-leaf）。
- **sleep 輪詢**：`evaluate` 層**閘①**。
- **整鏈 print-only 偽裝**（shell 層 echo/printf/cat-heredoc 靜態吐字）：`evaluate` 層**閘②**。

（既有 `evaluate` 層另有**閘③**：函式遮蔽 → `ask`。）所有 deny 皆不經 `settingsAllows` 升級層。本規格新增的
直譯器-print 偽裝為 `evaluate` 層**閘④**（deny，接於閘②之後）。

### 1.1 痛點

既有閘②只攔截 **shell 層**的 echo/printf/cat-heredoc 靜態吐字。agent 可改用**直譯器**達成同一偽裝——寫一段
「整段只有 `console.log`/`print` 印死字串」的程式交給 node/python 執行，把事先寫死的結論吐到 stdout、偽裝成
「跑出來的驗證結果」：

```bash
cat > /tmp/verify.mjs << 'EOF'
console.log("=== <某主題> 行為驗證 ===");
console.log("1. <步驟說明>：…（全部事先寫死的結論）");
console.log("結論：<寫死的是/否判斷>");
EOF
node /tmp/verify.mjs
```

這段腳本整段只有 `console.log` 印死字串——沒讀任何檔、沒做任何真實計算或查證。常見變形：`node -e '…'`/
`python -c '…'` inline、heredoc/pipe 餵 stdin。差別只在把吐字載具從 shell 換成 JS/Python 直譯器。

### 1.2 威脅模型與範圍（**本版核心**）

- **要擋的**：agent **常見**的 print-only 假驗證——典型情境是「想研究第三方套件/程式行為，卻直接用訓練
  資料寫死結論、用直譯器 print 出來」。形態單純：裸 `node -e`/`python -c`、`cat > x; node x`、heredoc/pipe。
- **不需擋的**：**駭客刻意包裝 bash 繞過偵測器**。agent 不會為了 print-only 而故意做函式遮蔽、exec-wrapper
  包裝、加冷僻旗標來閃避偵測。
- **核心原則（決定整個簡化）**：
  1. 指令若含**非偵測目標的結構**（定義函式、exec-wrapper、賦值前綴、會注入碼的旗標、冷僻控制流…）→
     **跳過偵測**（不 deny、落既有 ask）。**不**為了攔截這些而過度解析。
  2. **不影響「會執行什麼」的旗標**（如 `--transpile-only`、`--experimental-*`、deno `--allow-*`，對只有
     `console.log` 的腳本毫無影響）→ **無視該旗標、繼續偵測**（不是跳過）。
  3. 方向恆安全：跳過＝更保守（多漏 deny），**絕不誤 deny、絕不新增 allow 路徑**。

### 1.3 已查證事實（unbash 4.0.1，信心度：高）

1. 攤平後 `CommandInvocation` 帶 `name`/`argv`(suffix)/`assignments`(prefix)/`redirects`/`cwd`。
2. heredoc：引號分隔符（`<<'EOF'`）→ `heredocQuoted === true`、body 為 `undefined`、不展開（靜態）；
   未引號含展開 → `body` 為結構化 Word；純文字 → 文字在 `content`。靜態性沿用 `print_only.ts` 既有的
   `isHeredocPrintEligible`（引號分隔符，或 body/content 無 `$`/反引號）。
3. `Pipeline.commands: Statement[]`。`staticValue(word)` 對含展開/未引號 glob 回 `null`（動態）。
4. `definedFunctionNames(script)`（walk.ts 既有）回腳本內所有函式定義名集合。
5. hook `permissionDecision: "deny"` 阻止呼叫並回饋 `permissionDecisionReason`，優先序 `deny > ask > allow`；
   deny 理由須含①被禁止的事②為何③替代。

## 2. 目標與非目標

### 2.1 目標

- `evaluate` 既有閘②之後新增**閘④（deny）**：偵測「直譯器執行全靜態-print payload」四向量（A inline、
  B heredoc-stdin、C 同鏈寫檔→執行、D pipe），命中即整鏈 deny、`classify` 前短路、不可由 `permissions.allow`
  升級。
- 新增 `src/engine/interp_print.ts`：純函式 `payloadIsAllStaticPrint(source, lang)`（手寫 fail-safe 詞法器）、
  四向量偵測入口 `interpreterPrintSprayDeny(script, initialCwd)`（單一 source-order AST 走訪）。
- 新增 deny 理由 `interpreterPrintDenyReason()`。
- 同步更新 CLAUDE.md：deny「三類」→「四類」。
- 全程 fail-safe：任何不確定/非目標結構 → 不 deny；`evaluate` 既有 try/catch 收斂例外為 ask；永遠 `exit 0`。

### 2.2 非目標（**刻意排除、皆為安全 under-deny**）

- **不**防刻意繞過：以下一律**跳過偵測（落 ask）**，不嘗試解析/攔截：
  - 腳本**定義任何函式**（`f(){…}`）；
  - **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`/`xargs`…，葉指令名非直譯器）；
  - **賦值前綴**（`X=1 node …`、`PATH=… node …`）；
  - 會**注入/改變執行內容**的旗標（`-r`/`--require`/`--import`/`-m`/`--preload`/`--env-file`）；
  - 動態 token（直譯器名/payload/路徑含變數、`$()`、未引號 glob）。
- **不**做跨 Bash 呼叫關聯（per-call 無狀態）：呼叫1寫檔、呼叫2執行 → 不偵測。本工具所有 deny 共有的根本邊界。
- **不**處理巢狀直譯器以外語言（`bash -c`/`perl -e`/`ruby -e`/`php -r`）。
- **不**改 echo/printf/cat 既有閘②、不改寫入重導向/賦值前綴/中央前置任何既有判定。本功能**只收緊（新增
  deny）**，不放寬任何既有判定。
- **不**改 `walk.ts` 攤平職責、不改 `CommandInvocation` 結構。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`：walk 之後、既有閘①②③ 之間插入閘④。`classify`/`combine`/`parse`/`walk`/各 `rules`
皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ invocations.length === 0 → allow（no-op）
       ├─ 閘①(deny)：some(name==="sleep") → deny                                    （不變）
       ├─ 閘②(deny)：isAllPrintOnly(invocations) → deny                             （不變）
       ├─ 閘④(deny)：interpreterPrintSprayDeny(script, initialCwd) → deny           （★新增）
       ├─ 閘③(ask) ：函式遮蔽 → ask                                                  （不變）
       └─ combine(invocations.map(classify))                                        （不變）
```

閘④ 在 `classify` 前返回 → 天生硬性、不經中央前置、不經 `settingsAllows`。`Bash(node *)` 等無法解除。

## 4. 詳細設計

### 4.1 述詞 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_print.ts`）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該向量命中）
**僅當**下列全部成立，否則 `false`（fail-safe）：

**步驟 0：資源上限**（同步 hook 須有界）
- `source` > `MAX_PAYLOAD_BYTES`（建議 64 KiB）或 tokenize token 數 > `MAX_TOKENS`（建議 20000）→ **此 payload**
  `false`，繼續掃其他候選（不全域抑制）。

**步驟 1：Tokenize**（線性掃描，依 lang）
- 跳過：空白、換行、shebang（行首 `#!`…）、註解（js `//`…行尾、`/* */`；py `#`…行尾）。
- `STRING`：js `'…'`/`"…"`、**無 `${` 的模板 `` `…` ``**；py `'…'`/`"…"`/**三引號 `'''…'''`/`"""…"""`**、
  含非-`f` 前綴（`r`/`b`）。**動態（→ `DYNAMIC`）**：含 `${` 的模板、py f-string（`f"…"`/`f'''…'''`）。
- `NUMBER`：`[+-]?` 十進位/小數/指數；js 另允許 `0x`/`0o`/`0b`/底線/`n`(BigInt)。
- `NAME`（識別字，含點號鏈如 `console.log`）、`PUNCT`（`( ) , ;`）、其餘字元（運算子等）→ `OTHER`。
- 字串逸脫、未閉合引號/括號在此偵測；**任何未閉合 → `false`**。

**步驟 2：文法比對**（消費全部 token）：整串須為「一條以上 print 敘述」，每條 `PRINT_FN '(' ARG (',' ARG)* ')' ';'?`：
- `PRINT_FN`：
  - **可帶 `STRING` 或 `NUMBER` 引數**（文字輸出 API）：js `console.log`/`info`/`warn`/`error`/`debug`；py `print`。
  - **僅 `STRING` 引數**（write API，回應簡化後 review medium：`process.stdout.write(42)` 等數字引數非靜態文字、
    runtime 可能失敗 → 不算純文字 print）：js `process.stdout.write`/`process.stderr.write`；py `sys.stdout.write`/
    `sys.stderr.write`。
- `ARG`：恰一個 `STRING`（write API 僅此）或 `NUMBER`（僅文字輸出 API）。**不允許** `NAME`/`OTHER`/`DYNAMIC`/
  巢狀 `(`/`=`(py kwargs)。
- 須 ≥1 條。

**步驟 3：fail-safe**：任何不吻合（運算子、變數、呼叫、模板表示式、import、控制流、未閉合、token 未消費）→
`false`、不 deny、退回既有 ask。

> **對照「真實工作」（皆 `false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、
> `print(json.dumps(d))`、變數 `console.log(x)`、模板 `` `${x}` ``、f-string、`import …`、`if`/`for`。
> **命中（`true`）**：多行 `console.log("…")`、`print("…")`、註解＋print、多字面量逗號分隔、三引號/無 `${}`
> 模板字串、`console.error`/`process.stdout.write` 變體。

### 4.2 偵測入口 `interpreterPrintSprayDeny(script, initialCwd)`（單一 source-order AST 走訪）

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。

**全域跳過閘（最先檢查，回應「定義函式即跳過」）**：若 `definedFunctionNames(script).size > 0` → **整個閘④
直接回 `false`**（腳本定義了任何函式即視為非偵測目標、不偵測）。

否則依**原始碼順序**前序走訪 `script`，沿循序序列（`Script.commands`/`CompoundList`/`BraceGroup`/`&&`/`;` 的
`AndOr`）thread cwd（由 `initialCwd`；遇 `cd` 後標 unknown）、維護「緊鄰前一個 sibling 的靜態 WRITE」`prevWrite`。
命中任一向量即**短路返回 `true`**（單調，不被後續節點例外抹除）；走完皆無 → `false`。

對每個**單一簡單 `Command` 葉節點**（複合節點不取 leaf；其 body 若會執行則下降走訪）：

- **賦值前綴**（`leaf.assignments` 非空）→ 跳過此葉（不偵測）。
- `leaf.name ∉ INTERPRETERS` → 非直譯器（含 exec-wrapper 如 `timeout`/`command`）→ 不偵測此葉（更新
  `prevWrite`，見向量 C）。
- `leaf.name ∈ INTERPRETERS` → 依 §4.3 旗標規則判定向量 A/B/C；§4.4 另以 AST 判向量 D（pipe）。

### 4.3 旗標規則與向量 A/B/C（直譯器葉指令）

掃 `inv.argv`（靜態化）。**旗標分三類**：

1. **inline-eval 旗標**：node/bun/ts-node `-e`/`--eval`、python `-c`、`deno eval`（子指令）、`-p`/`--print`
   （吐運算式值）。取其值為 payload。
2. **會注入/改變執行的旗標**（出現即**跳過此葉**、不偵測）：`-r`/`--require`/`--import`/`-m`/`--preload`/
   `--env-file`（node/bun/python/deno 對應者）。**只計 inline payload/script 位置參數之前的旗標**——
   inline-eval（`-e`/`-c`）值之後的 token 是程式 argv，不視為直譯器旗標（`node -e 'console.log("x")' -r p`
   的 `-r` 在 payload 之後＝argv → 不致跳過 → 仍 deny；回應 structural advisory）。
3. **不影響執行的良性旗標**（**無視、繼續偵測**）：其餘旗標——`--transpile-only`/`--experimental-*`/
   `--no-warnings`/deno `--allow-*`/`-A`/`--no-check`、ts-node `--esm`… 以及它們的值（如 `--allow-read=path`）。
   解析時略過這些旗標 token（保守：`--flag=value` 略 1；裸 `--flag` 略 1；不維護精確 arity 表——多略/少略只
   影響是否找到 script 位置參數，方向皆 under-deny）。

判定：
- **向量 A（inline）**：出現 inline-eval 旗標、且其值靜態、且**無第 2 類旗標**之前綴 → `payloadIsAllStaticPrint(值)`
  → deny。`-p`/`--print`：值為**純字串字面量/字串串接**（`printExprIsStaticString`，非算術/呼叫/變數）→ deny。
  inline-eval 值之後的 token 是程式 argv（不影響）。
- **向量 B（heredoc 餵 stdin）**：無 inline-eval 旗標、無 script 位置參數、fd0 為靜態 heredoc/here-string
  （沿用 `print_only.ts` 的 fd0「最後者勝」與 `isHeredocPrintEligible`）→ body 餵述詞 → deny。bare `node`/
  `python`/`deno run -`/`bun run -` 配 heredoc。無 fd0 重導向（繼承 stdin，hook 看不到）→ 不 deny。
- **向量 C（同鏈寫檔→執行）**：此葉非 inline、非 stdin（即「script 執行」形態），且其 argv 中**某靜態 token
  等於緊鄰前一個 sibling WRITE 寫出的路徑 P**、且該 WRITE 內容 `payloadIsAllStaticPrint` → deny。
  - **WRITE 定義**：緊鄰前一個 sibling 葉指令，名 ∈ {`cat`,`tac`,`echo`,`printf`}、無賦值前綴、其
    **唯一有效 fd1 目標**為截斷 `>`/`>|` 到靜態路徑 P、內容可靜態還原（cat/tac heredoc body 或 echo/printf
    靜態輸出）。`>>` append、多重輸出重導向、`1>&2` 等 → 非 WRITE。
  - **緊鄰前驅**：WRITE 是 EXEC 在**同一循序序列**（`;`/newline 或 `&&` 連接的 `AndOr`）內的**緊鄰前一個
    sibling**。允許**前面有其他 setup leg**（`mkdir -p /tmp && cat > /tmp/x <<EOF…EOF && node /tmp/x`、
    `cd /tmp; cat > x; node x` 皆 deny——常見 scaffolding）。**WRITE 與 EXEC 之間**有任何其他 statement（含
    `cd`：`cat > x; cd other; node x`）、或跨控制流/subshell/背景/`||` 邊界 → 非緊鄰前驅 → 不 deny。
  - **靜態不可達排除**（回應 review medium：不 deny 永不執行的鏈）：若 EXEC 所在 `&&` 鏈中、WRITE 之前有
    **靜態必失敗 leg**（字面 `false` 指令，或 `! true`）→ 整鏈短路、WRITE/EXEC 皆不執行 → **不 deny**
    （`false && cat > x && node x` → 不 deny）。`mkdir`/`cd`/`test` 等非靜態必失敗 leg → 視為可達、照常 deny。
  - **同檔比對**：以各自 statement 的 cwd 快照 `normalizeAbsolute` 後**字面相等**即同檔。緊鄰前驅時兩端 cwd
    同一快照——cwd known（含 `cd /static`）時解析絕對路徑比對；cwd unknown（如先前 `cd $DYN`）時，**相同
    相對路徑字串**仍同檔（同 cwd）→ 可比對；一絕對一相對且 cwd unknown → 無法證明 → 不 deny。
  - lang 由執行的直譯器決定。`node --require pre.js x.mjs`（第 2 類旗標）→ 跳過。

### 4.4 向量 D（pipe 餵 stdin）

走訪遇 `Pipeline` 節點、且為**恰兩段** `producer | interpreter`（多段跳過）：
- 右段（消費者）：leaf 名 ∈ INTERPRETERS、無賦值前綴、無第 2 類旗標、`recognizeInterpreter` 為 stdin 形態
  （無 script、無 inline）、且**無蓋過 pipe 的 fd0 重導向**（消費端有 `< file`/heredoc/fd-dup → 跳過）。
- 左段（生產者）：靜態 print 生產者——`echo`/`printf` 靜態（`isPrintOnlyForm` 為真且能還原輸出）或
  `cat`/`tac` 靜態 heredoc/here-string。取其輸出字串為 source。
- `payloadIsAllStaticPrint(source, lang)` → deny。
- 背景 `&`/coproc/整體 pipeline redirect → 跳過；否定 `!` 不改資料流 → 照常判。

### 4.5 閘④ 接線與 deny 理由

```ts
// 閘 ④（deny）：直譯器執行全靜態-print payload——classify 前短路、不可升級
if (interpreterPrintSprayDeny(script, initialCwd)) {
  return { verdict: "deny", reason: interpreterPrintDenyReason() };
}
```

- `script`/`initialCwd` 皆 `evaluate` 既有；無新狀態穿透。
- **短路單調**：命中即返回 `true`，後續節點例外無法抹除已成立 deny；既有 try/catch 僅在「尚未命中就拋例外」
  時退化為 ask。
- `interpreterPrintDenyReason()`：「你正用直譯器執行一段每行都只是 `console.log`/`print` 印死字串的程式
  （-e/-c inline、heredoc/pipe 餵 stdin、或先寫檔再執行同檔），內容完全寫死、沒讀檔沒計算——偽裝成跑出來的
  驗證結果。若已有結論請直接寫在回覆；若需查證請實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。」

## 5. 邊界（皆已記錄、安全方向 under-deny；不防刻意繞過）

- **跨 Bash 呼叫拆分**（呼叫1寫檔、呼叫2執行）：per-call 無狀態 → 不偵測。**shipped guarantee 僅及單一呼叫
  鏈內**。本工具所有 deny 共有的根本邊界，不引入持久 taint（§2.2）。
- **定義函式 → 整個閘④ 跳過**：腳本含 `f(){…}` 即不偵測（非目標常見形態，§4.2）。
- **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`…）：葉名非直譯器 → 不偵測 → 落 ask。
- **賦值前綴**（`X=1 node …`、`PATH=…`）：跳過此葉 → 不偵測。
- **會注入碼的旗標**（`-r`/`--require`/`--import`/`-m`/`--preload`）：跳過此葉。
- **不影響執行的良性旗標**（`--transpile-only`/`--allow-*`/`--experimental-*`…）：**無視、仍偵測**（§4.3）。
- **繼承式 stdin**（bare `node` 無 fd0 重導向）：hook 看不到 payload → 不 deny。
- **動態 token**、**非緊鄰寫→執行**、**多段 pipeline**、`>>` append、背景寫入 → 不 deny。
- 上述「不 deny」多落既有 ask、**可被** `settingsAllows`（`Bash(node *)` 等）升級——屬使用者自負的既有
  settings 行為；本功能不新增此路徑、亦不硬擋。被閘④命中者**不可**升級。

**零誤 deny 保證**：§4.1 述詞 fail-safe（任何運算/變數/呼叫/模板/import/未閉合 → 不 deny）；§4.2 任何非目標
結構 → 跳過。故所有「真實工作」payload 與含非單純結構的指令一律不被 deny，最差退回既有 ask。

## 6. CLAUDE.md / 文件同步

- 「這是什麼」「核心不變量」：deny「三類」→「四類」，加入「④ 直譯器執行全靜態-print payload」（evaluate 層、
  classify 前短路、不可由 `permissions.allow` 解除）。
- 架構管線圖：閘②後補閘④。
- 「已接受繞道」：node/python/deno/bun/ts-node 的**裸 all-static-print 形態**改硬 deny；含函式/wrapper/賦值
  前綴/注入旗標/跨呼叫者維持 ask（明列為刻意 under-deny）。`bash -c`/`perl -e` 等仍 ask。

## 7. 測試與「誤 deny」稽核

### 7.1 `interp_print_test.ts`（述詞，deny 與不-deny 兩面 + 邊界）
- deny：多行 `console.log("…")`/`print("…")`、註解＋print、三引號/無 `${}` 模板、數字字面量、多字面量逗號、
  `console.error`/`process.stdout.write` 變體。
- 不-deny：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted`、`json.dumps`、變數、`${}` 模板、
  f-string、`import`/`if`/`for`、未閉合括號/引號、空 payload、`console.log()`、`print("x",end="")`。

### 7.2 向量整合測試
- A：裸 `node -e '<print>'`/`python -c '<print>'`/`deno eval '<print>'`/`bun -e`/`ts-node -e`、`node -p '"fake"'`
  → deny；含運算 `node -e '1+1...'`、`node -p '1+1'`/`os.cpus()` → 不 deny。
- B：裸 `node <<'EOF'<print>EOF`/`python <<'EOF'`/`deno run -`/`bun run -` → deny；`< file`/無 fd0（繼承）
  → 不 deny。
- C：**旗艦** `cat > /tmp/x.mjs <<'EOF'<print>EOF; node /tmp/x.mjs` → deny；`&&` 緊鄰 → deny；`echo '<print>' > f; node f`
  → deny；寫專案內同理。**含 setup leg（常見 scaffolding）**：`mkdir -p /tmp && cat > /tmp/x.mjs <<'EOF'<print>EOF
  && node /tmp/x.mjs`、`cd /tmp; cat > x.mjs <<'EOF'<print>EOF; node x.mjs` → **deny**（緊鄰前驅，前置 setup
  leg 不影響）。**靜態不可達不 deny**：`false && cat > x.mjs <<'EOF'<print>EOF && node x.mjs`（前置字面 `false`
  → 整鏈短路）→ 不 deny。
- D：`echo 'console.log(1)' | node` → deny；`grep x f | node`/多段 → 不 deny；`echo … | node < real.js`（fd0
  蓋過）→ 不 deny。

### 7.3 跳過/無視（皆**不 deny**，除非註明）
- 定義函式：`f(){ :; }; node -e 'console.log("fake")'`、`node(){:;}; node -e '…'` → 不 deny（閘④ 因 fnNames
  非空整體跳過；落閘③/classify ask）。
- exec-wrapper：`timeout 5 node -e '…'`、`command node -e '…'`、`env node -e '…'`、`xargs node -e '…'` → 不 deny。
- 賦值前綴：`X=1 node -e '…'`、`PATH=/x node -e '…'` → 不 deny。
- 注入旗標：`node -r ./pre.js -e '…'`、`python -m pytest t.py`、`node --require setup.js real-test.js` → 不 deny。
- **良性旗標仍 deny**：`ts-node --transpile-only x.ts`（x.ts 為前驅 all-print WRITE）、`node --experimental-default-type=module x.mjs`、
  `deno run --allow-read x.ts`、`node --no-warnings -e 'console.log("fake")'` → **deny**（旗標無視、仍偵測）。
- 順序/緊鄰（不 deny）：`node x; cat > x <<EOF…EOF`（執行在寫前）、`cat > x; echo hi; node x`（WRITE 與 EXEC
  間有非-WRITE 指令）、`cat > x; cd other; node x`（cd 介於兩者）、`cat > x > sink <<EOF…EOF; node x`（有效
  fd1=sink、x 截空）、`if cond; then cat > x; fi; node x`（跨控制流邊界）→ 不 deny。
- 述詞 write API（不 deny）：`process.stdout.write(42)`、`sys.stdout.write(1)`（數字引數給 write API）→ 不 deny；
  對照 `process.stdout.write("fake")`、`console.log(42)` → deny。

### 7.4 不可升級 e2e（`main_test.ts`）
- settings 含 `Bash(node *)`/`Bash(python *)`：向量 A/B/C/D 命中仍 **deny**；對照 `node -e 'JSON.stringify(x)'`
  → allow（真實運算可升級）。跨呼叫拆分 e2e：呼叫1 `cat > /tmp/x.mjs <<EOF…EOF` → ask；呼叫2 `node /tmp/x.mjs`
  ＋`Bash(node *)` → allow（已記錄之單呼叫邊界）。

### 7.5 Operational verification（build 後）
餵痛點 JSON（`cat > /tmp/verify.mjs <<'EOF'…全 console.log 字面量…EOF` 接 `node /tmp/verify.mjs`）→ 期望
`deny`、`exit 0`、reason 為 `interpreterPrintDenyReason()`；另餵真實運算版確認非 deny。

### 7.6 全綠
`deno task check && deno task lint && deno task test`。

## 8. 風險與邊界

- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但 fail-safe，誤判方向恆為「不 deny」。
- **效能**：閘④ 對每次 Bash 呼叫多一趟 source-order AST 走訪＋（命中時）極小詞法；payload 短，O(指令長度)。
- **刻意接受的 under-deny**（§5）：跨呼叫拆分、定義函式、exec-wrapper、賦值前綴、注入旗標、非緊鄰寫→執行、
  繼承 stdin。皆安全方向、不防刻意繞過，符合「只擋 agent 常見 print-only 假驗證」的威脅模型。
