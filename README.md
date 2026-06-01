# Bash 權限檢查器（Claude Code PreToolUse hook）

解析 Bash 指令，僅在「純唯讀且全部落在當前專案內」時自動 `allow`，其餘 `ask`。
永不 `deny`。詳見 `docs/superpowers/specs/2026-05-29-bash-permission-checker-design.md`。

## 建置

```bash
deno task build
# 產出 dist/permission-checker（Windows 為 dist/permission-checker.exe）
```

## 接線（`~/.claude/settings.json`）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "D:/path/to/dist/permission-checker.exe" }
        ]
      }
    ]
  }
}
```

> **Windows 路徑風格（重要）**：`command` 一律用**正斜線**（`D:/path/.../x.exe`）。
> 無 `args` 的 `type: "command"` hook 在 Windows 上以 Git Bash 執行命令字串，bash 會把
> **反斜線當跳脫字元**——`D:\path\...\x.exe` 會被改寫成 `D:path...x.exe` 而 command
> not found（exit 127），hook 形同靜默失效。正斜線在 Git Bash 與直接執行兩種模式下皆可。

## 開發

```bash
deno task test    # 單元 + 整合測試
deno task check   # 型別檢查
deno task lint
```

## 新增信任指令

在 `src/rules/commands/` 新增一個 `CommandRule`（或調整既有規則），於
`src/rules/allowlist.ts` 註冊，重新 `deno task build`。規則的 `evaluate`
回傳 `allow()` 或 `ask(reason)`；對會讀檔的參數呼叫 `ctx.resolvePath(arg)`
做範圍檢查。
