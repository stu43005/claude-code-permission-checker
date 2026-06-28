# 設計規格：對「直譯器執行靜態-print payload 偽裝驗證」回 `deny`

- 日期：2026-06-28
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部落在
當前專案內」時回 `allow`，其餘回 `ask`，並對三類情形回**硬 `deny`**（不可由 `permissions.allow`
解除）：① 遞迴遍歷磁碟根/家目錄根的唯讀指令；② 整鏈 print-only 偽裝（echo/printf/cat-heredoc 靜態
吐字）；③ sleep 輪詢等待（見 2026-06-21 規格）。其中 ②③ 在 `evaluate` 層、`classify` 之前短路；
① 在 `classify` 內以 `isDangerousRoot` 判定並對 `deny` 短路（per-leaf）。三者皆**不**經 `settingsAllows`
升級層、不可由 `permissions.allow` 解除。

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
3. **直譯器集合**：`node`、`nodejs`、`python`、`python3`、`deno`、`bun`、`ts-node`（**名稱涵蓋**；實際
   只辨識**裸形式**——script 路徑前帶任何旗標即退回 ask、不 deny，見 §4.2.1）。
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
- **value-flags**（資訊性；列出各直譯器帶值旗標）：**本設計刻意不解析它們**——§4.2.1 採「裸形式才辨識、
  出現任何旗標即 Unknown」，故無需 value-flag 表、也不會把旗標值誤判為 script 位置參數（此表僅供理解
  CLI，不進入辨識邏輯）。
- `-p`/`--print` 的 payload 是**運算式**（非 `printfn(...)` 敘述），保守述詞天生不命中 → 不 deny
  （可接受的漏 deny）。本設計**不**特別處理 `-p`。

#### 1.4.2 unbash 4.0.1 解析行為（沿用 2026-06-21 規格，信心度：高）

1. 攤平後的 `CommandInvocation` 已帶 **`redirects`（含繼承的寫入 target 與 heredoc body/content）**
   與 **`argv`（suffix）**、**`assignments`（prefix）**、**`cwd`**。故**單葉指令**判定（向量 A/B：直譯器
   旗標/位置參數、其 fd0 heredoc body）可由 `CommandInvocation[]` 直接取得。向量 C/D 需**執行順序/管段
   相鄰**資訊（攤平後不保留），改由獨立唯讀 AST pass 直接讀 `script`，**皆不改** `walk.ts`／
   `CommandInvocation`（§4.2.2 的 `leafOf` 對單一 `Statement` 純讀化約，與 `emitCommand` 同取值方式）。
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
    **fail-safe** 的 tokenizer + 窄文法比對（§4.1）。
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
- **不**改 `walk.ts` 攤平職責（向量 A/B 由現有 `CommandInvocation[]` 算出；向量 C/D 由獨立 AST
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
       ├─ 閘④(deny)：interpreterPrintSprayDeny(script)                              （★新增；spine pass、order-aware 遮蔽）
       │             → deny(interpreterPrintDenyReason())
       ├─ 閘③(ask) ：函式遮蔽（whole-script fnNames）→ ask(functionShadowReason())   （不變）
       └─ combine(invocations.map(classify))                                        （不變）
                     └─ classify 內：遞迴遍歷磁碟根/家目錄根 deny（既有、per-leaf，於 classify 短路）
```

- **遞迴根 deny 的位置**：它**不是** evaluate 層的閘，而是各遞迴指令規則在 `classify` 內以
  `isDangerousRoot` 判定、由 `classify` 對 `deny` 短路（既有行為，本功能不動）；故未列於上方 evaluate
  閘序列，而在 `combine→classify` 步驟內。它與閘①②④ 同為硬 deny，彼此順序無關（`deny > ask > allow`）。
- 閘④ 列於閘②之後、閘③之前：閘④ 置於閘③（ask）之前，確保命中時硬 deny 不被函式遮蔽 ask 降級
  （與閘①②同理）。
- **閘編號說明**（沿用 2026-06-21 規格的歷史編號、非執行序）：①sleep-deny、②print-only-deny、
  ③函式遮蔽-ask 為既有 evaluate 層閘；④（本功能）為新增 evaluate 層 deny 閘。**執行序**為
  ①→②→④→③→`combine/classify`。遞迴根 deny 不在此編號內（classify-level，見上）。
- 閘④ 在 `classify` 之前返回 → 天生硬性、不經中央前置規則、不經 `settingsAllows`。`Bash(node *)`/
  `Bash(python *)` 等**無法**解除。

## 4. 詳細設計

### 4.1 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_print.ts`，新檔）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該向量
命中、整鏈 deny）**僅當**下列全部成立，否則一律 `false`：

