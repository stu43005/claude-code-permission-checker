import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";

/**
 * GNU base64（coreutils 8.32）實測旗標：
 *   -d/--decode、-i/--ignore-garbage  不吃值
 *   -w/--wrap                         **吃值**（整數；0 = 不換行）
 * 無任何輸出到檔案的旗標，輸出恆為 stdout；無操作元時讀 stdin；只接受單一 FILE。
 *
 * 刻意獨立於 fileReaderRule：那裡的 valueFlags 會套用到全部 names，而 md5sum /
 * sha256sum 的 -w 是不吃值的 --warn，混用會讓 `md5sum -c -w /outside/checksums`
 * 失去唯一的路徑操作元而誤放行。
 */
const BASE64_SPEC: CommandSpec = {
  flags: [
    ...["-d", "--decode", "-i", "--ignore-garbage"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-w", "--wrap"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
};

export const base64Rule: CommandRule = flagGatedReader({
  names: ["base64"],
  spec: () => BASE64_SPEC,
});
