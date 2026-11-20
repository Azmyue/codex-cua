param(
    [string]$Text = "AI 正在操作电脑",
    [switch]$Hidden
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class OverlayNative {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_LAYERED = 0x00080000;

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int VK_ESCAPE = 0x1B;
    public const uint LLKHF_INJECTED = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);

    public static void MakeClickThrough(IntPtr hwnd) {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED);
    }

    private static IntPtr _hookId = IntPtr.Zero;
    private static LowLevelKeyboardProc _proc;
    public static volatile bool Active = false;
    public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && Active) {
            int msg = wParam.ToInt32();
            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (kb.vkCode == VK_ESCAPE && (kb.flags & LLKHF_INJECTED) == 0) {
                    Active = false;
                    try {
                        Console.Out.WriteLine("ESC_ABORT");
                        Console.Out.Flush();
                    } catch { }
                    Events.Enqueue("HIDE");
                }
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    public static void InstallHook() {
        if (_hookId != IntPtr.Zero) return;
        _proc = HookCallback;
        _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
    }

    public static void UninstallHook() {
        if (_hookId != IntPtr.Zero) {
            UnhookWindowsHookEx(_hookId);
            _hookId = IntPtr.Zero;
        }
    }

    public static void StartStdinReader() {
        Thread t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string trimmed = line.Trim();
                    if (trimmed.Length > 0) {
                        Events.Enqueue(trimmed);
                    }
                }
            } catch { }
            Events.Enqueue("QUIT");
        });
        t.IsBackground = true;
        t.Start();
    }
}
"@

$w = [System.Windows.SystemParameters]::PrimaryScreenWidth
$h = [System.Windows.SystemParameters]::PrimaryScreenHeight
$safeText = [System.Security.SecurityElement]::Escape($Text)

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ShowActivated="False"
        ResizeMode="NoResize"
        Left="0" Top="0" Width="$w" Height="$h">
  <Grid IsHitTestVisible="False">
    <Rectangle VerticalAlignment="Top" Height="16">
      <Rectangle.Fill>
        <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
          <GradientStop Color="#8860A5FA" Offset="0.0"/>
          <GradientStop Color="#30818CF8" Offset="0.38"/>
          <GradientStop Color="#0060A5FA" Offset="1.0"/>
        </LinearGradientBrush>
      </Rectangle.Fill>
    </Rectangle>
    <Rectangle VerticalAlignment="Bottom" Height="16">
      <Rectangle.Fill>
        <LinearGradientBrush StartPoint="0,1" EndPoint="0,0">
          <GradientStop Color="#8860A5FA" Offset="0.0"/>
          <GradientStop Color="#30818CF8" Offset="0.38"/>
          <GradientStop Color="#0060A5FA" Offset="1.0"/>
        </LinearGradientBrush>
      </Rectangle.Fill>
    </Rectangle>
    <Rectangle HorizontalAlignment="Left" Width="16">
      <Rectangle.Fill>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
          <GradientStop Color="#8860A5FA" Offset="0.0"/>
          <GradientStop Color="#30818CF8" Offset="0.38"/>
          <GradientStop Color="#0060A5FA" Offset="1.0"/>
        </LinearGradientBrush>
      </Rectangle.Fill>
    </Rectangle>
    <Rectangle HorizontalAlignment="Right" Width="16">
      <Rectangle.Fill>
        <LinearGradientBrush StartPoint="1,0" EndPoint="0,0">
          <GradientStop Color="#8860A5FA" Offset="0.0"/>
          <GradientStop Color="#30818CF8" Offset="0.38"/>
          <GradientStop Color="#0060A5FA" Offset="1.0"/>
        </LinearGradientBrush>
      </Rectangle.Fill>
    </Rectangle>

    <Border BorderThickness="1.5" CornerRadius="0">
      <Border.BorderBrush>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
          <GradientStop Color="#CC60A5FA" Offset="0.0"/>
          <GradientStop Color="#CC818CF8" Offset="0.5"/>
          <GradientStop Color="#CC38BDF8" Offset="1.0"/>
        </LinearGradientBrush>
      </Border.BorderBrush>
    </Border>

    <Canvas x:Name="EffectCanvas" IsHitTestVisible="False">
      <!-- Smooth gliding virtual AI cursor -->
      <Canvas x:Name="VirtualCursor" Visibility="Collapsed" IsHitTestVisible="False">
        <Path Data="M 0,0 L 0,19 L 4.5,14.8 L 8.2,22 L 10.8,20.7 L 7.2,13.6 L 13.5,13.6 Z"
              Fill="#FF2563EB" Stroke="#FFFFFFFF" StrokeThickness="1.6" StrokeLineJoin="Round">
          <Path.Effect>
            <DropShadowEffect Color="#38BDF8" BlurRadius="10" ShadowDepth="0" Opacity="0.85"/>
          </Path.Effect>
        </Path>
      </Canvas>
    </Canvas>

    <Border HorizontalAlignment="Center" VerticalAlignment="Top" Margin="0,10,0,0"
            CornerRadius="18" Background="#EB14171F" BorderBrush="#38FFFFFF" BorderThickness="1"
            Padding="14,7,12,7">
      <Border.Effect>
        <DropShadowEffect Color="#000000" BlurRadius="22" ShadowDepth="4" Opacity="0.45" Direction="270"/>
      </Border.Effect>
      <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
        <Grid Width="10" Height="10" Margin="0,0,9,0" VerticalAlignment="Center">
          <Ellipse x:Name="PulseRing" Width="10" Height="10" Fill="#5534D399"/>
          <Ellipse Width="6" Height="6" Fill="#34D399"/>
        </Grid>
        <TextBlock x:Name="BannerLabel" Text="$safeText"
                   Foreground="#F3F4F6" FontFamily="Microsoft YaHei UI" FontSize="12.5" FontWeight="SemiBold"
                   VerticalAlignment="Center"/>
        <Border Width="1" Height="13" Background="#28FFFFFF" Margin="11,0,10,0" VerticalAlignment="Center"/>
        <Border Background="#1FFFFFFF" BorderBrush="#33FFFFFF" BorderThickness="1" CornerRadius="5"
                Padding="6,1.5,6,1.5" Margin="0,0,5,0" VerticalAlignment="Center">
          <TextBlock Text="Esc" Foreground="#E5E7EB" FontFamily="Segoe UI" FontSize="11" FontWeight="SemiBold"/>
        </Border>
        <TextBlock Text="停止" Foreground="#9CA3AF" FontFamily="Microsoft YaHei UI" FontSize="11.5"
                   VerticalAlignment="Center"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$app = [System.Windows.Application]::Current
