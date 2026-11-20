$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> 检查环境..." -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "未找到 Node.js，请先安装 Node.js >= 18。"
}
$codex = Get-AppxPackage OpenAI.Codex | Select-Object -First 1
if (-not $codex) {
    Write-Warning "未检测到微软商店版 OpenAI.Codex，使用前请先安装 OpenAI Codex 桌面端。"
} else {
    Write-Host "    Node.js : $($node.Source)"
    Write-Host "    Codex   : $($codex.InstallLocation)"
}

Write-Host "==> 注册全局命令 codex-cua-mcp (npm link)..." -ForegroundColor Cyan
Push-Location $dir
try {
    npm link | Out-Null
} finally {
    Pop-Location
}

$cmd = Get-Command codex-cua-mcp -ErrorAction SilentlyContinue
if ($cmd) {
    Write-Host "==> 安装完成！已注册全局命令: $($cmd.Source)" -ForegroundColor Green
    Write-Host ""
    Write-Host "任意支持 MCP 的客户端（Antigravity / Cursor / Claude Desktop / Windsurf / CC Switch）直接填：" -ForegroundColor Yellow
    Write-Host @'
{
  "mcpServers": {
    "codex-cua": {
      "command": "codex-cua-mcp"
    }
  }
}
'@
    Write-Host "Claude Code CLI 一行命令：" -ForegroundColor Yellow
    Write-Host "  claude mcp add codex-cua -- codex-cua-mcp"
} else {
    Write-Warning "npm link 已执行，但未在 PATH 中找到 codex-cua-mcp；请检查 npm 全局 bin 目录是否在 PATH 中，或直接使用 node `"$dir\server.mjs`"。"
}
