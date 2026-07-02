# 設計規格：統一「print-only 載具」偽裝驗證 deny 閘（閘②′）

- 日期：2026-06-28（**2026-07-02 合併改版**）
- 狀態：設計（待實作）
- 註：本版將**既有閘②（shell 層 echo/printf/cat-heredoc print-only，已實作於 `print_only.ts`）**與
  **原規劃閘④（直譯器 print 偽裝，尚未實作）**合併為**單一閘②′「統一 print-only 載具閘」**。
  echo/printf/cat-heredoc 與 node/python 等直譯器形態都註冊為「print **載具（carrier）**」，
  合併後只有一個 `evaluate` 層閘（閘① sleep 之後、閘③ 函式遮蔽之前）、一種**聚合語意**（整鏈語意＋setup 豁免）。
  CLAUDE.md 的硬 deny **維持三類**，只是把「整鏈 print-only 偽裝」這一類的定義**擴充為跨載具**。
- 註：本版承接早期「大幅簡化重寫」的威脅模型——**只針對「agent 用常見形態做 print-only 假驗證」，不防駭客刻意
  繞過**；故凡指令含「非偵測目標的結構」一律**跳過偵測（落 ask）或無視不影響執行的旗標**，不過度解析。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，純唯讀且全落專案內才 `allow`，
其餘 `ask`，並對**三類**情形回**硬 `deny`**（不可由 `permissions.allow` 解除，見 2026-06-21 規格）：

- **遞迴遍歷磁碟根/家目錄根**：於 `classify` 內以 `isDangerousRoot` 判定、對 `deny` 短路（per-leaf）。
- **整鏈 print-only 偽裝**：`evaluate` 層**閘②′**（本規格的合併主體，見下）。
- **sleep 輪詢**：`evaluate` 層**閘①**。

（既有 `evaluate` 層另有**閘③**：函式遮蔽 → `ask`。）所有 deny 皆不經 `settingsAllows` 升級層、`classify` 前短路。

**本規格所做的是把「整鏈 print-only 偽裝」這一類 deny 的範圍擴充**：原本只涵蓋 shell 層 echo/printf/cat-heredoc
靜態吐字（舊閘②），現擴充為涵蓋 node/python 等直譯器的 print 偽裝，統一於單一閘②′。**deny 仍是三類、非四類。**

### 1.1 痛點

舊閘②只攔截 **shell 層**的 echo/printf/cat-heredoc 靜態吐字。agent 可改用**直譯器**達成同一偽裝——寫一段
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

另有一種**純 shell 兩步偽裝**目前也漏網：先把寫死文字寫進暫存檔、再讀回印出——

```bash
cat > /tmp/q.txt << 'EOF'
<多行事先寫死的「研究計畫 / 結論」>
EOF
cat /tmp/q.txt
```

淨效果與 `echo <寫死文字>` 完全相同，但因中間有**寫入重導向**，目前只落「寫入型重導向 ask」而非 deny。

### 1.2 威脅模型與範圍（**核心**）

- **要擋的**：agent **常見**的 print-only 假驗證——典型情境是「想研究第三方套件/程式行為，卻直接用訓練
  資料寫死結論、用載具 print 出來」。形態單純：裸 `echo`/`printf`、`cat` heredoc、裸 `node -e`/`python -c`、
  `cat > x; node x`、`cat > x; cat x`、heredoc/pipe 餵 stdin。
- **不需擋的**：**駭客刻意包裝 bash 繞過偵測器**。agent 不會為了 print-only 而故意做函式遮蔽、exec-wrapper
  包裝、加冷僻旗標來閃避偵測。
- **核心原則（決定整個簡化）**：
  1. 指令若含**非偵測目標的結構**（定義函式、exec-wrapper、賦值前綴、會注入碼的旗標、冷僻控制流…）→
     **跳過偵測**（不 deny、落既有 ask）。**不**為了攔截這些而過度解析。
  2. **不影響「會執行什麼」的旗標**（如 `--transpile-only`、`--experimental-*`、deno `--allow-*`，對只有
     `console.log` 的腳本毫無影響）→ **無視該旗標、繼續偵測**（不是跳過）。
  3. 方向恆安全：跳過＝更保守（多漏 deny），**絕不誤 deny、絕不新增 allow 路徑**。
