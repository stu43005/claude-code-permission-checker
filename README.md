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
          { "type": "command", "command": "D:\\path\\to\\dist\\permission-checker.exe" }
        ]
      }
    ]
  }
}
```

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
