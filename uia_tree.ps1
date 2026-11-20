param(
    [long]$Hwnd = 0,
    [int]$MaxElements = 80,
    [string]$Filter = "",
    [switch]$Daemon
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Fg {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@
[void][Win32Fg]::SetProcessDPIAware()

$AE = [System.Windows.Automation.AutomationElement]
$InteractiveTypes = @(
    "Button", "Edit", "ComboBox", "MenuItem", "TabItem", "ListItem", "TreeItem",
    "CheckBox", "RadioButton", "Hyperlink", "Slider", "SplitButton", "DataItem"
)

function Get-RootElement([long]$TargetHwnd) {
    $h = if ($TargetHwnd -ne 0) { [IntPtr]$TargetHwnd } else { [Win32Fg]::GetForegroundWindow() }
    if ($h -eq [IntPtr]::Zero) { return $null }
    try { return $AE::FromHandle($h) } catch { return $null }
}

# Fetch all visible descendants in ONE cross-process call with cached properties (much faster than TreeWalker).
function Get-VisibleNodes($Root) {
    $cr = New-Object System.Windows.Automation.CacheRequest
    [void]$cr.Add($AE::NameProperty)
    [void]$cr.Add($AE::ControlTypeProperty)
    [void]$cr.Add($AE::AutomationIdProperty)
    [void]$cr.Add($AE::BoundingRectangleProperty)
    [void]$cr.Add($AE::IsEnabledProperty)
    $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
    $cond = New-Object System.Windows.Automation.AndCondition(
        [System.Windows.Automation.Automation]::ControlViewCondition,
        (New-Object System.Windows.Automation.PropertyCondition($AE::IsOffscreenProperty, $false))
    )
    $null = $cr.Push()
    try {
        $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    } finally {
        $cr.Pop()
    }

    $nodes = New-Object System.Collections.Generic.List[object]
    foreach ($el in $all) {
        try {
            $c = $el.Cached
            $rect = $c.BoundingRectangle
            if ([double]::IsInfinity($rect.Width) -or $rect.Width -le 2 -or $rect.Height -le 2) { continue }
            $name = if ($c.Name) { $c.Name.Trim() } else { "" }
            $ctype = if ($c.ControlType) { $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' } else { "" }
            $aid = if ($c.AutomationId) { $c.AutomationId.Trim() } else { "" }
            $nodes.Add([pscustomobject]@{
                el = $el; name = $name; ctype = $ctype; aid = $aid; enabled = [bool]$c.IsEnabled
                x = [int][Math]::Round($rect.X); y = [int][Math]::Round($rect.Y)
                w = [int][Math]::Round($rect.Width); h = [int][Math]::Round($rect.Height)
            })
        } catch { }
    }
    return $nodes
}

function ConvertTo-Item($n, [int]$idx) {
    return [pscustomobject]@{
        index = $idx
        name = $n.name
        control_type = $n.ctype
        automation_id = $n.aid
        enabled = $n.enabled
        bounds = [pscustomobject]@{ x = $n.x; y = $n.y; width = $n.w; height = $n.h }
        center = [pscustomobject]@{ x = [int]($n.x + $n.w / 2); y = [int]($n.y + $n.h / 2) }
    }
}

function Get-Tree($req) {
    $root = Get-RootElement ([long]$req.hwnd)
    if ($null -eq $root) { return @() }
    $limit = if ($req.max_elements) { [int]$req.max_elements } else { 80 }
    $f = if ($req.filter) { ([string]$req.filter).ToLowerInvariant() } else { "" }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($n in (Get-VisibleNodes $root)) {
        if ($out.Count -ge $limit) { break }
        $isInteractive = $InteractiveTypes -contains $n.ctype
        if (-not ($n.name -ne "" -or $isInteractive)) { continue }
        if ($f -ne "" -and -not ($n.name.ToLowerInvariant().Contains($f) -or $n.ctype.ToLowerInvariant().Contains($f) -or $n.aid.ToLowerInvariant().Contains($f))) { continue }
        $out.Add((ConvertTo-Item $n $out.Count))
    }
    return $out.ToArray()
}

function Find-Matches($req) {
    $root = Get-RootElement ([long]$req.hwnd)
    if ($null -eq $root) { throw "Target window not found" }
    $nameQ = if ($req.name) { ([string]$req.name).Trim().ToLowerInvariant() } else { "" }
    $aidQ = if ($req.automation_id) { ([string]$req.automation_id).Trim().ToLowerInvariant() } else { "" }
    $typeQ = if ($req.control_type) { ([string]$req.control_type).Trim().ToLowerInvariant() } else { "" }
    if ($nameQ -eq "" -and $aidQ -eq "") { throw "Provide name or automation_id" }

    $exact = New-Object System.Collections.Generic.List[object]
    $partial = New-Object System.Collections.Generic.List[object]
    foreach ($n in (Get-VisibleNodes $root)) {
        if ($typeQ -ne "" -and $n.ctype.ToLowerInvariant() -ne $typeQ) { continue }
        $nl = $n.name.ToLowerInvariant()
        $al = $n.aid.ToLowerInvariant()
        if ($aidQ -ne "") {
            if ($al -eq $aidQ) { $exact.Add($n) } elseif ($al.Contains($aidQ)) { $partial.Add($n) }
            continue
        }
        if ($nl -eq $nameQ) { $exact.Add($n) } elseif ($nl.Contains($nameQ)) { $partial.Add($n) }
    }
    $all = New-Object System.Collections.Generic.List[object]
    $all.AddRange($exact); $all.AddRange($partial)
    return $all
}

function Select-Match($req) {
    $all = Find-Matches $req
    $i = if ($null -ne $req.index) { [int]$req.index } else { 0 }
    if ($all.Count -le $i) {
        throw "Element not found (name='$($req.name)', automation_id='$($req.automation_id)', control_type='$($req.control_type)', matches=$($all.Count))"
    }
    return @{ node = $all[$i]; count = $all.Count }
}

function Try-Pattern($el, $patternId) {
    try { return $el.GetCurrentPattern($patternId) } catch { return $null }
}

function Invoke-Element($req) {
    $sel = Select-Match $req
    $n = $sel.node
    $method = if ($req.method) { [string]$req.method } else { "auto" }
    $done = $null
    if ($method -ne "mouse") {
        $p = Try-Pattern $n.el ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($p) { $p.Invoke(); $done = "invoke" }
        if (-not $done) {
            $p = Try-Pattern $n.el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($p) { $p.Select(); $done = "select" }
        }
        if (-not $done) {
            $p = Try-Pattern $n.el ([System.Windows.Automation.TogglePattern]::Pattern)
            if ($p) { $p.Toggle(); $done = "toggle" }
        }
        if (-not $done) {
            $p = Try-Pattern $n.el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($p) { $p.Expand(); $done = "expand" }
        }
    }
    $item = ConvertTo-Item $n 0
    return [pscustomobject]@{
        invoked = [bool]$done; method = $done; match_count = $sel.count
        name = $item.name; control_type = $item.control_type; center = $item.center; bounds = $item.bounds
    }
}

function Set-ElementValue($req) {
    $sel = Select-Match $req
    $n = $sel.node
    $done = $false
    $p = Try-Pattern $n.el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($p -and -not $p.Current.IsReadOnly) {
        try { $n.el.SetFocus() } catch { }
        $p.SetValue([string]$req.value)
        $done = $true
    }
    $item = ConvertTo-Item $n 0
    return [pscustomobject]@{
        set = $done; match_count = $sel.count
        name = $item.name; control_type = $item.control_type; center = $item.center; bounds = $item.bounds
    }
}

function Invoke-Request($req) {
    $op = if ($req.op) { [string]$req.op } else { "tree" }
    switch ($op) {
        "tree" { return Get-Tree $req }
        "find" {
            $all = Find-Matches $req
            $out = New-Object System.Collections.Generic.List[object]
            $limit = if ($req.max_elements) { [int]$req.max_elements } else { 20 }
            foreach ($n in $all) { if ($out.Count -ge $limit) { break }; $out.Add((ConvertTo-Item $n $out.Count)) }
            return $out.ToArray()
        }
        "invoke" { return Invoke-Element $req }
        "set_value" { return Set-ElementValue $req }
        default { throw "Unknown op: $op" }
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
            $res = Invoke-Request $req
            $resp = [pscustomobject]@{ id = $reqId; ok = $true; result = $res }
        } catch {
            $resp = [pscustomobject]@{ id = $reqId; ok = $false; error = $_.Exception.Message }
        }
        $json = ConvertTo-Json -InputObject $resp -Depth 6 -Compress
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    }
    exit 0
}

$items = Get-Tree ([pscustomobject]@{ hwnd = $Hwnd; max_elements = $MaxElements; filter = $Filter })
if ($items.Count -eq 0) { Write-Output "[]" } else { ConvertTo-Json -InputObject @($items) -Depth 5 -Compress }