- **相對舊閘②，本版對純 shell 鏈的行為變更僅一處**：**腳本定義任何函式 → 閘②′ 整體跳過**（決策見 §4.4.c），
  故 `f(){ :; }; echo 假` 由**舊 deny 改為不 deny**。其餘純 shell 鏈行為完全不變（見 §7 回歸）。

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

- 把 `evaluate` 既有閘②（`isAllPrintOnly`）**升級為統一閘②′**：以「print 載具」框架同時涵蓋 shell 層（echo/
  printf/cat-heredoc）與直譯器層（inline、heredoc/pipe stdin、寫檔→執行）的 print 偽裝。命中即整鏈 deny、
  `classify` 前短路、不可由 `permissions.allow` 升級。
- **模組結構**（維持 `src/engine/` 扁平慣例）：
  - `static_output.ts`（**新**）：靜態輸出還原原語——echo/printf/cat-heredoc → 具體輸出字串（`string | null`）；
    `wordPrintEligible` / `isHeredocPrintEligible` / fd0「最後者勝」自 `print_only.ts` 移入或 re-export。
    這是複合載具 WRITE→EXEC 的 WRITE 內容、與 pipe 載具的 producer 輸出**共用的關鍵新能力**。
  - `interp_payload.ts`（**新**）：純函式 `payloadIsAllStaticPrint(source, lang)`（手寫 fail-safe 詞法器）、
    `printExprIsStaticString`（§4.1 全文照搬，含資源上限、js/py 分派、write API STRING-only）。
  - `print_only.ts`（**改造**）：載具框架——葉載具判定、複合載具配對、聚合語意入口
    `printDisguiseDeny(script, invocations, initialCwd)`。
  - `evaluate.ts`：閘② 改呼叫 `printDisguiseDeny`；deny 理由依命中形態客製（見 §4.5）。
- 全程 fail-safe：任何不確定/非目標結構 → 不 deny；`evaluate` 既有 try/catch 收斂例外為 ask；永遠 `exit 0`。

### 2.2 非目標（**刻意排除、皆為安全 under-deny**）

- **不**防刻意繞過：以下一律**跳過偵測（落 ask）**，不嘗試解析/攔截：
  - 腳本**定義任何函式**（`f(){…}`）→ **整個閘②′ 全域跳過**（§4.4.c）；
  - **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`/`xargs`…，葉指令名非載具）；
  - **賦值前綴**（`X=1 node …`、`PATH=… node …`）；
  - 會**注入/改變執行內容**的旗標（`-r`/`--require`/`--import`/`-m`/`--preload`/`--env-file`）；
  - 動態 token（載具名/payload/路徑含變數、`$()`、未引號 glob）。
- **不**做跨 Bash 呼叫關聯（per-call 無狀態）：呼叫1寫檔、呼叫2執行 → 不偵測。本工具所有 deny 共有的根本邊界。
- **不**處理直譯器以外語言（`bash -c`/`perl -e`/`ruby -e`/`php -r`）。
- **不**改寫入重導向/賦值前綴/中央前置任何既有判定。本功能**只收緊（擴充 deny）**，除 §1.2 記錄的函式跳過放寬外，
  不放寬任何既有判定。
- **不**改 `walk.ts` 攤平職責、不改 `CommandInvocation` 結構。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`：walk 之後、閘① sleep 與閘③ 函式遮蔽之間的既有閘②位置，改為呼叫統一入口。
`classify`/`combine`/`parse`/`walk`/各 `rules` 皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ invocations.length === 0 → allow（no-op）
       ├─ 閘①(deny) ：some(name==="sleep") → deny                                  （不變）
       ├─ 閘②′(deny)：printDisguiseDeny(script, invocations, initialCwd) → deny     （★合併升級）
       ├─ 閘③(ask)  ：函式遮蔽 → ask                                                （不變）
       └─ combine(invocations.map(classify))                                        （不變）
```

閘②′ 在 `classify` 前返回 → 天生硬性、不經中央前置、不經 `settingsAllows`。`Bash(node *)`/`Bash(echo *)` 等無法解除。

## 4. 詳細設計

### 4.1 述詞 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_payload.ts`）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該載具視為 print）
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
  - **僅 `STRING` 引數**（write API：`process.stdout.write(42)` 等數字引數非靜態文字、runtime 可能失敗 →
    不算純文字 print）：js `process.stdout.write`/`process.stderr.write`；py `sys.stdout.write`/`sys.stderr.write`。