**步驟 0：資源上限（per-payload，無全域 fail-open；回應 round 3 + round 7 finding 2）**
- `source` 位元組數 > `MAX_PAYLOAD_BYTES`（建議 **64 KiB**）→ **此 payload** 立即 `false`（不 tokenize），
  但**繼續掃描其他候選 payload**（不影響後續小 payload 的判定）。
- tokenize 過程 token 數 > `MAX_TOKENS`（建議 **20000**）→ **此 payload** `false`，同樣繼續掃描其他候選。
- **不設「全域 byte 預算一旦超過就整體 `false`」**（round 7 finding 2：否則大的不相符 payload 會先耗盡預算、
  令後續小的相符 `node -e 'fake'` 漏判）。總工作量天然有界：每個 payload 至多被 tokenize 一次，且所有
  payload 皆為**指令字串的子片段**，其位元組總和 ≤ 指令長度（OS/Bash 已對指令長度設限）→ 整體 O(指令長度)。
- 上述皆 fail-safe 方向（超限的**個別** payload 不 deny、退回既有 ask），確保 hook 同步路徑恆有界、永遠
  `exit 0`。

**步驟 1：Tokenize**（線性掃描，依 lang 區分註解）
- 跳過：空白、換行、shebang（行首 `#!`…整行）、註解（js `//`…行尾、`/* … */`；py `#`…行尾）。
- 產生 token：`STRING`（js `'…'`/`"…"`/`` `…` ``；py `'…'`/`"…"`，含一般引號逸脫；**反引號/含
  `${` 的模板 → 標記 `DYNAMIC`**；**py f-string 前綴 `f"…"`/`f'…'` → `DYNAMIC`**）、`NUMBER`、
  `NAME`（識別字，含點號鏈如 `console.log`、`sys.stdout.write`）、`PUNCT`（`(` `)` `,` `;`）、
  其餘任何字元（`+ - * / = % < > [ ] { } & | ! : ? ~ ^` 等）→ `OTHER`。
- **`NUMBER` 形狀**（明確化，回應 structural advisory）：`[+-]?` 前導正負號、十進位整數或小數
  （`123`、`1.5`、`.5`、`12.`）、可選指數（`1e9`、`2.5E-3`）；js 另允許 `0x…`/`0o…`/`0b…`/底線分隔/
  `…n`(BigInt)。任何不完整/含其他字元的數字序列 → 退化為 `OTHER`/`NAME`（→ fail-safe 不 deny）。
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

**步驟 3：fail-safe（任何不確定即 `false` → 不 deny、退回既有 ask；絕不誤 deny）**
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

**閘④ 為單一、順序感知的 spine pass（回應 round 7 finding 1：函式遮蔽須 order-aware）**：四向量
全部在**同一條 top-level sequential spine 的有序走訪**中判定（spine 定義同 §4.5：`Script.commands`、
`CompoundList`、`BraceGroup`、`&&`/`;` 的 `AndOr` 成員；`Subshell`/`Pipeline`/控制流/`Function` body/
命令替換/`&` 背景/`||` 一律 opaque）。走訪時維護 `definedSoFar`＝**至此 spine 位置之前已定義的函式名**；
Bash 中函式定義只影響其**之後**執行的指令，故 `definedSoFar` 精準反映「此位置該名是否被遮蔽」。

```
interpreterPrintSprayDeny(script):
  spine = linearizeSequentialSpine(script)      // 有序 statement 串；opaque 節點見上（§4.5）
  definedSoFar = {}                              // 此前已在 spine 定義的函式名（order-aware 遮蔽）
  prevWrite = null                               // 緊鄰前一條的靜態截斷 WRITE（向量 C 用）
  for stmt in spine:
    if stmt 是函式定義(name): definedSoFar.add(name); prevWrite = null; continue
    if stmt 是兩段 producer|interpreter pipeline:                              // 向量 D
      if checkVectorD(stmt, definedSoFar): return true                        // 消費者/生產者名 ∈ definedSoFar → 跳過
      prevWrite = null; continue
    leaf = leafOf(stmt)
    if leaf == null: { prevWrite = null; continue }                          // 其他 opaque
    if leaf.name in INTERPRETERS and leaf.name not in definedSoFar:           // 未（在此前）被遮蔽
      switch recognizeInterpreter(leaf):                                       // §4.2.1
        InlineEval(code, lang): if payloadIsAllStaticPrint(code, lang): return true        // 向量 A
        StdinRead(lang):  body = staticStdinBody(leaf)                                      // 向量 B
                          if body and payloadIsAllStaticPrint(body, lang): return true
        ScriptFile(P, lang):                                                                 // 向量 C
          if prevWrite is WRITE(P', content, cwdᵥ, writerName)
             and writerName not in definedSoFar
             and pathsEqualCwdAware(P', cwdᵥ, P, leaf.cwd)
             and payloadIsAllStaticPrint(content, lang): return true
    prevWrite = staticTruncatingWriteOf(leaf)    // 是靜態截斷寫檔 → 記為 WRITE，否則 null（更新緊鄰前驅）
  return false
```

