import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { nonPathStaticValue, staticValue } from "../../engine/word.ts";

/** 各 gh 指令的唯讀子指令。`gh repo clone` / `gh release download` 會寫本地檔 → 不在此列。 */
const READ_SUBS: Record<string, Set<string>> = {
  repo: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  release: new Set(["view", "list"]),
};

/** 開啟本機瀏覽器 / 寫入本機快取：對所有子指令一律 ask。 */
const SIDE_EFFECT_LONG = new Set(["--web", "--cache"]);
const SIDE_EFFECT_SHORT = new Set(["w"]);

/** 送出 request body 或非 GET 方法 → 寫入請求。 */
const MUTATING_LONG = new Set(["--method", "--field", "--raw-field", "--input"]);
const MUTATING_SHORT = new Set(["X", "f", "F"]);

const COMMON_NO_VALUE = ["-h", "--help"];
const COMMON_ONE_VALUE = ["--json", "-q", "--jq", "-t", "--template"];
const API_NO_VALUE = ["--paginate", "--silent", "--slurp", "-i", "--include", "--verbose"];
const API_ONE_VALUE = [
  "-H", "--header", "--hostname", "-p", "--preview", "-X", "--method",
  "--cache", "--input", "-f", "--raw-field", "-F", "--field",
];
const SEARCH_NO_VALUE = ["--archived", "-w", "--web"];
const SEARCH_ONE_VALUE = [
  "-L", "--limit", "-R", "--repo", "--owner", "--language", "--match", "--sort",
  "--order", "--state", "--filename", "--extension", "--size", "--label",
  "--author", "--assignee", "--created", "--updated", "--visibility", "--include-forks",
];
const READ_NO_VALUE = ["--patch", "--name-only", "-w", "--web"];
const READ_ONE_VALUE = [
  "-R", "--repo", "-L", "--limit", "-s", "--state", "--label", "--author",
  "--assignee", "--search", "--color", "-e", "--exclude",
];

function tablesFor(command: string): { noValue: Set<string>; oneValue: Set<string> } {
  if (command === "api") {
    return {
      noValue: new Set([...COMMON_NO_VALUE, ...API_NO_VALUE]),
      oneValue: new Set([...COMMON_ONE_VALUE, ...API_ONE_VALUE]),
    };
  }
  if (command === "search") {
    return {
      noValue: new Set([...COMMON_NO_VALUE, ...SEARCH_NO_VALUE]),
      oneValue: new Set([...COMMON_ONE_VALUE, ...SEARCH_ONE_VALUE]),
    };
  }
  return {
    noValue: new Set([...COMMON_NO_VALUE, ...READ_NO_VALUE]),
    oneValue: new Set([...COMMON_ONE_VALUE, ...READ_ONE_VALUE]),
  };
}

interface GhParse {
  /** 解析階段即可決定的否決理由；非 null 時其餘欄位不可信。 */
  reject: string | null;
  command: string;
  /** 子指令之後的位置操作元（已排除所有旗標與旗標值）。 */
  operands: string[];
  /** 被寬鬆取值救回的操作元在 argv 中的索引；無則 -1。 */
  relaxedIdx: number;
  sideEffect: boolean;
  mutating: boolean;
  unknownFlag: string | null;
}

const CACHE = new WeakMap<RuleContext, GhParse>();

/** 每個 RuleContext 只解析一次；evaluate 與兩個述詞讀同一份結果。 */
function parseGh(ctx: RuleContext): GhParse {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doParseGh(ctx);
  CACHE.set(ctx, r);
  return r;
}

const reject = (reason: string): GhParse => ({
  reject: reason, command: "", operands: [], relaxedIdx: -1,
  sideEffect: false, mutating: false, unknownFlag: null,
});