- `ARG`：恰一個 `STRING`（write API 僅此）或 `NUMBER`（僅文字輸出 API）。**不允許** `NAME`/`OTHER`/`DYNAMIC`/
  巢狀 `(`/`=`(py kwargs)。
- 須 ≥1 條。

`printExprIsStaticString(source, lang)`：供 `-p`/`--print`（吐運算式值）用——source 須為**純字串字面量/字串串接**
（`STRING (('+') STRING)*`，js；py 同理），非算術/呼叫/變數/模板。

> **對照「真實工作」（皆 `false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、
> `print(json.dumps(d))`、變數 `console.log(x)`、模板 `` `${x}` ``、f-string、`import …`、`if`/`for`。
> **命中（`true`）**：多行 `console.log("…")`、`print("…")`、註解＋print、多字面量逗號分隔、三引號/無 `${}`
> 模板字串、`console.error`/`process.stdout.write` 變體。

### 4.2 靜態輸出還原 `static_output.ts`（**新**）

提供「把 shell 靜態吐字載具還原成具體輸出字串」的純函式，回 `string | null`（`null` = 無法靜態還原）：

- `echoOutput(inv)`：echo 靜態 payload → 還原輸出字串（沿用 `isEchoPrintOnly` 的合格判定與 `-e`/`-E`/反斜線
  carve-out；不合格回 `null`）。
- `printfOutput(inv)`：printf 靜態格式 → 還原輸出（沿用 `isPrintfPrintOnly` 的 carve-out；含格式化轉換符/動態 → `null`）。
- `heredocOutput(redirect)`：cat/tac heredoc/here-string body（`isHeredocPrintEligible` 為真）→ 還原文字；否則 `null`。

`wordPrintEligible` / `isHeredocPrintEligible` / fd0「最後者勝」判定自 `print_only.ts` 移入本檔（或於此定義、
`print_only.ts` re-export），因為它們同時被葉載具判定、WRITE→EXEC 的 WRITE 內容還原、與 pipe producer 輸出還原共用。

**此還原能力是本版關鍵新增**：舊閘② 只需判斷「是否 print 形態」（boolean），合併後複合載具 WRITE→EXEC(a) 需要
**取得 WRITE 寫出的實際內容**餵給 §4.1 述詞、pipe 載具需要**取得 producer 的實際輸出**餵給述詞。

### 4.3 載具分類

一個「print 載具（carrier）」是「淨效果為靜態吐字」的單元。分**葉載具**（單一簡單 `Command`）與**複合載具**
（跨葉 pattern）。

#### 4.3.1 葉載具（單一簡單 `Command`，任何位置皆識別）

- **shell 靜態吐字**（判定邏輯不變，沿用 `print_only.ts` 既有）：echo 靜態、printf 靜態、cat/tac
  heredoc/here-string passthrough。
- **直譯器 inline**（原向量 A）：`leaf.name ∈ INTERPRETERS`、依 §4.3.3 旗標規則取出 inline-eval payload、
  payload 靜態且無第 2 類注入旗標之前綴 → `payloadIsAllStaticPrint(payload, lang)`。`-p`/`--print` →
  `printExprIsStaticString`。
- **直譯器 heredoc-stdin**（原向量 B）：`leaf.name ∈ INTERPRETERS`、無 inline-eval 旗標、無 script 位置參數、
  fd0 為靜態 heredoc/here-string（fd0「最後者勝」＋`isHeredocPrintEligible`）→ body 餵 `payloadIsAllStaticPrint`。
  無 fd0 重導向（繼承 stdin，hook 看不到）→ 非載具。

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。**deno 子指令解析**：`deno eval <payload>`
→ inline；`deno run -`（裸 dash，`-` 是 stdin 標記、非 script 位置參數）→ heredoc-stdin；`deno run <file>` →
下述 WRITE→EXEC 的 EXEC（`<file>` 為執行 token）。

#### 4.3.2 複合載具（跨葉 pattern）

- **WRITE→EXEC**（原向量 C，緊鄰前驅＋同檔比對規則照舊）：由**緊鄰前一個 sibling 的靜態 WRITE** 與其後
  **EXEC** 成對；EXEC 有兩種：
  - **(a) 直譯器執行同檔**：EXEC 葉 `name ∈ INTERPRETERS`、為「script 執行」形態（非 inline、非 stdin），
    其 argv 某靜態 token 等於 WRITE 寫出的路徑 P，且 **WRITE 內容須過 `payloadIsAllStaticPrint`**（lang 由該直譯器決定）。
  - **(b) cat/tac 讀回同檔**（**新增**）：EXEC 葉 `name ∈ {cat, tac}`、其唯一操作元為 WRITE 寫出的路徑 P、
    無蓋過的 fd0 輸入重導向；**WRITE 內容為任何可靜態還原的文字即可、不需過 payload 述詞**（因整個 composite
    的淨效果就是靜態吐字）。此支封掉 `cat > /tmp/q.txt <<'EOF'…EOF; cat /tmp/q.txt` 兩步偽裝（目前僅落寫入重導向 ask）。
  - **WRITE 定義**：緊鄰前一個 sibling 葉指令，名 ∈ {`cat`,`tac`,`echo`,`printf`}、無賦值前綴、其**唯一有效
    fd1 目標**為截斷 `>`/`>|` 到靜態路徑 P、內容可由 `static_output.ts` 靜態還原（cat/tac heredoc body 或
    echo/printf 靜態輸出）。`>>` append、多重輸出重導向、`1>&2` 等 → 非 WRITE。
  - **緊鄰前驅**：WRITE 是 EXEC 在**同一循序序列**（`;`/newline 或 `&&` 連接的 `AndOr`）內的**緊鄰前一個
    sibling**。**WRITE 與 EXEC 之間**有任何其他 statement（含 `cd`：`cat > x; cd other; node x`）、或跨控制流/
    subshell/背景/`||` 邊界 → 非緊鄰前驅 → 不成對。（**允許前面有其他 setup leg**——由 §4.4 聚合語意的 setup
    豁免處理，不在此放寬緊鄰性。）
  - **同檔比對**：以各自 statement 的 cwd 快照 `normalizeAbsolute` 後**字面相等**即同檔。緊鄰前驅時兩端 cwd
    同一快照——cwd known（含 `cd /static`）時解析絕對路徑比對；cwd unknown（如先前 `cd $DYN`）時，**相同
    相對路徑字串**仍同檔（同 cwd）→ 可比對；一絕對一相對且 cwd unknown → 無法證明 → 不成對。
  - `node --require pre.js x.mjs`（第 2 類注入旗標）→ 該 EXEC 葉跳過、不成對。
- **pipe**（原向量 D，規則照舊）：`Pipeline` 節點且為**恰兩段** `producer | interpreter`（多段跳過）：
  - 右段（消費者）：leaf 名 ∈ INTERPRETERS、無賦值前綴、無第 2 類旗標、為 stdin 形態（無 script、無 inline）、
    且**無蓋過 pipe 的 fd0 重導向**（消費端有 `< file`/heredoc/fd-dup → 跳過）。
  - 左段（生產者）：靜態 print 生產者——`echo`/`printf` 靜態或 `cat`/`tac` 靜態 heredoc/here-string，
    以 `static_output.ts` 取其輸出字串為 source。
  - `payloadIsAllStaticPrint(source, lang)` → 成對。
  - 背景 `&`/coproc/整體 pipeline redirect → 跳過；否定 `!` 不改資料流 → 照常判。

#### 4.3.3 旗標規則（直譯器葉）

掃 `inv.argv`（靜態化）。**旗標分三類**：

1. **inline-eval 旗標**：node/bun/ts-node `-e`/`--eval`、python `-c`、`deno eval`（子指令）、`-p`/`--print`
   （吐運算式值）。取其值為 payload。
2. **會注入/改變執行的旗標**（出現即**跳過此葉**、不視為載具）：`-r`/`--require`/`--import`/`-m`/`--preload`/
   `--env-file`（node/bun/python/deno 對應者）。**只計 inline payload/script 位置參數之前的旗標**——
   inline-eval（`-e`/`-c`）值之後的 token 是程式 argv，不視為直譯器旗標（`node -e 'console.log("x")' -r p`
   的 `-r` 在 payload 之後＝argv → 不致跳過 → 仍為載具）。
3. **不影響執行的良性旗標**（**無視、繼續判定**）：其餘旗標——`--transpile-only`/`--experimental-*`/
   `--no-warnings`/deno `--allow-*`/`-A`/`--no-check`、ts-node `--esm`… 以及它們的值（如 `--allow-read=path`）。
   解析時略過這些旗標 token（保守：`--flag=value` 略 1；裸 `--flag` 略 1；不維護精確 arity 表——多略/少略只
   影響是否找到 script 位置參數，方向皆 under-deny）。

### 4.4 聚合語意 `printDisguiseDeny(script, invocations, initialCwd)`（**取代 per-leaf 短路**）

**全域跳過閘（最先檢查）**：若 `definedFunctionNames(script).size > 0` → **整個閘②′ 直接回不 deny**
（腳本定義了任何函式即視為非偵測目標）。

否則做**單一 source-order AST 走訪**：沿循序序列（`Script.commands`/`CompoundList`/`BraceGroup`/`&&`/`;` 的
`AndOr`）thread cwd（由 `initialCwd`；遇 `cd` 後標 unknown）、維護「緊鄰前一個 sibling 的靜態 WRITE」`prevWrite`，
對每個簡單 `Command` 葉節點判定其**載具身分**：{葉載具｜複合載具成員（WRITE 或 EXEC）｜setup 白名單葉｜以上皆非}。
走訪同時下降控制流 body（`if`/`for`/`while`/`case`）、subshell `( )`、命令替換 `$( )`（葉載具 inline/stdin
對任何位置生效；WRITE→EXEC 僅在循序序列上判、不跨控制流/subshell 邊界）；`Function` 定義 body 不下降
（且腳本含任何函式定義時整個閘已先被全域跳過）。

走訪的**葉集合須與 `walk` 攤平的 `invocations[]` 一一對應**（同一 leaf 集合，含 `$()`/控制流內層），聚合判定即
對此集合施加。

**整鏈 deny ⟺ 同時滿足下列三者**：

- **(a) 覆蓋**：每個葉指令 ∈ { 葉載具, 複合載具成員 }。**唯一例外**：若鏈中含 ≥1 個 **WRITE→EXEC 複合載具**，
  則額外允許 **setup 白名單** `{mkdir, cd, true, :}` 的葉（**裸 print 鏈——不含 WRITE→EXEC——不吃此豁免**）。
  setup 白名單葉若處於**否定（`!`）之下**不算 setup（`! true` 排除——否定的 true 不是 setup）。
- **(b) 存在**：至少一個 print 載具存在（葉載具或複合載具）。
- **(c) 未遮蔽**：載具名未被同腳本函式定義遮蔽——已由全域跳過閘（更強：任何函式定義即整閘跳過）保證。

**行為對照**（每案於 §7 有對應測試）：

| 指令 | 葉分類 | 判定 | 說明 |
|---|---|---|---|
| `echo a; echo b` | echo＋echo（葉載具）| **deny** | 純 shell 整鏈 print（舊閘② 行為不變）|
| `echo a; node -e 'console.log("b")'` | echo＋直譯器 inline | **deny** | **新增**：混載具全 print 鏈 |
| `ls; node -e 'console.log("假")'` | ls（非載具）＋inline | 不 deny | (a) 失敗；原向量 A 由 per-leaf **弱化為整鏈**，落既有 ask |
| `ls; echo 假` / `pwd; echo 假` | 非載具＋echo | 不 deny | 洗白繞道維持（(a) 失敗）|
| `true && echo 已驗證` | true（無 composite→非 setup、非載具）＋echo | 不 deny | 裸 print 鏈不吃 setup 豁免 |
| `mkdir build && echo done` | mkdir（無 composite→非 setup）＋echo | 不 deny | 同上 |
| `cat > x <<'EOF'…EOF; cat x` | WRITE＋cat 讀回（composite 兩成員）| **deny** | **新增**：兩步偽裝（原僅落寫入重導向 ask）|
| `cat > x <<'EOF'…EOF; node x` | WRITE＋直譯器 EXEC（composite）| **deny** | 原向量 C(a) |
| `mkdir -p /tmp && cat > x <<EOF…EOF && node x` | mkdir（setup✓）＋composite | **deny** | 旗艦；有 composite → setup 豁免生效 |
| `cd /tmp; cat > x <<EOF…EOF; node x` | cd（setup✓）＋composite | **deny** | 同上 |
| `false && cat > x && node x` | false（非白名單）＋composite | 不 deny | false 非 setup、非載具 → (a) 失敗（原「靜態不可達排除」被聚合語意自然涵蓋）|
| `! true && cat > x && node x` | true 被否定（明文排除 setup）＋composite | 不 deny | `! true` 明文排除 |

命中即返回（附命中形態，見 §4.5）；走完皆無 → 不 deny。**短路單調**：一旦聚合條件成立即返回，後續節點例外
無法抹除。

### 4.5 閘②′ 接線與 deny 理由

```ts
// 閘②′（deny）：統一 print-only 載具偽裝——classify 前短路、不可升級
const hit = printDisguiseDeny(script, invocations, initialCwd);
if (hit) {
  return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
}
```

- `printDisguiseDeny` 回 `null`（不 deny）或 `{ kind }`，`kind ∈ { "shell-print", "interp-inline",
  "write-exec", "cat-readback", "pipe" }`（依最終使聚合條件成立的主要命中形態）。
- `script`/`invocations`/`initialCwd` 皆 `evaluate` 既有；無新狀態穿透。
- **短路單調**：命中即返回 truthy；既有 try/catch 僅在「尚未命中就拋例外」時退化為 ask。
- `printDisguiseDenyReason(kind)`（置於 `rules/types.ts`，取代舊 `printOnlyDenyReason`）：共用「**被禁的事＋
  原因＋替代**」骨架，依 kind 客製措辭：
  - `shell-print`：「整條指令每段都只是 echo/printf/cat 印死字串…」
  - `interp-inline`：「你正用 `-e`/`-c`/`-p` 跑一段每行都只是 `console.log`/`print` 印死字串的程式…」
  - `write-exec`：「你先把寫死文字寫進暫存檔、再用直譯器執行同檔把它印出來…」
  - `cat-readback`：「你先把寫死文字寫進暫存檔、再 `cat` 讀回印出——與直接 echo 無異…」
  - `pipe`：「你把寫死文字 pipe 給直譯器印出來…」
  - 共同結尾：「內容完全寫死、沒讀檔沒計算——偽裝成跑出來的驗證結果。若已有結論請直接寫在回覆；若需查證請
    實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。」

## 5. 邊界（皆已記錄、安全方向 under-deny；不防刻意繞過）

- **跨 Bash 呼叫拆分**（呼叫1寫檔、呼叫2執行）：per-call 無狀態 → 不偵測。**shipped guarantee 僅及單一呼叫
  鏈內**。本工具所有 deny 共有的根本邊界，不引入持久 taint（§2.2）。
- **定義函式 → 整個閘②′ 跳過**：腳本含 `f(){…}` 即不偵測（非目標常見形態；相對舊閘② 之放寬，§1.2）。
- **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`…）：葉名非載具 → 該葉非載具 →（若鏈中尚有非載具葉）
  聚合 (a) 失敗 → 落 ask。