- **遮蔽 order-aware**：`node -e 'fake'; node(){:;}` → 走到 `node -e` 時 `definedSoFar` 不含 node → **deny**
  （def 在後、真 node 先執行）；`node(){:;}; node -e 'fake'` → 走到 `node -e` 時 node ∈ `definedSoFar` →
  跳過 → 落閘③ **ask**。寫檔/生產者名同理以 `definedSoFar` 判（向量 C 的 `writerName`、向量 D 的生產者）。
- **僅 spine 範圍**：off-spine 的直譯器呼叫（`if`/`for`/subshell/命令替換 內）**不由閘④ 判**（落既有
  classify/閘③ → ask，安全方向 under-deny）。常見偽裝（頂層 `node -e …`、`cat>x; node x`）皆在 spine。
- **不改** `walk.ts`／`CommandInvocation`；spine pass 純讀 AST，`leafOf` 見 §4.2.2。`evaluate` 的閘③ 仍用
  既有 whole-script `fnNames`（over-ask 安全）；閘④ 自備 order-aware `definedSoFar`，兩者獨立。

**共用 leaf 萃取 `leafOf(statement)`（§4.2.2）**：向量 C/D 的 AST pass 需把單一 `Statement` 化約成
與 `recognizeInterpreter`／靜態生產者判定相同的 `{name, argv, redirects, cwd}` 形狀。`leafOf` 只接受
「statement 的 command 為單一簡單 `Command` 節點」者，回傳該形狀（`name=staticValue(cmd.name)`、
`argv=cmd.suffix`、`redirects=[...statement.redirects, ...cmd.redirects]`、`cwd`＝該位置有效 cwd）；
凡 command 為 Pipeline/Subshell/控制流/Function 等複合節點 → 回 `null`（該 statement 視為 opaque）。
此 helper 純讀、與 `walk.ts` 的 `emitCommand` 取值方式一致但**不修改** walk，僅供 `interp_print.ts`
的兩個 AST pass 使用。

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。

#### 4.2.1 `recognizeInterpreter(inv)`（每直譯器一組規則）

掃描 `inv.argv`（靜態化；任何 `staticValue` 為 null 的旗標/位置參數 → 視情況保守處理，見下），回傳
`InlineEval(code, lang)` / `StdinRead(lang)` / `ScriptFile(path, lang)` / `Unknown`。**核心保守規則：
只要出現任何「非本表已知的純模式選擇旗標」或任何副作用/預載旗標或無法靜態解析的旗標 → 回
`Unknown`（不 deny）**。script 位置參數之後的 token 視為「程式 argv」（忽略，不影響判定）。

> **覆蓋範圍＝裸形式（明確、回應 round 5 finding）**：所有直譯器**只辨識「裸形式」**——`-e`/`-c`/`deno
> eval` 的 inline、無旗標的 stdin、以及「**script 位置參數前無任何 execution-shaping 旗標**」的 script 檔。
> 凡 script 路徑前出現任何旗標（如 `ts-node --transpile-only|--project|--esm <file>`、`node
> --experimental-* <file>`、`python -X … <file>`）→ 一律 `Unknown` → **不 deny（有意 under-deny、安全
> 方向）**。刻意**不**為任何直譯器建旗標 allowlist——逐一維護帶值旗標表會引入把旗標值誤解析成路徑/code
> 的風險，違反本工具「寧可漏 deny、絕不誤 deny」原則。代價：帶旗標的 ts-node/node 寫檔→執行偽裝會漏 deny
> （仍可能被使用者 `Bash(ts-node *)` 等升級為 allow，屬既有 settings 風險）。§1.3 的直譯器集合指的是
> **名稱涵蓋**，實際辨識以本裸形式規則為準；測試與覆蓋宣稱據此限縮。

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
- **deno**（lang=js）（回應 round 2 finding 3：deno 子指令有眾多帶值旗標——`--ext`/`--import-map`/
  `--location`/`--config`/`--allow-*` 等，且 `--flag value` 與 `--flag=value` 兩式皆有；為免把旗標值誤解析
  成 code/位置參數，**deno 一律只接受「零旗標的裸形式」，出現任何旗標即 `Unknown`**）：
  - 子指令 `eval`：**僅** `deno eval <code>`（`eval` 後緊接單一位置參數 code、其間無任何旗標）→
    `InlineEval(code, js)`。`eval` 與 code 之間出現**任何**旗標（含 `-p`/`--ext`/`--import-map`/
    `--allow-*`/未知，無論黏寫與否）→ `Unknown`。
  - 子指令 `run`：**僅** `deno run -`（裸 dash）→ `StdinRead(js)`；**僅** `deno run <file>`（無旗標）→
    `ScriptFile(file, js)`。出現**任何**旗標 → `Unknown`。
  - 其他子指令（`deno test`/`deno task`/…）→ `Unknown`（不屬本偵測）。
  - 取捨：此「零旗標才認」會漏 deny 帶旗標的 deno 偽裝（如 `deno eval --no-check 'console.log("x")'`），
    屬安全方向的有意 under-deny；覆蓋宣稱與測試據此限縮為裸形式。

