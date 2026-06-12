# curl + WebFetch 網域範圍：設計規格

日期：2026-06-12
狀態：草案（待審查）

## 1. 背景與目標

本工具是 Claude Code 的 `PreToolUse`（Bash）hook：只在指令「純唯讀且落在允許範圍內」時回
`allow`，其餘 `ask`、永不 `deny`。既有的 readScope 機制已把 settings 中的
`Read()/Edit()/Write()` 規則化約為「外部允許唯讀位置」。

本次新增 **WebFetch 網域範圍（domainScope）**：在 runtime 讀取 settings 中的
`WebFetch(domain:...)` 規則，讓「唯讀形式的 `curl` + 全部 URL 落在允許網域」自動放行。

**Research 已確認的官方事實（查證日 2026-06-12，Claude Code 2.1.173）：**

- Claude Code **不會**把 `WebFetch(domain:...)` 規則套用到 Bash 中的 curl/wget——兩套獨立系統
  （permissions.md 明言「using WebFetch alone does not prevent network access」）。官方唯一能管
  Bash 網路的機制是 sandbox 的 `sandbox.network.allowedDomains`（OS 層）。本功能即是補上這個
  橋接，與 readScope 之於 Read 規則同構。
- 官方 WebFetch 網域比對語意（自 2.1.173 binary 逐字抽出）：
  - 比對值 = `new URL(url).hostname`（**不含 port、不含 path**），規則先 lowercase、去除
    hostname 尾端多餘的 `.`。
  - 無萬用字元 = **精確 host 相等**；`domain:example.com` 不匹配 `api.example.com`。
  - `domain:*.example.com` 匹配**一層或多層**子網域（`a.example.com`、`a.b.example.com`），
    **不含**裸域 `example.com` 本身。
  - `domain:*` 匹配一切。精確規則優先於萬用規則。
  - changelog：v2.1.172 修復 `*.` 萬用規則；v2.1.162 起顯式 deny/ask/allow 規則優先於內建
    preapproved 網域自動放行。
- WebFetch tool 預設行為：新網域 → ask，但內建一份 preapproved 文件網域清單免詢問
  （§5 逐字快照）。

## 2. 範圍

**做：**

- 解析三個 settings 檔（專案 `.claude/settings.json`、`.claude/settings.local.json`、使用者
  `~/.claude/settings.json`）`permissions.{allow,deny,ask}` 中的 `WebFetch(domain:...)` 規則。
- 新增 `curl` 指令規則（allowlist 註冊）：旗標 allowlist + URL 網域判定。
- 內建 preapproved 文件網域清單（硬編碼快照自 Claude Code 2.1.173），語意對齊官方：顯式
  deny/ask 規則可否決 preapproved。

**不做：**

- wget 或其他網路指令（之後再議）。
- 不放寬任何寫入行為：`-o`/`-O` 等寫檔旗標不入安全集合；中央寫入重導向規則照常生效。
- 不支援無 scheme 的 URL（`curl example.com` → ask）。
- 不納入憑證類旗標（`-u`、`--oauth2-bearer`、`--netrc*`、`-K/--config` 等 → ask）。
- 不處理 sandbox 互動：若使用者啟用 `sandbox.network`，OS 層攔截與本 hook 無關
  （與 readScope 的 sandbox 註記同性質，文件註明即可）。

## 3. WebFetch 規則解析（`parseDomainRule`）

輸入單條規則字串，輸出 entry 或 `null`（忽略）：

| 規則形式 | 解析結果 |
| --- | --- |
| `WebFetch(domain:example.com)` | `{ kind: "exact", host: "example.com" }` |
| `WebFetch(domain:*.example.com)` | `{ kind: "subdomains", suffix: "example.com" }` |
| `WebFetch(domain:*)` | `{ kind: "all" }` |
| 其他（見下） | `null` |