- **賦值前綴**（`X=1 node …`、`PATH=…`）：跳過此葉、不視為載具。
- **會注入碼的旗標**（`-r`/`--require`/`--import`/`-m`/`--preload`）：跳過此葉。
- **不影響執行的良性旗標**（`--transpile-only`/`--allow-*`/`--experimental-*`…）：**無視、仍判定**（§4.3.3）。
- **繼承式 stdin**（bare `node` 無 fd0 重導向）：hook 看不到 payload → 非載具。
- **動態 token**、**非緊鄰寫→執行**、**多段 pipeline**、`>>` append、背景寫入 → 不成對/非載具。
- 上述「不 deny」多落既有 ask、**可被** `settingsAllows`（`Bash(node *)` 等）升級——屬使用者自負的既有
  settings 行為；本功能不新增此路徑、亦不硬擋。被閘②′命中者**不可**升級。

**零誤 deny 保證**：§4.1 述詞 fail-safe（任何運算/變數/呼叫/模板/import/未閉合 → 不 deny）；§4.4 聚合語意
要求**每個葉皆載具/成員**（一個非載具、非 setup 葉即使聚合失敗）；任何非目標結構 → 跳過。故所有「真實工作」
payload 與含非單純結構的指令一律不被 deny，最差退回既有 ask。