> 此辨識器**只負責分派**，行為 fail-safe（任何辨識歧義一律 `Unknown` → 不 deny）；真正判定靜態-print
> 仍由 §4.1 述詞。

#### 4.2.2 共用 leaf 萃取 `leafOf(statement)`

§4.2 的統一 spine pass 以此把單一 `Statement` 化約成 `{name, argv, redirects, cwd}`：
- 僅當 `statement.command` 為單一簡單 `Command` 節點時回傳該形狀；`name = staticValue(cmd.name)`
  （動態 → `null`）、`argv = cmd.suffix`、`redirects = [...statement.redirects, ...cmd.redirects]`、
  `assignments = cmd.prefix`，`cwd` 取該位置的有效 cwd（AST pass 自身以與 `walk` 相同規則於 top-level
  sequential spine 上 thread cwd；遇控制流/subshell 內即不適用，見 §4.5）。
- command 為 `Pipeline`/`Subshell`/`If`/`For`/`While`/`Case`/`BraceGroup`/`Function`/… 等複合節點
  → 回 `null`（該 statement 對本 pass 視為 **opaque**）。
- 純讀，取值方式與 `walk.ts` 的 `emitCommand` 一致，但**不修改** `walk.ts`／`CommandInvocation`。

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

**順序感知、緊鄰前驅**（修 round 1 design-soundness no-ship：原「掃全表建 map」忽略執行順序，會把
`node x; cat > x <<EOF…EOF`（node 實際跑既有檔）誤判為跑後寫的靜態 payload）。向量 C 在 §4.2 的**統一
spine pass** 內判定（其 `prevWrite` 即實作「緊鄰前驅 WRITE」、`definedSoFar` 即 order-aware 遮蔽）；以下
為其規則。spine 線性化與 opaque 邊界定義（步驟 1）由該統一 pass 共用：

1. **線性化 top-level sequential spine**：自 `script` 依序展開「當前 shell、無條件循序」的容器
   —— `Script.commands`、`CompoundList`、`BraceGroup`、以 `&&`/`;` 連接的 `AndOr` 成員 —— 得到一條
   **有序的 statement 串**。`Subshell`/`Pipeline`/`If`/`For`/`While`/`Case`/`Function`、命令替換、
   **以 `&` 背景化/async 的 statement、coproc**、以及以 `||` 連接的成員一律視為**單一 opaque statement**
   （不展開、不深入），以免在「執行順序/可達性無保證」處誤判。**WRITE 與 EXEC 兩者皆不得為背景/async
   statement**（回應 round 4 finding 2：`cat > x & node x` 中背景寫入不保證在 `node` 讀檔前完成、甚至
   未必先啟動 → 不 deny；與向量 D 排除背景 pipeline 一致）。cwd 沿 spine 以 `walk` 相同規則 thread
   （遇 `cd` 後標 unknown），**每條 statement 記下其自身的 cwd 快照**（`leafOf` 回傳的 `cwd` 即該
   statement 入點的快照）。
2. **緊鄰前驅比對**（cwd-aware，回應 round 2 finding 1）：對 spine 上每個 statement，`leafOf` 取其 leaf。
   若某 statement 為 **`EXEC(P, lang, cwdₑ)`**（`leafOf` 名 ∈ INTERPRETERS 且 `recognizeInterpreter` 回
   `ScriptFile(P, lang)`、P 靜態），檢查其**緊鄰前一條** statement 是否為 **`WRITE(P', content, cwdᵥ)`**
   （靜態寫腳本檔，見下）。路徑比對使用**各自 statement 的 cwd 快照**：**僅當 `cwdᵥ` 與 `cwdₑ` 皆為
   `known` 且 `normalizeAbsolute(P', cwdᵥ) === normalizeAbsolute(P, cwdₑ)`** 才算同檔；任一快照為
   `unknown`（如先前 `cd <動態>`）→ 視為無法證明同檔 → **跳過、不 deny**。同檔且
   `payloadIsAllStaticPrint(content, lang)` → **deny**。否則不 deny。
   （註：緊鄰時 `cwdᵥ === cwdₑ`，因兩者間無任何 statement；`cd` 介於兩者間時 `cd` 自身即緊鄰前驅、
   非 WRITE → 自然不 deny，見下例。）