- 正規化：host/suffix 一律 lowercase、去除尾端多餘的 `.`（對齊官方 `PX_`）。
- **忽略（回 `null`）的形式**：`*` 出現在非「整體 `*`」與非「前綴 `*.`」位置（官方 schema
  驗證本就拒絕中段 `*`）；內容含 `://`、`/`、`:`、空字串；非 `WebFetch(domain:...)`
  形狀者。其中「含 `:` 一律忽略」同時涵蓋 port 形式與 IPv6 literal（`domain:[::1]` 因含
  `:` 被忽略——IPv6 屬保守不支援，無法以規則宣告，見 §4 邊界）。忽略 = 該條規則不貢獻
  任何效果（包括 deny/ask 位置——與 readScope 對不支援形式的處理一致，於文件註明此保守性
  取捨）。
- `kind: "all"`（`domain:*`）在三個位置都有效：allow 位置 = 放行所有網域（使用者顯式選擇，
  官方亦如此語意）；deny/ask 位置 = 否決一切升級。

**`DomainScope` 結構**：`{ exact: Set<string>, suffixes: string[], all: boolean }`。
`matchesDomain(host, scope)`：`all` → true；`exact.has(host)` → true；任一 suffix 滿足
`host.endsWith("." + suffix)` → true（`endsWith` 即足以表達「一層或多層子網域、不含裸域」，
host 已是 URL parser 產出的合法 hostname，無需 regex）。

## 4. 網域判定順序（`resolveUrl`）

對單一 URL 字串判定，三態結果：

1. `new URL(value)` 解析失敗 → `invalid`。
2. `protocol` 非 `http:`/`https:` → `invalid`。
3. `username` 或 `password` 非空（userinfo 視同憑證）→ `invalid`。
4. URL 字串含 curl 多重展開字元 `{`、`}`、`[`、`]` → `invalid`
   （braces 可展開成不同 host；不論是否帶 `-g` 一律保守拒絕）。**此檢查不可省略**：
   shell 層的 glob 偵測（§6.3）攔不到引號保護的 `"https://x/{a,b}"`，但 curl 仍會展開——
   缺了這條會誤 allow。
5. **Host 正規化與邊界**：取 `hostname`（URL parser 已 lowercase、不含 port）後：
   - 去除尾端多餘的 `.`（`host.replace(/\.+$/, "")`）——對齊官方規則端正規化；否則
     `http://docs.python.org./` 會與官方行為不一致（官方放行、我們 ask）。
   - hostname 以 `[` 開頭（IPv6 literal）→ 直接 `not-allowed`（規則端因含 `:` 無法宣告
     IPv6，屬已知不支援，保守 ask）。
   - IDN：以 `URL` 產出的 punycode（`xn--`）hostname 為準比對；規則端若為 Unicode 不另
     轉換、視為不相等（保守 ask）。
6. 對正規化後的 host 依序判定：
   - 命中 `deny` scope → `not-allowed`
   - 命中 `ask` scope → `not-allowed`
   - 命中 `allow` scope → `allowed`
   - 命中 preapproved（§5：hostname 精確，或 path 前綴規則）→ `allowed`
   - 其餘 → `not-allowed`

判定順序對齊官方 v2.1.162 語意：顯式 deny/ask 優先於 preapproved 自動放行。

## 5. 內建 preapproved 清單

**逐字快照自 Claude Code 2.1.173 binary**（`new Set([...])`，90 條、89 唯一，
`learn.microsoft.com` 原始碼中重複出現兩次）。官方結構為單一扁平清單：不含 `/` 的條目為
hostname 精確比對；含 `/` 的條目於載入時推導為「hostname → path 前綴」Map。本實作照搬此
結構（單一 `PREAPPROVED` 常數陣列 + module 載入時推導）。

**推導規則**：不含 `/` 的條目 → 加入 hostname 精確 Set；含 `/` 的條目 → **僅**加入 path
Map（host → prefix 陣列），**不得**將其 hostname 加入精確 Set——否則 `huggingface.co` 的
任意 path 都會被誤放（誤 allow，安全方向錯誤）。故 `github.com`、`wordpress.org`、
`huggingface.co`、`www.kaggle.com`、`vercel.com` 僅在對應 path 前綴下放行，裸 host 或其他
path → `not-allowed`。`learn.microsoft.com` 重複兩條皆為純 hostname，進 Set 自然去重、
無其他影響。

