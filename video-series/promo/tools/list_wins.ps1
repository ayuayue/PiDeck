param([string]$ProcName = "PiDeck", [int]$MinW = 400)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class EW {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> Pids = new List<string>();
  public static List<string> Out = new List<string>();
  public static void Run(List<string> pids, int minW) {
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid.ToString())) return true;
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w < minW) return true;
      Out.Add(string.Format("{0} pid={1} {2},{3} {4}x{5} '{6}'", h.ToInt64(), pid, r.Left, r.Top, w, ht, sb.ToString()));
      return true;
    }, IntPtr.Zero);
  }
}
"@
$pids = (Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | ForEach-Object { $_.ToString() })
if ($pids.Count -eq 0) { Write-Output "NO PROC $ProcName"; exit 1 }
[EW]::Pids = [System.Collections.Generic.List[string]]@($pids)
[EW]::Run([EW]::Pids, $MinW)
[EW]::Out | ForEach-Object { Write-Output $_ }