3. **`WRITE(P, content)` 定義**：statement 的 leaf 有**截斷型寫入重導向 `>`/`>|`**（target 為**靜態路徑**
   P），且內容可由該 leaf 靜態還原：`cat`/`tac` 搭靜態 heredoc/here-string（`isHeredocPrintEligible`）→
   內容＝body；`echo`/`printf` 靜態 payload（沿用 `print_only.ts` 的 `wordPrintEligible`，printf 僅無格式化
   轉換符時可還原）→ 內容＝還原輸出字串。任何無法靜態還原 → 非 WRITE。
   - **排除 append `>>`（回應 round 4 finding 1）**：`>>` 是**附加**，最終檔案內容＝既有內容＋本次片段，
     無法靜態證明整檔皆 print，且 `echo 'console.log("x")' >> real-test.js; node real-test.js` 會**誤 deny
     既有真實腳本**。故 `>>`（及任何非截斷寫入）**不算 WRITE** → 不 deny。只有 `>`/`>|` 截斷覆寫使
     「整檔內容＝本次靜態還原內容」成立，才可比對。
   - **函式遮蔽跳過（order-aware，回應 round 6/7 finding）**：以 §4.2 的 `definedSoFar`（**此前已定義**的
     函式名）判；若 **EXEC 直譯器名 ∈ definedSoFar** 或 **WRITE 指令名（`cat`/`tac`/`echo`/`printf`）∈
     definedSoFar** → 該配對身分不確定 → 跳過、不 deny（落閘③ ask）。**只有在該指令之前定義的函式才算
     遮蔽**（之後定義的不影響）。

**為何「緊鄰前驅」而非「任意前驅」**：靜態上要鎖定「**若 EXEC 執行、餵給它的就是這次寫入的內容**」。
只認**緊鄰**前一條寫入，可同時免疫三種**靜態可判定**的錯配（皆會讓 node 跑到「已知不同的檔/內容」）：
執行在寫入之前（`node x; cat > x …` → EXEC 的前驅非寫 x → 不 deny）、中間插入可能改寫 P 的其他 statement
（前驅非 WRITE → 不 deny）、cwd 在兩者間改變（前驅是 `cd` → 不 deny）。代價是非緊鄰的
`cat > x …; echo hi; node x` 不 deny（保守漏 deny，安全、可接受）。

**不變量框架＝偵測「偽裝結構/意圖」，非「runtime 執行保證」（明確設計決策，回應 round 3 finding 1）**：
vector C 在「靜態上 EXEC 緊鄰於寫同檔同 cwd 的 WRITE」即 deny；它**刻意不要求靜態證明寫檔 runtime 成功**
（權限/唯讀/ENOSPC/缺父目錄等動態失敗無法靜態得知）。**這與本工具既有 deny 哲學一致**——閘① 對**字面
`sleep`** 一律 deny（連不可達 dead 分支內的 sleep 也 deny，不論是否真的執行）、閘② 對 echo/printf/cat
依**結構**判 print-only deny；三者偵測的都是「**該指令鏈所表達的禁止行為（意圖/結構）**」，而非「runtime
必然發生」。「寫一段每行都 `console.log/print` 死字串的腳本、緊接著用直譯器執行它」**無任何正當用途**，
其結構本身即偽裝意圖，故 `&&`（成功閘控）與 `;`/newline（緊鄰）**一律硬 deny**（使用者明確決定，
2026-06-28）。`&&` 形式連 runtime 寫檔失敗的殘留都無；`;`/newline 形式的「寫檔失敗 → node 跑既有/缺檔」
屬已知、刻意接受的殘留（見下，與 sleep dead-branch deny 同性質——依結構/意圖 deny，不視為有意義的
false-deny）。

- 目標案例 `cat > /tmp/x.mjs <<'EOF'\nconsole.log("…")\nEOF`（newline＝`;`）`node /tmp/x.mjs` → 兩條
  在 spine 上**緊鄰**、同 path、內容全 console.log 字面量 → **deny**。
- `cat > x.mjs <<'EOF'…EOF && node x.mjs`（`&&` 連接）→ 緊鄰 → deny；且 `&&` 保證寫入成功才執行。
- `node x.mjs; cat > x.mjs <<'EOF'…EOF` → EXEC 前驅不是寫 x → **不 deny**（修正後正確）。
- `echo 'console.log("x")' > x.mjs; node x.mjs` → deny。
- `cat > x.mjs <<'EOF'…EOF; cd other; node x.mjs` → EXEC 緊鄰前驅是 `cd other`（非 WRITE）→ **不 deny**
  （即使緊鄰，cd 也使 `node x.mjs` 實際讀 `other/x.mjs`≠寫入的 `./x.mjs`；本規則天然不命中）。
