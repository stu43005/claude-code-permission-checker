import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 查 registry、不把本機專案內容當成輸出的子指令。
 * 刻意不含 ls/outdated/explain/root/prefix/pkg get/config get——實測它們會沿目錄樹
 * 向上找 package.json 並把父層專案的內容印出來（`npm pkg get name` 印出父層 name、
 * `npm prefix` 印出父層路徑、`npm ls` 印出父層專案），而那個位置可能落在允許範圍外、
 * 且沒有操作元可供本工具檢查。
 */
const VIEW_SUBCOMMANDS = new Set(["view", "info", "show", "v"]);
/** 不吃操作元、也不輸出本機專案內容的子指令。 */
const NO_OPERAND_SUBCOMMANDS = new Set(["ping", "whoami"]);

/** 只影響輸出格式或查詢範圍的旗標（不吃值）。 */
const SAFE_VALUELESS_FLAGS = new Set([
  "--json", "-j", "--long", "-l", "--parseable", "-p",
  "--unicode", "--no-unicode", "--color", "--no-color",
  "--offline", "--prefer-offline", "--prefer-online",
]);
/** 安全且吃值的旗標。 */
const SAFE_VALUE_FLAGS = new Set(["--otp"]);
/** 無子指令時允許的單獨旗標。 */
const VERSION_FLAGS = new Set(["--version", "-v"]);
/**
 * 會被 npm 的解析器當成「前一個旗標的值」而吃掉的 token。
 * 布林旗標吃 `true`/`false`；`--color`/`--no-color` 另外吃 `always`。
 */
const FLAG_VALUE_WORDS = new Set(["true", "false", "always"]);

/**
 * registry package spec 形態。npm 以 npm-package-arg 解析操作元，除 registry spec 外
 * 也接受目錄、檔案、tarball、URL 與 git spec 並實際讀取本機目標——實測
 * `npm view <含 package.json 的目錄>` 會印出該 package.json 的內容。
 *
 * 允許：可選 `@scope/` 前綴 + 套件名 + 可選 `@version|range|tag`。
 * 拒絕：以 . / ~ - 開頭、含 \ 或 :、除 scope 外再含 /、以 tarball 副檔名結尾。
 */
const TARBALL_SUFFIXES = [".tgz", ".tar", ".tar.gz"];

