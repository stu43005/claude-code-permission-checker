import type { CommandRule } from "../types.ts";
import { allow } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, hasAnyFlag } from "../flags.ts";

/**
 * 會把非 flag 參數當作要讀取 / 解析的路徑，需做範圍檢查（spec line 218 要求整份
 * 清單皆「路徑做範圍檢查」）。basename/dirname/realpath/readlink 接受路徑操作元，
 * 故一併納入受範圍檢查的群組。
 */
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // 這些指令無「會寫檔」的 flag（已於 spec 查證）；故 askFlags 留空。
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
});

/** diff：位置參數做範圍檢查，且 --from-file / --to-file 路徑值也需範圍檢查。 */
export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  pathValueFlags: ["--from-file", "--to-file"],
});

/** 不接受檔案路徑操作元、且無寫入能力的純工具：一律 allow。 */
export const pureUtilRule: CommandRule = {
  names: ["echo", "pwd", "whoami", "which"],
  evaluate: () => allow(),
};

/** cd 本身不寫檔（cwd 變動由 walk 處理）：一律 allow。 */
export const cdRule: CommandRule = {
  names: ["cd"],
  evaluate: () => allow(),
};