## 6. CLAUDE.md / 文件同步

- **「這是什麼」「核心不變量」**：deny **維持三類**，把「② 整鏈 print-only 偽裝」的定義由「shell 層
  echo/printf/heredoc」**擴充為跨載具**（涵蓋直譯器 inline/heredoc/pipe/寫檔→執行、及 cat 讀回兩步偽裝）。
  **不要**改成「四類」。
- **架構管線圖**：閘② 描述更新為「統一 print-only 載具閘②′」，模組列出 `static_output.ts`／`interp_payload.ts`／
  改造後 `print_only.ts`（載具框架＋`printDisguiseDeny` 入口）。
- **「已接受繞道」**：
  - node/python/deno/bun/ts-node 的**裸 all-static-print 形態**（inline/heredoc/pipe/寫檔→執行）改**硬 deny**；
    含函式/wrapper/賦值前綴/注入旗標/跨呼叫者維持 ask（明列為刻意 under-deny）。`bash -c`/`perl -e` 等仍 ask。
  - **兩步偽裝**（`cat > x <<EOF…EOF; cat x`）由「寫入重導向 ask」改**硬 deny**（cat 讀回複合載具）。
  - **混載具全 print 鏈**（`echo a; node -e print`）改**硬 deny**。
  - **`ls; echo 假` 這類「整鏈含真實/非載具葉」的洗白繞道維持不 deny**（聚合 (a) 失敗，落既有判定）——
    仍是「零誤殺、維持乾淨規則」的取捨；此類**非**「預設 ask + 升級」那一類。
  - **函式定義 → 閘②′ 全域跳過**列為**刻意放寬**（相對舊閘②，`f(){};echo 假` 由 deny 改不 deny）。

