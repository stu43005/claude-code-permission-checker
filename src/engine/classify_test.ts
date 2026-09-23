import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import { evaluate } from "./evaluate.ts";
import type { CommandInvocation, CwdState } from "../types.ts";
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "../permissions/path_scope.ts";
import { EMPTY_DOMAIN_SCOPE, parseDomainRule } from "../permissions/domain_scope.ts";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
}

function onlyWith(src: string, rules: PermissionRules) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules);
}

function only(src: string) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT);
}

Deno.test("dynamic command name asks", () => {
  assertEquals(only("$CMD a").kind, "ask");
});

Deno.test("not-in-allowlist asks", () => {
  assertEquals(only("rm -rf x").kind, "ask");
});

Deno.test("known-out-of-project cwd asks before rule", () => {
  const invs = walk(parseCommand("cd /tmp && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT).kind, "ask");
});

Deno.test("write redirect asks", () => {
  assertEquals(only("echo hi > out.txt").kind, "ask");
});

Deno.test("read-only in-project allows", () => {
  assertEquals(only("cat src/a.ts").kind, "allow");
});

Deno.test("null-device redirect still allows", () => {
  assertEquals(only("grep x f 2>/dev/null").kind, "allow");
});

Deno.test("LD_PRELOAD env assignment prefix asks", () => {
  assertEquals(only("LD_PRELOAD=/tmp/x.so cat a").kind, "ask");
});

Deno.test("FOO=bar env assignment prefix asks", () => {
  assertEquals(only("FOO=bar cat a").kind, "ask");
});

Deno.test("settings allow upgrades ask -> allow", () => {
  assertEquals(onlyWith("npm test x", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("builtin allow stays allow regardless of rules", () => {
  assertEquals(onlyWith("cat src/a.ts", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("deny blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("ask rule blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], ask: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("no rules arg behaves as before (npm asks)", () => {
  assertEquals(only("npm test").kind, "ask");
});

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
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
}

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

Deno.test("external path under allow root but also denied -> ask (integration)", () => {
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: { roots: ["/srv/pkg"], files: [] },
      deny: { roots: ["/srv/pkg/secret"], files: [] },
      ask: EMPTY_READ_SCOPE,
    },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
  assertEquals(onlyWith("grep needle /srv/pkg/secret/a", rules).kind, "ask");
});

Deno.test("cwd under allow root but also ask-listed -> ask (integration)", () => {
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: { roots: ["/srv/pkg"], files: [] },
      deny: EMPTY_READ_SCOPE,
      ask: { roots: ["/srv/pkg/secret"], files: [] },
    },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
  const invs = walk(parseCommand("cd /srv/pkg/secret && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT, rules).kind, "ask");
});

function webFetchRulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const scopeOf = (rules: string[]) => {
    const s = { exact: new Set<string>(), suffixes: [] as string[], all: false };
    for (const r of rules) {
      const e = parseDomainRule(r);
      if (e === null) continue;
      if (e.kind === "all") s.all = true;
      else if (e.kind === "exact") s.exact.add(e.host);
      else s.suffixes.push(e.suffix);
    }
    return s;
  };
  return {
    bash: { allow: [], deny: [], ask: [] },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
    webFetch: {
      allow: scopeOf(spec.allow ?? []),
      deny: scopeOf(spec.deny ?? []),
      ask: scopeOf(spec.ask ?? []),
    },
  };
}

Deno.test("classify e2e: curl allowed domain via WebFetch rules", () => {
  const rules = webFetchRulesOf({ allow: ["WebFetch(domain:api.example.com)"] });
  assertEquals(onlyWith("curl -sL https://api.example.com/v1", rules).kind, "allow");
  assertEquals(onlyWith("curl -sL https://example.com/", rules).kind, "ask");
});

Deno.test("classify e2e: curl preapproved domain with default rules", () => {
  assertEquals(only("curl -s https://docs.python.org/3/").kind, "allow");
});

Deno.test("classify e2e: deny vetoes preapproved", () => {
  const rules = webFetchRulesOf({ deny: ["WebFetch(domain:docs.python.org)"] });
  assertEquals(onlyWith("curl -s https://docs.python.org/3/", rules).kind, "ask");
});

Deno.test("classify e2e: write redirect still asks for allowed curl", () => {
  // 中央寫入重導向規則照常生效
  assertEquals(only("curl -s https://docs.python.org/3/ > out.html").kind, "ask");
});

Deno.test("classify: deny 不被 permissions.allow 升級", () => {
  const rules = rulesOf({ allow: ["Bash(find *)"] });
  assertEquals(onlyWith("find /", rules).kind, "deny");
});

const CLAUDE_TRUSTED = "/home/me/.claude/projects/-proj/115826ef-e830-461f-8101-edac56694d2b";
const TMP_TRUSTED = "/tmp/claude-501/-proj/115826ef-e830-461f-8101-edac56694d2b";

function withTrusted(src: string, trusted: string[], rules?: PermissionRules) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules ?? rulesOf({}), "/home/me", trusted);
}

Deno.test("trusted ~/.claude 子路徑唯讀指令 → allow", () => {
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`, [CLAUDE_TRUSTED]).kind, "allow");
});

Deno.test("trusted /tmp 子路徑唯讀指令 → allow", () => {
  assertEquals(withTrusted(`cat ${TMP_TRUSTED}/tasks/x.output`, [CLAUDE_TRUSTED, TMP_TRUSTED]).kind, "allow");
});

Deno.test("同專案 memory、他 session、本 session transcript 檔皆不在 trusted → ask", () => {
  assertEquals(withTrusted("cat /home/me/.claude/projects/-proj/memory/x.md", [CLAUDE_TRUSTED]).kind, "ask");
  assertEquals(withTrusted("cat /home/me/.claude/projects/-proj/other-sid/tool-results/x", [CLAUDE_TRUSTED]).kind, "ask");
  // transcript .jsonl 位於 session 子目錄的兄弟位置，不在 trusted 根之下
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}.jsonl`, [CLAUDE_TRUSTED]).kind, "ask");
});

Deno.test("trusted 下但命中 user Read() deny、且無 Bash allow → ask", () => {
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: EMPTY_READ_SCOPE,
      deny: { roots: [CLAUDE_TRUSTED], files: [] },
      ask: EMPTY_READ_SCOPE,
    },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
  assertEquals(withTrusted(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`, [CLAUDE_TRUSTED], rules).kind, "ask");
});

Deno.test("未傳 trustedReadRoots（預設 []）→ 同外部路徑 ask", () => {
  const invs = walk(parseCommand(`cat ${CLAUDE_TRUSTED}/tool-results/x.txt`).script, START, ROOT);
  assertEquals(classify(invs[0], ROOT).kind, "ask");
});

Deno.test("evaluate 把 trustedReadRoots 轉傳給 classify → allow", () => {
  const out = evaluate(
    `cat ${CLAUDE_TRUSTED}/tool-results/x.txt`,
    ROOT,
    START,
    rulesOf({}),
    "/home/me",
    [CLAUDE_TRUSTED],
  );
  assertEquals(out.verdict, "allow");
});

Deno.test("輸入重導向 < 目標範圍檢查（第4條中央前置規則）", () => {
  assertEquals(only("cat < /etc/passwd").kind, "ask");
  assertEquals(only("grep pat < /etc/shadow").kind, "ask");
  assertEquals(only("cat < src/a.ts").kind, "allow");           // in-project
  assertEquals(only("head < src/x.ts").kind, "allow");          // in-project（其他讀指令同理）
  assertEquals(only("cat < $VAR").kind, "ask");                  // 動態 target
  assertEquals(only("cat <<EOF\nx\nEOF").kind, "allow");         // heredoc 非 `<`，不受此規則
});

Deno.test("輸入重導向（範圍外 <）為不可升級中央前置：Bash() 不升級、維持 ask", () => {
  // 行為變更：範圍外 < 為中央前置安全 ask，permissions.allow 不可解除
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "ask");
});

Deno.test("輸入重導向 ask 可被 Read() 讀取範圍放寬升級", () => {
  // rulesWithRead 為 classify_test.ts 既有 helper（將 Read(...) 規則轉成 readScope.allow）
  assertEquals(onlyWith("cat < /etc/passwd", rulesWithRead(["Read(//etc/passwd)"])).kind, "allow");
});

Deno.test("命令規則硬 deny 不被中央前置 ask 遮蔽，且不可由 Bash() 升級", () => {
  // 遞迴根掃描 → 硬 deny；即使疊加寫入重導向 / 輸入重導向 / 賦值前綴，deny 仍優先
  assertEquals(only("find / > out.txt").kind, "deny");
  assertEquals(only("find / < /etc/passwd").kind, "deny");
  assertEquals(only("FOO=1 find /").kind, "deny");
  // 不可由廣域 Bash(find *) 升級（硬 deny 短路、不經升級層）
  assertEquals(onlyWith("find / > out.txt", rulesOf({ allow: ["Bash(find *)"] })).kind, "deny");
  assertEquals(onlyWith("find / < /etc/passwd", rulesOf({ allow: ["Bash(find *)"] })).kind, "deny");
});

function classifyWithHome(src: string, rules: PermissionRules, home: string | null) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules, home);
}

Deno.test("classify: settings ~ allow + // command upgrades to allow", () => {
  assertEquals(
    classifyWithHome(
      "/home/me/proj//tool.sh --x",
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      "/home/me",
    ).kind,
    "allow",
  );
});

Deno.test("classify: settings absolute allow + // command upgrades (home null)", () => {
  assertEquals(
    onlyWith("/opt/t//run.sh --x", rulesOf({ allow: ["Bash(/opt/t/run.sh *)"] })).kind,
    "allow",
  );
});

Deno.test("中央前置不可升級：寫入重導向 × allowlisted / 非-allowlist", () => {
  // allowlisted：cat 規則本會 allow，但寫入重導向覆寫、且不可由 Bash(cat:*) 升級
  assertEquals(onlyWith("cat src/a.ts > out.txt", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  // 非-allowlist：npm 未列入 allowlist，寫入重導向不可由 Bash(npm test:*) 升級
  assertEquals(onlyWith("npm test x > out.txt", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：cwd 超範圍 × allowlisted / 非-allowlist", () => {
  const allowlisted = walk(parseCommand("cd /tmp && cat a").script, START, ROOT)
    .find((i) => i.name === "cat")!;
  assertEquals(classify(allowlisted, ROOT, rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  const nonAllow = walk(parseCommand("cd /tmp && npm test").script, START, ROOT)
    .find((i) => i.name === "npm")!;
  assertEquals(classify(nonAllow, ROOT, rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：賦值前綴 × allowlisted / 非-allowlist（維持 ask）", () => {
  assertEquals(onlyWith("FOO=bar cat a", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");
  assertEquals(onlyWith("FOO=bar npm test", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("中央前置不可升級：範圍外 < × allowlisted / 非-allowlist", () => {
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "ask");
  assertEquals(onlyWith("npm test < /etc/passwd", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "ask");
});

Deno.test("指令規則 allow 被中央前置覆寫、不洩漏成 allow", () => {
  // cat README.md / pwd 規則本會 allow；疊加各中央前置觸發條件 + 會命中的 Bash() 仍為 ask
  assertEquals(onlyWith("cat README.md > out.txt", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask"); // 寫入重導向
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat:*)"] })).kind, "ask");       // 範圍外 <
  const outCwd = walk(parseCommand("cd /tmp && pwd").script, START, ROOT)
    .find((i) => i.name === "pwd")!;                                                                  // cwd 超範圍
  assertEquals(classify(outCwd, ROOT, rulesOf({ allow: ["Bash(pwd:*)"] })).kind, "ask");
});

Deno.test("可升級不退化：指令規則自身範圍外讀取 ask 仍可由 Bash() 升級", () => {
  // grep 對 /etc/passwd → 規則 ask（非中央前置）→ 可升級為 allow
  assertEquals(onlyWith("grep needle /etc/passwd", rulesOf({ allow: ["Bash(grep *)"] })).kind, "allow");
});

/** 整條指令鏈的最終決策（session cwd 預設為專案內）。 */
function decide(src: string, start: CwdState = START) {
  return evaluate(src, ROOT, start);
}

/** 單一葉指令的判定，可指定 sessionCwdInScope，用於直接檢驗護欄 2。 */
function leaf(
  src: string,
  name: string,
  sessionInScope: boolean,
  start: CwdState = START,
  rules?: PermissionRules,
) {
  const invs = walk(parseCommand(src).script, start, ROOT);
  const inv = invs.find((i) => i.name === name)!;
  return classify(inv, ROOT, rules, null, [], sessionInScope);
}

Deno.test("chain cd out of project no longer asks for cwd-independent commands", () => {
  assertEquals(decide("cd /tmp && echo hi").verdict, "allow");
  assertEquals(decide("cd /tmp && pwd").verdict, "allow");
  assertEquals(decide("cd /tmp && whoami").verdict, "allow");
});

Deno.test("guardrail 1: a settings.allow upgrade never grants the exemption", () => {
  // gh api --input 讀本地檔 → 規則自身判 ask；即使 permissions.allow 命中也不得豁免
  const rules = rulesOf({ allow: ["Bash(gh api:*)"] });
  assertEquals(leaf("cd /tmp && gh api x --input body.json", "gh", true, START, rules).kind, "ask");
  // 對照：同一條規則在專案內 cwd 下會被升級成 allow
  assertEquals(onlyWith("gh api x --input body.json", rules).kind, "allow");
});

Deno.test("guardrail 2 blocks the leaf itself, not just the chain", () => {
  const dirty: CwdState = { kind: "known", path: "/outside" };
  assertEquals(leaf("cd . && echo hi", "echo", false, dirty).kind, "ask");
  assertEquals(leaf("cd /tmp && echo hi", "echo", false, dirty).kind, "ask");
  assertEquals(leaf("cd /tmp && echo hi", "echo", true).kind, "allow");
});

Deno.test("evaluate derives session trust from the initial cwd, not a caller flag", () => {
  const dirty: CwdState = { kind: "known", path: "/outside" };
  // evaluate 自己算出 sessionCwdInScope=false，整條鏈必須 ask
  assertEquals(decide("cd . && echo hi", dirty).verdict, "ask");
  assertEquals(decide("cd /tmp && echo hi", dirty).verdict, "ask");
  // gh 的寬鬆 endpoint 述詞會成功，但起點不可信仍不得豁免
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50", dirty).verdict, "ask");
  // 逐葉斷言：確認擋下的是 gh 葉指令本身，而不是被前面的 cd 葉指令遮蔽
  assertEquals(
    leaf("cd /tmp && gh api repos/o/r/tags?per_page=50", "gh", false, dirty).kind,
    "ask",
  );
  assertEquals(leaf("cd . && gh api repos/o/r/tags?per_page=50", "gh", false, dirty).kind, "ask");
  // 對照：起點可信時同一個 gh 葉指令才豁免
  assertEquals(
    leaf("cd /tmp && gh api repos/o/r/tags?per_page=50", "gh", true).kind,
    "allow",
  );
});

Deno.test("guardrail 3: path operands are still resolved against the real cwd", () => {
  assertEquals(decide("cd /tmp && head -100 a.txt").verdict, "ask");
});

Deno.test("guardrail 4: a non-static token blocks the exemption", () => {
  assertEquals(decide("cd /tmp && echo *").verdict, "ask");
  assertEquals(decide("cd /tmp && grep *").verdict, "ask");
  assertEquals(decide("cd /tmp && head -100 *.log").verdict, "ask");
});

Deno.test("guardrail: which is never cwd-independent (PATH may contain .)", () => {
  assertEquals(decide("cd /tmp && which some-name").verdict, "ask");
});

Deno.test("the other central preflight rules still fire under the exemption", () => {
  assertEquals(decide("cd /tmp && echo hi > out.txt").verdict, "ask"); // 寫入重導向
  assertEquals(decide("cd /tmp && FOO=1 echo hi").verdict, "ask"); // 賦值前綴
  assertEquals(decide("cd /tmp && head -1 < ../outside.txt").verdict, "ask"); // 範圍外 <
});

Deno.test("every non-declaring command still asks after a chain cd", () => {
  const cases = [
    // 隱含以 cwd 為操作對象
    "ls", "tree", "find . -name x", "rg pat", "git status", "deno test",
    // fileReaderRule 的其餘成員：與 head/wc 共用規則，必須確認沒有被順帶豁免
    "cat", "cut -c1", "tr a b", "nl", "fold -w 80", "column -t",
    "stat x", "cmp a b", "comm a b", "md5sum", "hexdump", "basename x", "dirname x",
    "realpath x", "readlink x",
    // 其他未宣告的規則
    "awk '{print}'", "yq '.'", "sort", "uniq", "xxd", "diff a b", "file x", "date -r x",
    "which some-name",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "ask", c);
  }
});

Deno.test("find's hard deny needs a real root; /tmp is only an ask", () => {
  // dangerousRoot 只對磁碟根 / 家目錄根 deny；/tmp 兩者都不是
  assertEquals(decide("cd /tmp && find . -name x").verdict, "ask");
  assertEquals(decide("cd /tmp && find / -name x").verdict, "deny");
  assertEquals(decide("cd / && find . -name x").verdict, "deny");
});

Deno.test("every declaring command takes the exemption in its read-only form", () => {
  const cases = [
    "head -100", "wc -l", "tail -200", "grep -E 'Retry'",
    "sed -n '600,750p'", "jq -r '.name'",
    "gh api repos/o/r/tags?per_page=50", "gh search code x --language go",
    "echo hi", "pwd", "whoami",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "allow", c);
  }
});

Deno.test("curl takes the exemption for a quoted allowed URL", () => {
  // classify_test.ts 既有的 webFetchRulesOf 提供 WebFetch 網域規則；
  // api.example.com 是該檔既有測試使用的網域（api.github.com 不在 preapproved 清單內）
  const rules = webFetchRulesOf({ allow: ["WebFetch(domain:api.example.com)"] });
  assertEquals(
    evaluate("cd /tmp && curl -s 'https://api.example.com/repos/o/r'", ROOT, START, rules).verdict,
    "allow",
  );
  // 未加引號的 `?` → curl 不套用寬鬆取值 → ask
  assertEquals(
    evaluate("cd /tmp && curl -s https://api.example.com/repos/o/r?x=1", ROOT, START, rules).verdict,
    "ask",
  );
  // 範圍外的 -H @file 以真實 cwd 檢查 → ask
  assertEquals(
    evaluate("cd /tmp && curl -s -H @../h.txt 'https://api.example.com/x'", ROOT, START, rules).verdict,
    "ask",
  );
  // 網域未放行 → ask（確認上面的 allow 真的來自網域規則，不是碰巧）
  assertEquals(
    evaluate("cd /tmp && curl -s 'https://not-allowed.test/x'", ROOT, START, rules).verdict,
    "ask",
  );
});

Deno.test("the same seven with a path operand or path flag still ask", () => {
  const cases = [
    "head -100 a.txt", "wc -l a.txt", "tail -200 a.txt", "grep pat a.txt",
    "sed -n '1p' a.txt", "jq -r '.name' a.json",
    "wc --files0-from=list", "grep --exclude-from=f pat", "jq -f prog.jq",
    "jq -L mods '.'", "sed -nfprog.sed p",
    "gh pr diff", "gh repo view", "gh api 'repos/{owner}/{repo}/issues'",
    "gh search code x --web", "gh api x --cache 1h", "gh api x --totally-unknown",
    "head --totally-unknown", "grep --totally-unknown pat", "sed --totally-unknown 'p'",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "ask", c);
  }
});

Deno.test("the baseline pipeline shapes now allow end to end", () => {
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/contents/pkg?ref=v1 | jq -r '.[].name'").verdict,
    "allow",
  );
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/x -H 'Accept: application/vnd.github.raw' 2>&1 | grep -A 10 -B 2 -E 'Retry|backoff'").verdict,
    "allow",
  );
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | wc -l").verdict, "allow");
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | sed -n '600,750p'").verdict, "allow");
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50 | head -100").verdict, "allow");
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | tail -200").verdict, "allow");
});

Deno.test("expansion invariance holds through the cwd exemption, not just evaluate", () => {
  // 原 token 與其任一展開結果，在「鏈內 cd 到專案外」的完整判定下必須一致
  const base = evaluate("cd /tmp && gh api repos/o/r/tags?per_page=50", ROOT, START).verdict;
  assertEquals(base, "allow");
  for (const ch of ["X", "-", "_", ".", "{", "}", "$", ";", " "]) {
    assertEquals(
      evaluate(`cd /tmp && gh api 'repos/o/r/tags${ch}per_page=50'`, ROOT, START).verdict,
      base,
      ch,
    );
  }
  // 大括號是唯一例外，且兩側都必須 ask —— 原 token 因護欄 ask、展開結果因佔位符不豁免
  assertEquals(evaluate("cd /tmp && gh api repos/o/r/x?owner}", ROOT, START).verdict, "ask");
  assertEquals(evaluate("cd /tmp && gh api 'repos/o/r/x{owner}'", ROOT, START).verdict, "ask");
});

/** 由單一 token 建出 argv 用的 Word。 */
function wordOfArg(token: string): Word {
  const cmd = parse(`x ${token}`).commands[0].command as Command;
  return cmd.suffix[0];
}

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