```
platform.claude.com, code.claude.com, modelcontextprotocol.io, github.com/anthropics,
agentskills.io, docs.python.org, en.cppreference.com, docs.oracle.com, learn.microsoft.com,
developer.mozilla.org, go.dev, pkg.go.dev, www.php.net, docs.swift.org, kotlinlang.org,
ruby-doc.org, doc.rust-lang.org, www.typescriptlang.org, react.dev, angular.io, vuejs.org,
nextjs.org, expressjs.com, nodejs.org, bun.sh, jquery.com, getbootstrap.com, tailwindcss.com,
d3js.org, threejs.org, redux.js.org, webpack.js.org, jestjs.io, reactrouter.com,
docs.djangoproject.com, flask.palletsprojects.com, fastapi.tiangolo.com, pandas.pydata.org,
numpy.org, www.tensorflow.org, pytorch.org, scikit-learn.org, matplotlib.org,
requests.readthedocs.io, jupyter.org, laravel.com, symfony.com, wordpress.org/documentation,
docs.spring.io, hibernate.org, tomcat.apache.org, gradle.org, maven.apache.org, asp.net,
dotnet.microsoft.com, blazor.net, reactnative.dev, docs.flutter.dev, developer.apple.com,
developer.android.com, keras.io, spark.apache.org, huggingface.co/docs, www.kaggle.com/docs,
www.mongodb.com, redis.io, www.postgresql.org, dev.mysql.com, www.sqlite.org, graphql.org,
prisma.io, docs.getdbt.com, docs.aws.amazon.com, cloud.google.com, learn.microsoft.com,
kubernetes.io, www.docker.com, www.terraform.io, www.ansible.com, vercel.com/docs,
docs.stripe.com, docs.netlify.com, devcenter.heroku.com, cypress.io, selenium.dev,
docs.unity.com, docs.unrealengine.com, git-scm.com, nginx.org, httpd.apache.org
```