if ($null -eq $app) {
    $app = New-Object System.Windows.Application
}
$app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

$pulseRing = $window.FindName("PulseRing")
$bannerLabel = $window.FindName("BannerLabel")
$effectCanvas = $window.FindName("EffectCanvas")
$virtualCursor = $window.FindName("VirtualCursor")
$script:cursorX = $w / 2.0
$script:cursorY = $h / 2.0

function Move-VirtualCursor([double]$px, [double]$py) {
    try {
        $src = [System.Windows.PresentationSource]::FromVisual($window)
        $scaleX = if ($src -and $src.CompositionTarget) { $src.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
        $scaleY = if ($src -and $src.CompositionTarget) { $src.CompositionTarget.TransformToDevice.M22 } else { 1.0 }
        $tx = $px / $scaleX
        $ty = $py / $scaleY

        if ($virtualCursor.Visibility -ne [System.Windows.Visibility]::Visible) {
            [System.Windows.Controls.Canvas]::SetLeft($virtualCursor, $tx)
            [System.Windows.Controls.Canvas]::SetTop($virtualCursor, $ty)
            $virtualCursor.Visibility = [System.Windows.Visibility]::Visible
        } else {
            $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(160))
            $ease = New-Object System.Windows.Media.CubicEase
            $ease.EasingMode = [System.Windows.Media.EasingMode]::EaseOut
            $ax = New-Object System.Windows.Media.Animation.DoubleAnimation($script:cursorX, $tx, $dur)
            $ay = New-Object System.Windows.Media.Animation.DoubleAnimation($script:cursorY, $ty, $dur)
            $ax.EasingFunction = $ease
            $ay.EasingFunction = $ease
            $virtualCursor.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, $ax)
            $virtualCursor.BeginAnimation([System.Windows.Controls.Canvas]::TopProperty, $ay)
        }
        $script:cursorX = $tx
        $script:cursorY = $ty
    } catch { }
}