- `cd "$D"; cat > x.mjs <<'EOF'…EOF; node x.mjs`（先前 `cd <動態>` 使 cwd 標 unknown）→ 兩端 cwd 快照
  皆 `unknown` → 無法證明同檔 → **跳過、不 deny**。
- `cat > x.py <<'EOF'\nimport sys; print(sys.argv)\nEOF; python x.py` → 述詞遇 import → 不 deny。

> lang 一律由**執行的直譯器**決定（不靠副檔名）：`cat > x.txt <<'EOF'…EOF; node x.txt` 仍以 js 判定。
> 殘留（已知、可接受）：以 `;`/newline 連接時，若寫入在 runtime 失敗（如目標路徑唯讀），EXEC 仍會跑
> 既有/不存在的檔，而本 pass 已先 deny——但「寫一段全 print 腳本緊接著執行它」這整條鏈**無論寫入成敗
> 都是偽裝意圖**，deny 仍為正確方向（`&&` 形式則連此殘留都無）；故不視為有意義的 false-deny。

### 4.6 向量 D（pipe 餵 stdin）詳述

向量 D 在 §4.2 的**統一 spine pass** 內判定（`checkVectorD`）。**函式遮蔽跳過（order-aware）**：消費者
直譯器名或生產者名 ∈ `definedSoFar`（此前已定義）→ 跳過、不 deny（回應 round 6/7 finding）。**只在
top-level sequential spine 上尋找 `Pipeline` statement**（回應 round 3 finding 2：不再「遞迴走訪所有 Pipeline」，避免把 conditional/
subshell/命令替換內、或不可達分支裡的 pipeline 當成已執行 dataflow）。對 spine 上每個 statement，
只處理形如**恰兩段** `producer | interpreter` 的 Pipeline（`Pipeline.commands.length === 2`；多段
`a | b | node` → 跳過、不 deny），且該 Pipeline statement 須**無下列改變語意的包裝，否則跳過、不 deny**：
- **否定** `! producer | node`（negation 反轉退出碼，但更重要是表訊號其語意非單純 dataflow）→ 跳過。
- **背景/async** `producer | node &`、coproc → 跳過。
- **pipeline 整體掛載的 redirect**（如 `(producer | node) > f`、statement 級重導向影響整體）→ 跳過。
**兩段各為一個 `Statement`**，皆以 §4.2.2 的 `leafOf` 化約成 `{name, argv, redirects, cwd}`（任一段
`leafOf` 回 `null`，即該段非單一簡單 Command → 跳過、不 deny）：
- 右段（消費者）`leafOf` 名 ∈ INTERPRETERS 且 `recognizeInterpreter` 回 `StdinRead(lang)`（即無
  script 檔、無 inline 旗標、無副作用旗標）。
- **消費端 fd0 不得有蓋過 pipe 的重導向**（cwd-aware 的 stdin 來源判定，回應 round 2 finding 2）：
  在 pipeline 中，消費者的 fd0 預設來自 pipe，**但**若消費者自身帶 fd0 輸入重導向（`< file` / `<<`heredoc
  / `<<<` / `<&n`），依「fd0 最後者勝」其有效 stdin 可能**不是** pipe。故須以 `staticStdinBody` 同款
  fd0 分析檢查消費者：**唯有消費者無任何 fd0 輸入重導向、有效 stdin 即為 pipe** 時，才取左段輸出為
  source；否則（fd0 被 `< file`/heredoc/fd-dup 蓋過）→ **跳過、不 deny**（該 case 落消費者自身既有判定，
  或其 heredoc 由向量 B 處理）。
- 左段（生產者）`leafOf` 為**靜態 print 生產者**：`echo`/`printf` 靜態（`isPrintOnlyForm` 為真且能還原
  輸出字串）或 `cat`/`tac` 靜態 heredoc/here-string。取其「輸出字串」＝餵給直譯器 stdin 的 source。
- `payloadIsAllStaticPrint(source, lang)` → deny。

> **與 `walk` 的關係**：本 pass 不經 `walk`、不產生 `CommandInvocation`，而是直接對 `Pipeline.commands`
> 的兩個 `Statement` 各跑一次 `leafOf`（純讀 AST、§4.2.2）。`recognizeInterpreter`／靜態生產者判定／
> `staticStdinBody` 皆已是吃 `{name, argv, redirects}` 形狀的純函式，可同時被「向量 A/B 的 invocation
> 迴圈」與「向量 C/D 的 AST pass」呼叫，無需改 `walk.ts`／`CommandInvocation`（回應 round 1
> structural-completeness）。
>
> 生產者「輸出字串」還原：echo＝argv 以空白接合（`-n`/`-e` 等語意過於複雜時保守跳過、不 deny）；printf
> 僅無格式化轉換符時可還原；cat/tac＝heredoc body。任何無法靜態還原 → 不 deny。