function doParseGh(ctx: RuleContext): GhParse {
  const argv = ctx.argv;
  const toks = argv.map((w) => staticValue(w));
  const nullCount = toks.filter((t) => t === null).length;
  if (nullCount > 1) return reject("gh：含一個以上動態 token，無法靜態判定");

  // 子指令 = 第一個「不是旗標、也不是前置旗標的值」的 token。
  // 不能單純找第一個非 `-` 開頭者：`gh -X GET api …` 的 `GET` 是 -X 的值，不是子指令。
  // 前置旗標的 arity 不可能依賴尚未確定的子指令，故此處以**所有子指令共用的**吃值旗標集合
  // 保守消化；任一子指令專屬的吃值旗標寫在子指令之前時，其值會被當成子指令而落入
  // 「未列入唯讀 allowlist」→ ask（安全方向）。
  const LEADING_ONE_VALUE = new Set([
    ...COMMON_ONE_VALUE, "-X", "--method", "-H", "--header", "--hostname",
    "-p", "--preview", "--cache", "--input", "-f", "--raw-field", "-F", "--field",
  ]);
  let cmdIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === null) break; // 動態 token 在子指令前 → 無法判定
    if (t === "--") { cmdIdx = i + 1 < toks.length ? i + 1 : -1; break; }
    if (!t.startsWith("-") || t === "-") { cmdIdx = i; break; }
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    // 長旗標吃值且未用 `=` 黏寫 → 下一 token 是值，跳過
    if (t.startsWith("--") && LEADING_ONE_VALUE.has(name) && eq === -1) { i++; continue; }
    // 短旗標群集：最後一個字母若吃值且同 token 無剩餘字元 → 下一 token 是值
    if (!t.startsWith("--")) {
      const last = `-${t[t.length - 1]}`;
      if (LEADING_ONE_VALUE.has(last)) { i++; continue; }
    }
  }
  if (cmdIdx === -1 || toks[cmdIdx] === null) {
    return reject("gh：未指定指令或指令為動態");
  }
  const command = toks[cmdIdx]!;
  const tables = tablesFor(command);

  const operandIdxs: number[] = [];
  let sideEffect = false;
  let mutating = false;
  let unknownFlag: string | null = null;
  let optionsDone = false;

  // gh 接受子指令**之前**的旗標（`gh -XPOST api …`、`gh --cache=1h api …` 皆有效），
  // 故掃描必須從 index 0 開始，而不是從 cmdIdx + 1。子指令本身在迴圈中被當成位置操作元
  // 出現，於下方以 `i === cmdIdx` 跳過。
  for (let i = 0; i < argv.length; i++) {
    if (i === cmdIdx) continue; // 子指令 token 本身
    const t = toks[i];
    if (t === null) { operandIdxs.push(i); continue; } // 唯一的 null：只可能是操作元
    if (optionsDone || !t.startsWith("-") || t === "-") { operandIdxs.push(i); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (SIDE_EFFECT_LONG.has(name)) sideEffect = true;
      if (MUTATING_LONG.has(name)) {
        if (name === "--method") {
          const val = inline ?? (i + 1 < argv.length ? toks[i + 1] : null);
          if ((val ?? "").toUpperCase() !== "GET") mutating = true;
        } else mutating = true;
      }
      if (tables.noValue.has(name)) { if (inline !== null) unknownFlag ??= name; continue; }
      if (tables.oneValue.has(name)) { if (inline === null) i++; continue; }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：逐字母。吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token。
    // 群集內的 X / f / F 同樣算寫入旗標（`-iXPOST` 必須被攔下）。
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      const short = `-${c}`;
      if (SIDE_EFFECT_SHORT.has(c)) sideEffect = true;
      if (MUTATING_SHORT.has(c)) {
        if (c === "X") {
          const rest = t.slice(k + 1);
          const val = rest !== "" ? rest : (i + 1 < argv.length ? toks[i + 1] : null);
          if ((val ?? "").toUpperCase() !== "GET") mutating = true;
        } else mutating = true;
      }
      if (tables.noValue.has(short)) continue;
      if (tables.oneValue.has(short)) { if (t.slice(k + 1) === "") i++; ate = true; break; }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 子指令前若出現位置操作元（`gh x api …`），形式不明 → 保守否決
  if (operandIdxs.some((i) => i < cmdIdx)) {
    return reject("gh：子指令之前出現位置參數，形式無法判定");
  }

  // 唯一的 null token 必須就是 api 之後的第一個位置操作元，且只有 gh api 可救
  let relaxedIdx = -1;
  const operands: string[] = [];
  for (const idx of operandIdxs) {
    const t = toks[idx];
    if (t !== null) { operands.push(t); continue; }
    if (command !== "api" || idx !== operandIdxs[0]) {
      return reject("gh：動態 token 不在 endpoint 位置");
    }
    const relaxed = nonPathStaticValue(argv[idx]);
    if (relaxed === null || relaxed.value.startsWith("-")) {
      return reject("gh：含動態 token，無法靜態判定");
    }
    // endpoint 的萬用字元必須落在第一個 `/` 之後，確保第一段（repos / orgs / …）為字面。
    // 位置判定**必須**用 relaxed.globIndex 與 relaxed.raw：對 relaxed.value 重跑
    // firstGlobMetacharIndex 會因 quote removal 抹除跳脫資訊而誤判。
    if (relaxed.globIndex !== -1) {
      const slash = relaxed.raw.indexOf("/");
      if (slash === -1 || relaxed.globIndex <= slash) {
        return reject(`gh api：endpoint 的萬用字元位置不安全（${relaxed.value}）`);
      }
      // `?` 可以展開成 `{` 或 `}`：`repos/o/r/x?owner}` 若 cwd 下有檔案
      // `repos/o/r/x{owner}`，展開後 endpoint 就含 {owner}，而含佔位符者不得享有 cwd
      // 豁免 —— 豁免判定會因此隨檔案系統改變。故被救回的 endpoint 不得含 `{` 或 `}`。
      if (relaxed.value.includes("{") || relaxed.value.includes("}")) {
        return reject("gh api：endpoint 含 { 或 }，展開後可能形成 cwd 佔位符");
      }
    }
    relaxedIdx = idx;
    operands.push(relaxed.value);
  }
  if (nullCount === 1 && relaxedIdx === -1) {
    return reject("gh：含動態 token，無法靜態判定");
  }

  return { reject: null, command, operands, relaxedIdx, sideEffect, mutating, unknownFlag };
}

/** endpoint 含由 cwd 的 git repository 填值的佔位符。 */
function hasCwdPlaceholder(endpoint: string): boolean {
  return endpoint.includes("{owner}") || endpoint.includes("{repo}") ||
    endpoint.includes("{branch}");
}

export const ghRule: CommandRule = {
  names: ["gh"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const p = parseGh(ctx);
    if (p.reject !== null) return ask(p.reject);
    if (p.sideEffect) {
      return ask("gh：-w/--web 會開啟本機瀏覽器、--cache 會寫入本機快取");
    }
    if (p.unknownFlag !== null) {
      return ask(`gh ${p.command}：未列入安全集合的旗標 ${p.unknownFlag}`);
    }
    if (p.command === "search") return allow();
    if (p.command === "api") {
      return p.mutating ? ask("gh api：非 GET（寫入）請求") : allow();
    }
    const readSubs = READ_SUBS[p.command];
    if (!readSubs) return ask(`gh ${p.command}：未列入唯讀 allowlist`);
    const sub = p.operands[0];
    if (sub === undefined) return ask(`gh ${p.command}：未指定子指令`);
    return readSubs.has(sub) ? allow() : ask(`gh ${p.command} ${sub}：非唯讀操作`);
  },

  /**
   * 只有 api 與 search 的目標由 endpoint / query 決定，不看 cwd。
   * repo view / issue list / pr diff… 未給 --repo 時會以 cwd 所在的 git repository
   * 推斷目標倉庫；api 的 endpoint 含 {owner}/{repo}/{branch} 時同樣由 cwd 的 repo 填值。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const p = parseGh(ctx);
    if (p.reject !== null || p.sideEffect || p.unknownFlag !== null) return false;
    if (p.command !== "api" && p.command !== "search") return false;
    if (p.command === "api") {
      if (p.mutating) return false;
      const endpoint = p.operands[0];
      if (endpoint !== undefined && hasCwdPlaceholder(endpoint)) return false;
    }
    return true;
  },

  /** 唯一容忍的非靜態 token 是 api 的 endpoint 操作元。 */
  toleratesNonStaticOperand(ctx: RuleContext): boolean {
    const p = parseGh(ctx);
    return p.reject === null && p.command === "api" && p.relaxedIdx >= 0;
  },
};
