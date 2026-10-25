Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D2 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][D2]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("virtual {0},{1} {2}x{3}" -f $b.X, $b.Y, $b.Width, $b.Height)
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) { Write-Output ("screen {0} bounds {1} primary={2}" -f $s.DeviceName, $s.Bounds, $s.Primary) }