## 7. 測試與「誤 deny」稽核

### 7.1 純 shell 鏈回歸（`print_only_test.ts` 既有案例全數保留，除一處）
- **保留不變**：`echo a; echo b`、`printf '…'`、`cat <<'EOF'…EOF`、洗白鏈（`ls; echo 假`、`pwd; echo 假`、
  `true && echo x`、`mkdir build && echo done`）、echo `-e`＋反斜線 carve-out、printf 格式化轉換符 carve-out、
  cat 檔案操作元/fd0 最後者勝等。
- **唯一變更（新行為）**：`f(){ :; }; echo 假` → **改斷言不 deny**（函式定義全域跳過閘②′；落閘③/classify ask）。

### 7.2 述詞（`interp_payload_test.ts`，deny 與不-deny 兩面 + 邊界）
- deny：多行 `console.log("…")`/`print("…")`、註解＋print、三引號/無 `${}` 模板、數字字面量、多字面量逗號、
  `console.error`/`process.stdout.write` 變體。
- 不-deny：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted`、`json.dumps`、變數、`${}` 模板、
  f-string、`import`/`if`/`for`、未閉合括號/引號、空 payload、`console.log()`、`print("x",end="")`、資源上限超標。
- write API STRING-only：`process.stdout.write("fake")` deny；`process.stdout.write(42)`/`sys.stdout.write(1)` 不 deny。
- `printExprIsStaticString`：`'"fake"'` true；`'1+1'`/`'os.cpus()'` false。

### 7.3 靜態輸出還原（`static_output_test.ts`）
- `echoOutput`/`printfOutput`/`heredocOutput` 對合格 → 具體字串、不合格 → `null`（格式化轉換符、動態、append 等）。

### 7.4 載具/聚合整合測試（`print_only_test.ts` 新增段）
- **葉載具 inline（A）**：裸 `node -e '<print>'`/`python -c '<print>'`/`deno eval '<print>'`/`bun -e`/`ts-node -e`、
  `node -p '"fake"'` → deny；含運算 `node -e '1+1…'`、`node -p '1+1'`/`os.cpus()` → 不 deny。
- **葉載具 heredoc-stdin（B）**：裸 `node <<'EOF'<print>EOF`/`python <<'EOF'`/`deno run -`/`bun run -` → deny；
  `< file`/無 fd0（繼承）→ 不 deny。
- **複合 WRITE→EXEC(a) 直譯器**：**旗艦** `cat > /tmp/x.mjs <<'EOF'<print>EOF; node /tmp/x.mjs` → deny；
  `&&` 緊鄰 → deny；`echo '<print>' > f; node f` → deny；寫專案內同理。
- **複合 WRITE→EXEC(b) cat 讀回（新增）**：`cat > /tmp/q.txt <<'EOF'<任意靜態文字>EOF; cat /tmp/q.txt` → deny；
  `printf '…' > q; tac q` → deny。**不 deny 面**：非緊鄰（`cat > q; echo hi; cat q`）、非同檔（`cat > a; cat b`）、
  append（`cat >> q <<EOF…EOF; cat q`）、跨控制流（`if c; then cat > q; fi; cat q`）。
- **setup 豁免三案例**：旗艦 `mkdir -p /tmp && cat > x <<EOF…EOF && node x` → **deny**；`cd /tmp; cat > x; node x`
  → **deny**；對照 `mkdir build && echo done` → **不 deny**（無 composite → 不吃豁免）、`true && echo 已驗證`
  → **不 deny**。
- **`! true` 排除**：`! true && cat > x <<EOF…EOF && node x` → **不 deny**（否定的 true 非 setup）；
  對照 `false && cat > x && node x` → **不 deny**（false 非白名單）。
- **混載具全 print 鏈（新增 deny）**：`echo a; node -e 'console.log("b")'` → **deny**；
  對照 `ls; node -e 'console.log("假")'` → **不 deny**（ls 非載具，(a) 失敗）。
- **pipe（D）**：`echo 'console.log(1)' | node` → deny；`grep x f | node`/多段 → 不 deny；`echo … | node < real.js`
  （fd0 蓋過）→ 不 deny。
- **良性旗標仍 deny**：`ts-node --transpile-only x.ts`（x.ts 為前驅 all-print WRITE）、
  `node --experimental-default-type=module x.mjs`、`deno run --allow-read x.ts`、
  `node --no-warnings -e 'console.log("fake")'` → **deny**（旗標無視、仍判定）。

### 7.5 跳過/無視（皆**不 deny**）
- 定義函式：`f(){ :; }; node -e 'console.log("fake")'`、`node(){:;}; node -e '…'` → 不 deny（全域跳過閘）。
- exec-wrapper：`timeout 5 node -e '…'`、`command node -e '…'`、`env node -e '…'`、`xargs node -e '…'` → 不 deny。
- 賦值前綴：`X=1 node -e '…'`、`PATH=/x node -e '…'` → 不 deny。
- 注入旗標：`node -r ./pre.js -e '…'`、`python -m pytest t.py`、`node --require setup.js real-test.js` → 不 deny。
- 順序/緊鄰（不 deny）：`node x; cat > x <<EOF…EOF`（執行在寫前）、`cat > x; echo hi; node x`（WRITE 與 EXEC
  間有非-WRITE 指令）、`cat > x; cd other; node x`（cd 介於兩者）、`cat > x > sink <<EOF…EOF; node x`（有效
  fd1=sink、x 截空）、`if cond; then cat > x; fi; node x`（跨控制流邊界）→ 不 deny。

### 7.6 不可升級 e2e（`main_test.ts`）
- settings 含 `Bash(node *)`/`Bash(python *)`/`Bash(echo *)`：載具 A/B/C(a)/C(b)/D 命中仍 **deny**；對照
  `node -e 'JSON.stringify(x)'` → allow（真實運算可升級）。跨呼叫拆分 e2e：呼叫1 `cat > /tmp/x.mjs <<EOF…EOF`
  → ask；呼叫2 `node /tmp/x.mjs`＋`Bash(node *)` → allow（已記錄之單呼叫邊界）。

### 7.7 Operational verification（build 後）
- 餵兩步偽裝 JSON（`cat > /tmp/research_query.txt << 'EOF'\n<多行靜態文字>\nEOF\ncat /tmp/research_query.txt`）
  → 期望 **deny**、`exit 0`、reason 為 `cat-readback` 客製理由。
- 餵直譯器痛點 JSON（`cat > /tmp/verify.mjs <<'EOF'…全 console.log 字面量…EOF` 接 `node /tmp/verify.mjs`）→
  期望 **deny**、reason 為 `write-exec`。
- 餵真實運算版 `node -e 'console.log(1+1)'` → 期望**非 deny**。

### 7.8 全綠
`deno task check && deno task lint && deno task test`。

## 8. 風險與邊界

- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但 fail-safe，誤判方向恆為「不 deny」。
- **效能**：閘②′ 對每次 Bash 呼叫多一趟 source-order AST 走訪＋（命中時）極小詞法；payload 短，O(指令長度)。
- **刻意接受的 under-deny**（§5）：跨呼叫拆分、定義函式、exec-wrapper、賦值前綴、注入旗標、非緊鄰寫→執行、
  繼承 stdin、多段 pipe。皆安全方向、不防刻意繞過，符合「只擋 agent 常見 print-only 假驗證」的威脅模型。
- **相對舊閘② 的唯一放寬**：函式定義全域跳過（§1.2、§6），已明列並記入文件；除此之外本版只擴充 deny、不放寬。