**Path 前綴比對**（對齊官方 `NX_`）：hostname 精確命中 path Map 時，先檢查 `pathname`——
若匹配 `/%(25)*(2f|5c|2e)/i`（百分號編碼的 `/`、`\`、`.`，含多重編碼）→ 不放行；否則
`pathname === prefix` 或 `pathname.startsWith(prefix + "/")` → 放行。推導出的 Map：

```
github.com → /anthropics    wordpress.org → /documentation    huggingface.co → /docs
www.kaggle.com → /docs      vercel.com → /docs
```

**維護註記**：清單為版本快照，檔內常數需註明「快照自 Claude Code 2.1.173」與重抽指令
（`grep -a -o 'new Set(\[[^]]*docs\.python\.org[^]]*\])' <binary>`）。清單飄移只影響
「免規則放行」的範圍，不影響安全性方向（漏掉新條目 = 多 ask，不會誤放）。

## 6. curl 指令規則（`src/rules/commands/curl.ts`）

整體判定：**全部旗標落在安全集合 ∧ 至少一個 URL ∧ 每個 URL 判定為 `allowed`** → `allow()`；
任一不滿足 → `ask(reason)`。中央前置規則（cwd 範圍、寫入重導向、賦值前綴）在進 rule 前已判。

### 6.1 旗標 allowlist

**無值安全旗標**：`-s/--silent`、`-S/--show-error`、`-f/--fail`、`--fail-with-body`、
`-L/--location`、`-I/--head`、`-i/--include`、`-G/--get`、`-v/--verbose`、`-4/--ipv4`、
`-6/--ipv6`、`--compressed`、`-g/--globoff`、`--no-progress-meter`、`--http1.1`、`--http2`。

**吃值安全旗標**（值必須為靜態，動態 → ask）：`-m/--max-time`、`--connect-timeout`、
`--retry`、`--retry-delay`、`--retry-max-time`、`--max-redirs`、`-A/--user-agent`、
`-e/--referer`、`-H/--header`（特殊語意見 6.2）、`--url`（值視同 URL，走 §4 判定）。

**其餘一律 ask**（allowlist 原則：未知旗標 → ask）。已知必問者無需逐一列舉，僅示例：
寫檔（`-o`、`-O`、`--output*`、`--remote-name*`、`-J`、`-c`）、非 GET（`-X`、`-d`、
`--data*`、`-F`、`-T`）、憑證（`-u`、`--user`、`--oauth2-bearer`、`--netrc*`、`-b`）、
設定/路由（`-K`、`--config`、`-x`、`--proxy*`、`--resolve`、`--connect-to`、
`--unix-socket`、`--interface`）、`-w/--write-out`、`--location-trusted`。

**旗標形式**：必須正確處理短旗標聚合（`-sSL`）與黏值（`-m10`、`-H"Accept: x"`、
`--max-time=10`）；任何無法可靠拆解的形式 → ask。實作沿用 `rules/flags.ts` 既有機制，
若既有機制不支援聚合短旗標則於本規則內自行拆解（拆解後每個字母逐一過 allowlist，
任一字母旗標吃值時其值來源依 curl 語意取剩餘字元或下一參數）。

### 6.2 `-H/--header` 語意

- 值為靜態字串且不以 `@` 開頭 → 安全（含 `Authorization: ...` 等——對已信任網域送 header
  屬使用者已接受的範圍）。
- 值為 `@-` → 安全（讀 stdin，無檔案存取）。
- 值以 `@` 開頭（`@file`）→ 對 `@` 後的路徑做 `resolvePathValue` 三態檢查：`in-project`
  （含 readScope 放寬）→ 安全；`out-of-project` / `dynamic` → ask。與 `grep -f` 的
  `pathValueFlags` 同模式。
- 值含動態展開 → ask。

### 6.3 URL 抽取與約束

- URL = 全部位置參數 + 每個 `--url` 的值。零個 URL → ask。
- **位置參數抽取必須排除所有吃值安全旗標（§6.1 第二組）的值 token**：`--opt val` /
  `-A val` 形式跳過其後一個 token；黏值、`--opt=val`、聚合短旗標形式的值已併入同一
  token、不另計。實作上若沿用 `flags.ts` 的 `positionals`，其 `valueFlags` 必須完整涵蓋
  §6.1 全部吃值旗標；且既有 `positionals` 不認得聚合短旗標（`-sSm10`），須先自行拆解
  聚合形式再判定。漏扣的最壞情況是多出一個假 URL → 走 §4 判定（多半 `invalid` → ask），
  屬安全方向，但不應依賴此兜底。
- 每個 URL 的 word 必須靜態（`staticValue` 非 null）且不含 shell glob 字元 → 否則 ask。
  注意 `word.ts` 的詞法 glob 偵測僅涵蓋 `* ? [`（不含 `] { }`）；curl 自身的 brace/range
  展開由 §4 第 4 步在 URL 字串層獨立攔截（`{ } [ ]` 四字元），兩層互補、缺一不可。
  unbash 把結構化的 BraceExpansion 視為動態 word → `staticValue` 回 null → ask，但引號
  保護的 `"{a,b}"` 是靜態字面值，只能靠 §4 第 4 步攔截。
- 通過後以 §4 `resolveUrl` 判定；`invalid` 或 `not-allowed` 任一即視為該 URL 未通過 →
  整體 ask（兩態在本規則中等價，三態僅供測試與 reason 訊息區分原因）；唯有**全部** URL
  皆為 `allowed` 才放行。
- `-L` 已決策為允許：視「初始 URL 在允許網域」為足夠授權，接受重導向可能離開該網域
  （與 WebFetch tool 的跨 host 重導向防護語意不同，文件註明）。

## 7. 架構與檔案配置（鏡像 readScope 模式）

- **新增 `src/permissions/domain_scope.ts`**：`parseDomainRule`、`DomainScope`、
  `EMPTY_DOMAIN_SCOPE`、`matchesDomain`、`PREAPPROVED`（清單常數 + 推導 hostname Set 與
  path Map）、`matchesPreapproved(hostname, pathname)`。
- **修改 `src/permissions/settings.ts`**：`PermissionRules` 增加
  `webFetch: { allow: DomainScope; deny: DomainScope; ask: DomainScope }`；`parseFile` 對三個
  位置各跑 `parseDomainRule`；`EMPTY_RULES` 與 `emptyRules()` 同步擴充；三檔 union 與
  fail-safe 行為不變。
- **修改 `src/rules/types.ts`**：`RuleContext` 增加
  `resolveUrl(value: string): "allowed" | "not-allowed" | "invalid"`。
- **修改 `src/engine/classify.ts`**：`classifyBuiltin` 現行簽名只收 `(inv, scope)`，拿不到
  `rules.webFetch`，須擴充為 `classifyBuiltin(inv, scope, webFetch)`（`webFetch` 即
  `PermissionRules["webFetch"]`，由外層 `classify` 傳入）；於建構 `RuleContext` 的物件
  字面值中，與 `resolvePath`/`resolvePathValue` 並列加入
  `resolveUrl: (v) => resolveUrl(v, webFetch)`。`resolveUrl` 內部呼叫 `matchesDomain` 與
  `matchesPreapproved`；preapproved 由 `domain_scope.ts` 模組常數提供，不經參數傳遞。
- **新增 `src/rules/commands/curl.ts`** 並於 `src/rules/allowlist.ts` 註冊。
- 既有 `settingsAllows` 升級層不動：`Bash(curl ...)` 字串規則照常可升級，與本功能疊加
  （任一路徑判 allow 即 allow）。

## 8. 錯誤處理

沿用全專案不變量：任何解析例外 try/catch 成 ask；settings 來源壞檔退化為空集合；永不
`deny`、永遠 `exit 0`。`URL` constructor 丟例外 → `invalid` → ask。`parseDomainRule` 內部
例外 → 該條規則視為 `null`。

## 9. 測試計畫

- `src/permissions/domain_scope_test.ts`：
  - `parseDomainRule` 兩面：合法三形式、正規化（大小寫、尾端 `.`）、忽略形式
    （中段 `*`、含 `/`、含 `:`、空、非 WebFetch）。
  - `matchesDomain`：精確、子網域層數、裸域不被 `*.` 命中、`all`。
  - preapproved：hostname 精確、子網域不放行（`www.python.org` 不因 `docs.python.org` 在列
    而放行）、path 前綴（`github.com/anthropics/x` 放行、`github.com/evil` 不放行）、
    百分號編碼拒絕（`%2e`、`%252f` 等）。
- `src/rules/commands/curl_test.ts`：旗標 allow/ask 兩面與聚合/黏值形式、`-H` 四種值形式、
  URL 約束（無 scheme、userinfo、`{}[]`、動態、零 URL、多 URL 部分命中）、deny/ask 否決
  allow 與 preapproved。
- `src/permissions/settings_test.ts` 增補：webFetch 三位置載入、三檔 union、壞檔退化。
- `src/engine/classify_test.ts` / `evaluate_test.ts` 增補端到端案例。
- 全綠後 `deno task build` + operational verification：餵真實 hook JSON 驗證
  「allow 網域的唯讀 curl → allow」「未列網域 / 危險旗標 → ask」。

## 10. 驗收條件

1. `curl -sL https://docs.python.org/3/` 在無任何使用者規則下 → allow（preapproved）。
2. settings 含 `WebFetch(domain:api.example.com)` 時，
   `curl -s https://api.example.com/v1` → allow；`curl -s https://example.com/` → ask。
3. settings 含 `WebFetch(domain:*.example.com)` 時，`https://a.b.example.com` → allow、
   裸域 `https://example.com` → ask。
4. deny/ask 位置的 `WebFetch(domain:docs.python.org)` 否決 preapproved → ask。
5. `curl -o x https://docs.python.org/` → ask（寫檔旗標）；
   `curl -X POST https://docs.python.org/` → ask（非 GET）。
6. `curl https://docs.python.org/{a,b}` → ask（URL 展開字元）；
   `curl "https://user@docs.python.org/"` → ask（userinfo）；`curl docs.python.org` → ask
   （無 scheme）。
7. `deno task check`、`deno task lint`、`deno task test` 全綠；operational verification 通過。