例：`echo 'console.log(1)' | node` → 左 echo 輸出 `console.log(1)`、右 node 無 fd0 重導向、StdinRead js
→ `true` → deny。`cat <<'EOF'\nprint("x")\nEOF | python` → deny。`grep x f | node` → 左非靜態生產者 →
不 deny。`echo x | node app.js` → 右段為 ScriptFile（非 StdinRead）→ 不屬向量 D（落向量 C／既有判定）。
`echo 'console.log("x")' | node < real.js` → 右 node 有 fd0 `< real.js` 蓋過 pipe（實際讀 `real.js`）→
**跳過、不 deny**。`echo … | node <<'EOF'…EOF` → 消費者 heredoc 為有效 stdin → 不取 pipe source（其
heredoc 另由向量 B 判）。

### 4.7 閘④ 接線（`src/engine/evaluate.ts`）

於閘②之後、閘③之前插入：

閘④ 為 §4.2 的單一 spine pass，**只吃 `script`**（自備 order-aware `definedSoFar`，不需外部 `fnNames`）：

```ts
// 閘 ④（deny）：直譯器執行全靜態-print payload（四向量，spine pass）——classify 前短路、不可升級
if (interpreterPrintSprayDeny(script)) {
  return { verdict: "deny", reason: interpreterPrintDenyReason() };
}
```

- 仍在既有 try/catch 內 → `interpreterPrintSprayDeny` 任何例外 → `evaluate` 收斂為 ask（fail-safe）。
- `script` 已存在於 `evaluate`（parse 結果）；閘④ 自走 spine、自算 `definedSoFar`，**無新參數穿透**。
- **與閘③ 的關係**：閘④ 仍列於閘③ 之前（保硬 deny 不被遮蔽降級），但對「**在該指令之前已定義函式**」
  而遮蔽的名自我跳過（order-aware）→ 該情形落閘③ 回不可升級 ask。閘③ 沿用既有 whole-script `fnNames`
  （over-ask、安全），與閘④ 的 order-aware `definedSoFar` 各自獨立、互不影響。

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
6. **僅裸直譯器形式（回應 round 5）**：script 路徑前帶任何 execution-shaping 旗標（`ts-node
   --transpile-only x.ts`、`node --experimental-* x.mjs`、`python -X… x.py`）→ Unknown → 不 deny。
   刻意不建旗標 allowlist（避免把旗標值誤解析成路徑）；屬安全方向 under-deny（§4.2.1）。

> 上述 ask 多數**可被** `settingsAllows` 升級（使用者自設 `Bash(node *)` 等）——屬使用者自負的 settings
> 風險；本功能不新增此升級路徑，亦不硬擋這些繞道。被閘④命中的全靜態-print 形態則**不可**升級。

### 5.2 零誤 deny 保證（最重要）

§4.1 述詞 fail-safe：任何運算子/變數/呼叫/模板/import/控制流/未閉合/無法靜態還原 → `false`（不 deny）。
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
- 向量 C（含順序感知，回應 round 1 design-soundness）：
  - **deny**：目標案例 `cat > /tmp/x.mjs <<'EOF'…EOF; node /tmp/x.mjs`（newline 緊鄰）；`&&` 連接
    `cat > x.mjs <<'EOF'…EOF && node x.mjs`；`echo 'console.log("x")' > f; node f`；寫專案內同理。
  - **不 deny（順序/邊界）**：`node x.mjs; cat > x.mjs <<'EOF'…EOF`（執行在寫之前）；
    `cat > x.mjs <<'EOF'…EOF; echo hi; node x.mjs`（非緊鄰前驅）；
    `cat > x.mjs <<'EOF'(real)EOF; cat > x.mjs <<'EOF'(print)EOF; node x.mjs`（最後緊鄰是 print → deny）
    與反序（最後緊鄰是 real → 不 deny）；含 import 的 body → 不 deny；path 不符 → 不 deny；
    寫/執行分屬不同 `if`/subshell 分支（opaque、非 spine 緊鄰）→ 不 deny。
  - **cwd（回應 round 2 finding 1）**：`cat > x.mjs <<'EOF'…EOF; cd other; node x.mjs` → 不 deny（前驅是
    cd）；`cd "$D"; cat > x.mjs <<'EOF'…EOF; node x.mjs`（cwd unknown）→ 跳過、不 deny；相對 vs 絕對
    路徑解析到不同目錄 → 不 deny。
  - **append / 背景（回應 round 4 findings）**：`echo 'console.log("x")' >> real.js; node real.js`（append `>>`）
    → **不 deny**（非截斷寫入，無法證明整檔皆 print）；`cat > x.mjs <<'EOF'…EOF & node x.mjs`（背景寫入）
    → **不 deny**（背景不保證寫入先完成）。