function Show-ClickRipple([double]$px, [double]$py) {
    try {
        $src = [System.Windows.PresentationSource]::FromVisual($window)
        $scaleX = if ($src -and $src.CompositionTarget) { $src.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
        $scaleY = if ($src -and $src.CompositionTarget) { $src.CompositionTarget.TransformToDevice.M22 } else { 1.0 }
        $dx = $px / $scaleX
        $dy = $py / $scaleY

        $size = 44.0
        $ring = New-Object System.Windows.Shapes.Ellipse
        $ring.Width = $size
        $ring.Height = $size
        $ring.Stroke = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF38BDF8")
        $ring.StrokeThickness = 2.5
        $ring.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#3338BDF8")
        $ring.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
        $scaleT = New-Object System.Windows.Media.ScaleTransform(0.25, 0.25)
        $ring.RenderTransform = $scaleT

        [System.Windows.Controls.Canvas]::SetLeft($ring, $dx - $size / 2)
        [System.Windows.Controls.Canvas]::SetTop($ring, $dy - $size / 2)
        [void]$effectCanvas.Children.Add($ring)

        $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(420))
        $ease = New-Object System.Windows.Media.CubicEase
        $ease.EasingMode = [System.Windows.Media.EasingMode]::EaseOut

        $animScale = New-Object System.Windows.Media.Animation.DoubleAnimation(0.25, 1.35, $dur)
        $animScale.EasingFunction = $ease
        $animOp = New-Object System.Windows.Media.Animation.DoubleAnimation(0.95, 0.0, $dur)
        $animOp.EasingFunction = $ease
        $animOp.Add_Completed({
            try { [void]$effectCanvas.Children.Remove($ring) } catch { }
        }.GetNewClosure())

        $scaleT.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $animScale)
        $scaleT.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $animScale)
        $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $animOp)
    } catch { }
}

$anim = New-Object System.Windows.Media.Animation.DoubleAnimation
$anim.From = 0.25
$anim.To = 0.95
$anim.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(950))
$anim.AutoReverse = $true
$anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$pulseRing.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $anim)

$window.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    [OverlayNative]::MakeClickThrough($helper.Handle)
    [OverlayNative]::InstallHook()
})

$window.Add_Closed({
    [OverlayNative]::UninstallHook()
})

if (-not $Hidden) {
    [OverlayNative]::Active = $true
    $window.Show()
} else {
    [OverlayNative]::Active = $false
}

[OverlayNative]::StartStdinReader()

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(30)
$timer.Add_Tick({
    $cmd = ""
    while ([OverlayNative]::Events.TryDequeue([ref]$cmd)) {
        if ($cmd -eq "SHOW") {
            [OverlayNative]::Active = $true
            $window.Show()
            $window.Topmost = $true
            $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
            if ($helper.Handle -ne [IntPtr]::Zero) {
                [OverlayNative]::MakeClickThrough($helper.Handle)
            }
        } elseif ($cmd -eq "HIDE") {
            [OverlayNative]::Active = $false
            $virtualCursor.Visibility = [System.Windows.Visibility]::Collapsed
            $window.Hide()
        } elseif ($cmd.StartsWith("MOVE:")) {
            $parts = $cmd.Substring(5).Split(",")
            if ($parts.Length -ge 2) {
                $mx = 0.0; $my = 0.0
                if ([double]::TryParse($parts[0], [ref]$mx) -and [double]::TryParse($parts[1], [ref]$my)) {
                    Move-VirtualCursor $mx $my
                }
            }
        } elseif ($cmd.StartsWith("CLICK:")) {
            $parts = $cmd.Substring(6).Split(",")
            if ($parts.Length -ge 2) {
                $cx = 0.0; $cy = 0.0
                if ([double]::TryParse($parts[0], [ref]$cx) -and [double]::TryParse($parts[1], [ref]$cy)) {
                    Move-VirtualCursor $cx $cy
                    Show-ClickRipple $cx $cy
                }
            }
        } elseif ($cmd.StartsWith("TEXT:")) {
            $newText = $cmd.Substring(5).Trim()
            if ($newText) {
                $bannerLabel.Text = $newText
            }
        } elseif ($cmd -eq "QUIT") {
            [OverlayNative]::Active = $false
            [OverlayNative]::UninstallHook()
            $timer.Stop()
            $window.Close()
            $app.Shutdown()
            return
        }
    }
})
$timer.Start()

$null = $app.Run()
