import type { CommandRule } from "../types.ts";
import { allow } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, type FlagMatcher, hasAnyFlag } from "../flags.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";

/** head / wc 的旗標表。只有這兩個成員參與 cwd 豁免，故只為它們建模。 */
const HEAD_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-c", "--bytes", "-n", "--lines"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
  numericShorthand: true, // head -100
  globOperands: true, // 固定清單成員：旗標被 glob 注入也無害
};

const WC_SPEC: CommandSpec = {
  flags: [
    ...["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    { name: "--files0-from", value: "required", valueIsPath: true },
  ],
  positionals: "paths",
  globOperands: true, // 固定清單成員；注入 --files0-from 的殘留風險為已接受限制
};

const SPECS: Record<string, CommandSpec> = { head: HEAD_SPEC, wc: WC_SPEC };

/**
 * 會把非 flag 參數當作要讀取 / 解析的路徑，需做範圍檢查（spec line 218 要求整份
 * 清單皆「路徑做範圍檢查」）。basename/dirname/realpath/readlink 接受路徑操作元，
 * 故一併納入受範圍檢查的群組。
 */
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // head / wc 走 CommandSpec；其餘成員沿用下方 legacy 設定，且一律不參與 cwd 豁免。
  spec: (name) => SPECS[name],
  // 這些旗標的值是會被讀取的路徑，過去被當一般 flag 跳過而未檢查：
  //   wc       --files0-from=F      從 F 讀 NUL 分隔的檔名清單
  //   realpath --relative-to=DIR / --relative-base=DIR
  valueFlags: [exact("--files0-from", "--relative-to", "--relative-base")],
  pathValueFlags: ["--files0-from", "--relative-to", "--relative-base"],
  // 這些指令無「會寫檔」的 flag；故 askFlags 留空。
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
  cwdIndependentWhenNoPaths: true,
  // ls 無操作元時列出 cwd。其餘未提供 spec 的成員由「無 spec → 不豁免」自動排除。
  cwdDependentNames: ["ls"],
});

/**
 * diff：位置參數做範圍檢查，且吃路徑值的旗標也需範圍檢查。
 * `pathValueFlags` 的比對只涵蓋 `-X val` / `-Xval` / `--exclude-from=val` 三種形式；
 * 群集寫法（`-qX../out.txt`）不在其中，值會被整個跳過而未檢查。
 * 群集形式罕見且難以在此 factory 內正確拆解，故直接列入 askFlags 保守處理。
 */
// GNU diff 也接受數字短選項（`-u0`、`-U3` 的簡寫形式），故群集字元類必須含數字：
// `-u0X../out.txt` 若只比對 [A-Za-z]{2,} 會整個漏掉，其 -X 的值便不會被檢查。
const diffClusterHasPathFlag: FlagMatcher = (t) =>
  !t.startsWith("--") && /^-[A-Za-z0-9]{2,}/.test(t) && /[XS]/.test(t.slice(1));

export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  askFlags: [diffClusterHasPathFlag],
  askReason: () => "diff：-X / -S 的群集寫法無法可靠取得其路徑值",
  valueFlags: [exact("--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file")],
  pathValueFlags: ["--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file"],
});

/**
 * 不接受檔案路徑操作元、且無寫入能力的純工具：一律 allow。
 * cwd 無關宣告排除 `which`：它依 PATH 逐段搜尋，而 PATH 合法地可能含 `.` 或空字串段，
 * 兩者都相對於 cwd 解析 —— `cd /outside && which x` 等於探測 /outside/x 是否存在。
 * 執行期 PATH 無法靜態得知，故一律不豁免。
 */
export const pureUtilRule: CommandRule = {
  names: ["echo", "pwd", "whoami", "which"],
  evaluate: () => allow(),
  cwdIndependent: (ctx) => ctx.name !== "which",
};

/** cd 本身不寫檔（cwd 變動由 walk 處理）：一律 allow。 */
export const cdRule: CommandRule = {
  names: ["cd"],
  evaluate: () => allow(),
};