- 向量 D：`echo 'console.log(1)' | node` → deny；`cat <<'EOF'…print…EOF | python` → deny；
  `grep x f | node` → 不 deny；`echo x | node app.js`（右為 ScriptFile）→ 不屬 D；多段 `a|b|node` → 不 deny。
  - **fd0 重導向（回應 round 2 finding 2）**：`echo 'console.log("x")' | node < real.js` → 不 deny（消費端
    fd0 被 `< real.js` 蓋過）；`echo … | node <<'EOF'…EOF` → 不取 pipe source（消費者 heredoc 為有效
    stdin）；`echo … | node 0<&3` fd-dup → 不 deny。
  - **包裝/邊界（回應 round 3 finding 2）**：`! echo 'console.log(1)' | node`（否定）、
    `echo 'console.log(1)' | node &`（背景）、`(echo 'console.log(1)' | node) > f`（pipeline 級重導向）、
    `if cond; then echo 'console.log(1)' | node; fi`（conditional 內、非 spine）→ 一律不 deny。
- 資源上限（per-payload，回應 round 3 + round 7 finding 2）：>64 KiB 或 >20000 token 的**個別** payload
  → 該 payload `false`、不 deny，但**其他候選照常掃描**；關鍵回歸：**大的不相符 heredoc/inline 在前 ＋
  小的相符 `node -e 'console.log("fake")'` 在後 → 仍 deny**（無全域 fail-open 抑制後續判定）。
- 直譯器辨識：`node -r x -e 'console.log(1)'`（副作用旗標）→ Unknown → 不 deny；`deno run -A x.ts`、
  `deno eval --no-check 'console.log("x")'`（任何 deno 旗標）→ Unknown → 不 deny；裸 `deno eval
  'console.log("x")'` → deny；動態 `node -e "$C"` → 不 deny。
- 裸形式覆蓋（回應 round 5）：`echo 'console.log("x")' > verify.ts; ts-node --transpile-only verify.ts`
  （script 前有旗標）→ Unknown → **不 deny（有意 under-deny）**；對照裸 `… ; ts-node verify.ts` → deny。
- 函式遮蔽 order-aware（回應 round 6/7）：`node() { :; }; node -e 'console.log("x")'`（def 在前）→ 閘④
  跳過 → 閘③ **ask**；**`node -e 'console.log("fake")'; node() { :; }`（def 在後）→ 真 node 先執行 →
  **deny**（不被後置 def 降級）；`python`/`deno` 同理；向量 C `cat() { :; }; cat > x.mjs <<'EOF'…EOF;
  node x.mjs`（cat 前置遮蔽）→ 不 deny → 閘③ ask；向量 D 生產者前置遮蔽同理。
- off-spine：`if cond; then node -e 'console.log("x")'; fi`、`$(node -e 'console.log("x")')` → 閘④ 不判
  （under-deny）→ 落 classify ask。

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

## 8. 風險與邊界（多為已記錄、刻意接受的取捨）

- **向量 C「緊鄰前驅」的有意 under-deny**：只認 EXEC 緊鄰前一條為靜態寫同檔，故 `cat > x …; echo hi;
  node x`、寫/執行分屬不同控制流分支等非緊鄰形態**不 deny**（退回既有 ask）。這是為 zero false-deny 換取
  的保守取捨（§4.5）。
- **向量 C 以 `;`/newline 連接的 runtime 寫入失敗殘留（明確設計決策，非待修）**：design-soundness
  reviewer（round 3）主張此形態不該硬 deny（寫檔 runtime 失敗時 EXEC 跑既有/缺檔、且硬 deny 不可解除）。
  **使用者明確裁定維持硬 deny（2026-06-28）**：理由是「runtime 失敗是邊緣案例，重點是 agent **有意圖**這樣
  做、而非實際是否如此執行」。本工具的 deny 本就是**意圖/結構導向**（閘① 連 dead 分支的字面 `sleep` 都
  deny、閘② 依結構判 print-only）；「寫全 print 腳本緊接執行同檔」無正當用途，其結構即偽裝意圖，故依結構
  deny、不要求靜態證明寫檔成功。此為**有意接受、已記錄並覆寫 reviewer 建議**的取捨（`&&` 形式連此殘留
  都無；§4.5 已詳述不變量框架）。
- **ts-node `-` stdin** 未實機確認（research 註記）：保守僅以「無位置參數＋無旗標」配 heredoc/pipe
  觸發 StdinRead；若 ts-node 實際語意不同，最差是漏 deny（安全方向）。
- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但因 fail-safe，誤判方向恆為
  「不 deny」（漏 deny），不會誤 deny。測試需覆蓋逸脫與未閉合案例固化此性質。
- **效能**：閘④ 對每次 Bash 呼叫多一趟 invocations 掃描＋（命中直譯器時）一趟極小詞法；payload 通常
  短，額外成本可忽略。
