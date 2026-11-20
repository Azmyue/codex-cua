param(
    [switch]$Daemon
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinToolsNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public sealed class WinInfo {
        public long hwnd;
        public uint pid;
        public string title;
        public int x, y, width, height;
        public bool minimized;
        public bool foreground;
    }

    public static List<WinInfo> ListWindows() {
        var list = new List<WinInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLengthW(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            string title = sb.ToString().Trim();
            if (title.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT r;
            GetWindowRect(hWnd, out r);
            list.Add(new WinInfo {
                hwnd = hWnd.ToInt64(),
                pid = pid,
                title = title,
                x = r.Left,
                y = r.Top,
                width = r.Right - r.Left,
                height = r.Bottom - r.Top,
                minimized = IsIconic(hWnd),
                foreground = (hWnd == fg)
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string ActivateWindow(long hwndVal) {
        IntPtr target = new IntPtr(hwndVal);
        if (target == IntPtr.Zero || !IsWindow(target)) {
            throw new Exception("Window not found: " + hwndVal);
        }
        if (IsIconic(target)) {
            ShowWindow(target, 9); // SW_RESTORE
        }
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
        uint curTid = GetCurrentThreadId();
        bool attached = false;
        if (fgTid != 0 && fgTid != curTid) {
            attached = AttachThreadInput(curTid, fgTid, true);
        }
        try {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        } finally {
            if (attached) AttachThreadInput(curTid, fgTid, false);
        }
        int len = GetWindowTextLengthW(target);
        var sb = new StringBuilder(len + 1);
        GetWindowTextW(target, sb, sb.Capacity);
        return sb.ToString();
    }
}
"@
[void][WinToolsNative]::SetProcessDPIAware()

$script:AppsCache = $null
$script:AppsCacheAt = [DateTime]::MinValue

function Get-WindowList {
    $raw = [WinToolsNative]::ListWindows()
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($w in $raw) {
        $out.Add([pscustomobject]@{
            hwnd = $w.hwnd
            pid = $w.pid
            title = $w.title
            bounds = [pscustomobject]@{ x = $w.x; y = $w.y; width = $w.width; height = $w.height }
            minimized = $w.minimized
            foreground = $w.foreground
        })
    }
    return $out.ToArray()
}

function Invoke-ActivateWindow($payload) {
    $targetHwnd = 0L
    if ($null -ne $payload.hwnd -and [long]$payload.hwnd -ne 0) {
        $targetHwnd = [long]$payload.hwnd
    } elseif ($payload.title_contains) {
        $needle = ([string]$payload.title_contains).ToLowerInvariant()
        foreach ($w in [WinToolsNative]::ListWindows()) {
            if ($w.title.ToLowerInvariant().Contains($needle)) {
                $targetHwnd = $w.hwnd
                break
            }
        }
    }
    if ($targetHwnd -eq 0) {
        throw "Window not found (hwnd=$($payload.hwnd), title_contains='$($payload.title_contains)')"
    }
    $title = [WinToolsNative]::ActivateWindow($targetHwnd)
    return [pscustomobject]@{ hwnd = $targetHwnd; title = $title }
}

function Get-AppList($payload) {
    $force = [bool]($payload -and $payload.force_refresh)
    if (-not $force -and $null -ne $script:AppsCache -and ((Get-Date) - $script:AppsCacheAt).TotalSeconds -lt 300) {
        return $script:AppsCache
    }
    $apps = @(Get-StartApps | ForEach-Object {
        [pscustomobject]@{ name = [string]$_.Name; app_id = [string]$_.AppID }
    })
    $script:AppsCache = $apps
    $script:AppsCacheAt = Get-Date
    return $apps
}

function Invoke-LaunchApp($payload) {
    $target = [string]$payload.target
    if (-not $target) { throw "Missing target" }
    $argList = @()
    if ($payload.args) { $argList = @($payload.args | ForEach-Object { [string]$_ }) }

    if ($target.Contains("!") -and -not $target.Contains("\") -and -not $target.Contains("/")) {
        Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\$target"
        return [pscustomobject]@{ launched = $target; mode = "uwp_app_id" }
    }
    if ($argList.Count -gt 0) {
        Start-Process -FilePath $target -ArgumentList $argList
    } else {
        Start-Process -FilePath $target
    }
    return [pscustomobject]@{ launched = $target; args = $argList; mode = "process" }
}

function Dispatch-Action($action, $payload) {
    switch ($action) {
        "list_windows" { return ,(Get-WindowList) }
        "activate_window" { return Invoke-ActivateWindow $payload }
        "list_apps" { return ,(Get-AppList $payload) }
        "launch_app" { return Invoke-LaunchApp $payload }
        default { throw "Unknown action: $action" }
    }
}

if ($Daemon) {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "") { continue }
        $reqId = $null
        try {
            $req = $trimmed | ConvertFrom-Json
            $reqId = $req.id
            $res = Dispatch-Action $req.action $req.payload
            $resp = [pscustomobject]@{ id = $reqId; ok = $true; result = $res }
        } catch {
            $resp = [pscustomobject]@{ id = $reqId; ok = $false; error = $_.Exception.Message }
        }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $resp -Depth 6 -Compress))
        [Console]::Out.Flush()
    }
    exit 0
}
