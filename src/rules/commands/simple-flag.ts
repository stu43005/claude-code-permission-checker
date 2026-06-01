import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, prefix } from "../flags.ts";

export const sortRule: CommandRule = flagGatedReader({
  names: ["sort"],
  askFlags: [exact("-o", "--output", "-T", "--temporary-directory"), prefix("-o", "--output=", "-T", "--temporary-directory=")],
  valueFlags: [exact("-o", "-T", "-S", "-k", "-t", "--output", "--temporary-directory", "--buffer-size", "--key", "--field-separator")],
  askReason: () => "sort：-o / -T 會寫檔或指定暫存目錄",
});

export const yqRule: CommandRule = flagGatedReader({
  names: ["yq"],
  askFlags: [exact("-i", "--inplace", "--in-place")],
  valueFlags: [exact("-o", "--output-format", "-p", "--input-format")],
  askReason: () => "yq：-i / --inplace 會就地修改輸入檔",
});

export const treeRule: CommandRule = flagGatedReader({
  names: ["tree"],
  askFlags: [exact("-o"), prefix("-o")],
  valueFlags: [exact("-o", "-L", "-P", "-I")],
  askReason: () => "tree：-o 會把輸出寫入檔案",
});

export const fileCmdRule: CommandRule = flagGatedReader({
  names: ["file"],
  askFlags: [exact("-C", "--compile")],
  valueFlags: [exact("-m", "--magic-file", "-f", "--files-from")],
  askReason: () => "file：-C / --compile 會寫出 magic.mgc",
});

export const dateRule: CommandRule = flagGatedReader({
  names: ["date"],
  askFlags: [exact("-s", "--set"), prefix("--set=", "-s")],
  valueFlags: [exact("-d", "--date", "-r", "--reference", "-f", "--file")],
  askReason: () => "date：-s / --set 會修改系統時間",
});