/** 套件名：字母數字開頭，其後允許 . _ - 與字母數字。 */
const PKG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * 版本／range／tag 後綴：允許字母數字與常見 range 符號（. - + ^ ~ > < = * | 空白）。
 * **不得含 `/`、`\`、`:`**——`pkg@..` 會被 npm-package-arg 解析成指向上層目錄的本地 spec。
 */
const PKG_SUFFIX = /^[A-Za-z0-9._\-+^~><=*| ]+$/;

function isValidSuffix(suffix: string): boolean {
  if (suffix === "") return false;
  // 前後空白一律拒絕。允許中間的空白是為了支援合法 range（`>=1.0.0 <2.0.0`、`1.0.0 - 2.0.0`），
  // 但 `pkg@. ` 這種靠尾隨空白偽裝的形態必須擋下。
  if (suffix !== suffix.trim()) return false;
  // 以 `.` 開頭一律拒絕:npm-package-arg 會把 `pkg@.`、`pkg@..`、`pkg@.hidden`
  // 一併解析成本地目錄 spec,而非 registry 上的版本。
  // 中段的 `.` 與 `..` 不受影響(`pkg@release..candidate` 是合法 tag)。
  if (suffix.startsWith(".")) return false;
  return PKG_SUFFIX.test(suffix);
}

function isRegistrySpec(value: string): boolean {
  if (value === "") return false;
  if (/^[.~/\-]/.test(value)) return false;
  if (value.includes("\\") || value.includes(":")) return false;
  // 實測：裸名帶 tarball 副檔名會被判為本地檔（`npm view archive.tgz` → file:archive.tgz, ENOENT）
  const lower = value.toLowerCase();
  if (TARBALL_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  let rest = value;
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash === -1) return false; // `@foo` 不是合法 scope spec
    const scope = rest.slice(1, slash);
    if (!PKG_NAME.test(scope)) return false;
    rest = rest.slice(slash + 1);
  }
  if (rest === "" || rest.includes("/")) return false;
  const at = rest.indexOf("@");
  if (at === -1) return PKG_NAME.test(rest);
  // 有版本後綴：名稱與後綴都必須合法。只驗名稱會放過 `pkg@..`（本地目錄 spec）。
  return PKG_NAME.test(rest.slice(0, at)) && isValidSuffix(rest.slice(at + 1));
}

/**
 * npm：子指令 + 操作元雙層 allowlist。
 *
 * 注意本規則**管不到**的事：所有 npm 呼叫都會在 dispatch 子指令前載入設定，沿目錄樹向上找
 * local prefix 並讀取該處 `.npmrc`——實測在祖先目錄放 package.json 與設定 logs-dir 的 .npmrc，
 * `npm view` 的 debug log 就會寫進該處。同一機制亦可重導 cache 與 registry。這是 npm 的既有
 * 設定模型，無法靠挑選子指令規避，也不由本規則處理；放行 npm 即等於接受這層行為。
 */
export const npmRule: CommandRule = {
  names: ["npm"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const tokens: string[] = [];
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t === null) return ask("npm：含動態 token，無法靜態判定");
      tokens.push(t);
    }

    let subcommand: string | null = null;
    const operands: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-") && t !== "-") {
        if (VERSION_FLAGS.has(t)) {
          // --version / -v 同樣是布林旗標，會吃掉其後的 true/false
          if (FLAG_VALUE_WORDS.has(tokens[i + 1])) {
            return ask(`npm：${t} 後接旗標值，操作元數量無法靜態判定`);
          }
          continue;
        }
        const eq = t.indexOf("=");
        const name = eq === -1 ? t : t.slice(0, eq);
        if (SAFE_VALUELESS_FLAGS.has(name)) {
          if (eq !== -1) return ask(`npm：未列入安全集合的旗標形式 ${t}`);
          // npm 的解析器會讓這些旗標吃掉其後的值（布林旗標吃 true/false，
          // --color/--no-color 另外吃 always）。若這裡照樣把該 token 當成位置參數，
          // `npm view --json true`、`npm view --color always` 會被誤認為「有操作元」，
          // 實際上 npm 收到的是零操作元、於是改查當前專案——正是本規則要擋的形態。
          if (FLAG_VALUE_WORDS.has(tokens[i + 1])) {
            return ask(`npm：${name} 後接旗標值，操作元數量無法靜態判定`);
          }
          continue;
        }
        if (SAFE_VALUE_FLAGS.has(name)) {
          if (eq !== -1) {
            if (t.slice(eq + 1) === "") return ask(`npm：${name} 的值為空`);
            continue;
          }
          i++; // 吃掉下一個 token 當值
          if (i >= tokens.length) return ask(`npm：${name} 缺少值`);
          // 下一個 token 若長得像旗標，npm 的解析器會把它當成獨立選項而非本旗標的值。
          // 若這裡照吃，`npm view x --otp --cache=/outside` 會讓 --cache 整個躲過檢查。
          if (tokens[i].startsWith("-")) return ask(`npm：${name} 的值缺失（其後是另一個旗標）`);
          continue;
        }
        // 未列入安全集合者一律 ask——同時涵蓋 --prefix/--userconfig/--globalconfig/
        // --cache/--script-shell/--node-options/--editor/-g/--global/
        // --foreground-scripts/--registry/-w/--workspace，並免疫 npm 版本漂移
        return ask(`npm：未列入安全集合的旗標 ${name}`);
      }
      if (subcommand === null) subcommand = t;
      else operands.push(t);
    }

    if (subcommand === null) {
      // 無子指令：只有 `npm --version` / `npm -v` 安全
      return tokens.some((t) => VERSION_FLAGS.has(t))
        ? allow()
        : ask("npm：無子指令，只有 --version / -v 可自動放行");
    }

    if (NO_OPERAND_SUBCOMMANDS.has(subcommand)) {
      if (operands.length > 0) return ask(`npm ${subcommand}：不預期的操作元`);
      return allow();
    }

    if (!VIEW_SUBCOMMANDS.has(subcommand)) {
      return ask(`npm：子指令 ${subcommand} 未列入唯讀 allowlist`);
    }

    // 無操作元時 view 會改為檢視「當前專案」，觸發向上探索 → ask
    if (operands.length === 0) {
      return ask("npm view：無操作元時會檢視當前專案（向上探索 package.json）");
    }
    // 第一個操作元是 package spec，其餘是輸出欄位選擇（如 `npm view pkg version`）
    if (!isRegistrySpec(operands[0])) {
      return ask(`npm view：操作元不是 registry package spec（${operands[0]}）`);
    }
    return allow();
  },
  // 不宣告 cwdIndependent：npm 的 effective prefix 由 cwd 決定。
};
