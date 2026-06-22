import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import { evaluate } from "./evaluate.ts";
import type { CwdState } from "../types.ts";
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "../permissions/path_scope.ts";
import { EMPTY_DOMAIN_SCOPE, parseDomainRule } from "../permissions/domain_scope.ts";

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

Deno.test("輸入重導向 ask 可被 Bash() 升級", () => {
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "allow");
});

Deno.test("輸入重導向 ask 可被 Read() 讀取範圍放寬升級", () => {
  // rulesWithRead 為 classify_test.ts 既有 helper（將 Read(...) 規則轉成 readScope.allow）
  assertEquals(onlyWith("cat < /etc/passwd", rulesWithRead(["Read(//etc/passwd)"])).kind, "allow");
});
