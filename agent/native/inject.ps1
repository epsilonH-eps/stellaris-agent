#requires -Version 5.1
<#
.SYNOPSIS
  把 stellaris_bridge.dll 注入正在运行的群星进程（LoadLibraryW 远程线程）。
.DESCRIPTION
  只做一次 LoadLibraryW；游戏逻辑全部交给 DLL 自己的游戏线程队列。
  不写游戏可执行文件、不改存档。
#>
param(
  [Parameter(Mandatory = $true)][int]$GamePid,
  [Parameter(Mandatory = $true)][string]$DllPath
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $DllPath)) { '{"ok":false,"error":"dll_not_found"}' ; exit 1 }
$dllFull = (Resolve-Path $DllPath).Path

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeInject {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MODULEENTRY32 {
    public uint dwSize; public uint th32ModuleID; public uint th32ProcessID;
    public uint GlblcntUsage; public uint ProccntUsage; public IntPtr modBaseAddr;
    public uint modBaseSize; public IntPtr hModule;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath;
  }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Module32FirstW(IntPtr snap, ref MODULEENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Module32NextW(IntPtr snap, ref MODULEENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, UIntPtr size, uint type, uint protect);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, UIntPtr size, uint type);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteProcessMemory(IntPtr proc, IntPtr addr, byte[] buffer, UIntPtr size, out UIntPtr written);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateRemoteThread(IntPtr proc, IntPtr attr, UIntPtr stack, IntPtr start, IntPtr param, uint flags, IntPtr threadId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr proc, uint flags, StringBuilder name, ref uint size);

  public static IntPtr FindModule(uint pid, string name) {
    IntPtr snap = CreateToolhelp32Snapshot(0x18, pid);
    if (snap == new IntPtr(-1)) return IntPtr.Zero;
    try {
      var entry = new MODULEENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(MODULEENTRY32));
      if (Module32FirstW(snap, ref entry)) {
        do {
          if (string.Equals(entry.szModule, name, StringComparison.OrdinalIgnoreCase)) return entry.modBaseAddr;
        } while (Module32NextW(snap, ref entry));
      }
      return IntPtr.Zero;
    } finally { CloseHandle(snap); }
  }

  public static string Inject(int pid, string dllPath, out string status) {
    status = "error";
    if (FindModule((uint)pid, "stellaris_bridge.dll") != IntPtr.Zero) { status = "already_loaded"; return null; }
    IntPtr proc = OpenProcess(0x43A, false, pid);
    if (proc == IntPtr.Zero) { status = "openprocess_failed:" + Marshal.GetLastWin32Error(); return null; }
    IntPtr remote = IntPtr.Zero, thread = IntPtr.Zero;
    try {
      var name = new StringBuilder(32768); uint size = 32768;
      if (!QueryFullProcessImageNameW(proc, 0, name, ref size)) { status = "query_path_failed"; return null; }
      byte[] bytes = Encoding.Unicode.GetBytes(dllPath + "\0");
      remote = VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)bytes.Length, 0x3000, 4);
      if (remote == IntPtr.Zero) { status = "alloc_failed:" + Marshal.GetLastWin32Error(); return null; }
      UIntPtr written;
      if (!WriteProcessMemory(proc, remote, bytes, (UIntPtr)bytes.Length, out written)) { status = "write_failed:" + Marshal.GetLastWin32Error(); return null; }
      IntPtr localKernel = GetModuleHandleW("kernel32.dll");
      IntPtr localFn = GetProcAddress(localKernel, "LoadLibraryW");
      IntPtr remoteKernel = FindModule((uint)pid, "kernel32.dll");
      if (localFn == IntPtr.Zero || remoteKernel == IntPtr.Zero) { status = "loadlibrary_unavailable"; return null; }
      IntPtr remoteFn = new IntPtr(remoteKernel.ToInt64() + (localFn.ToInt64() - localKernel.ToInt64()));
      thread = CreateRemoteThread(proc, IntPtr.Zero, UIntPtr.Zero, remoteFn, remote, 0, IntPtr.Zero);
      if (thread == IntPtr.Zero) { status = "thread_failed:" + Marshal.GetLastWin32Error(); return null; }
      uint waited = WaitForSingleObject(thread, 5000);
      if (waited != 0) { status = "load_pending"; return null; }
      if (FindModule((uint)pid, "stellaris_bridge.dll") != IntPtr.Zero) { status = "loaded"; return name.ToString(); }
      status = "not_loaded_after_thread";
      return null;
    } finally {
      if (remote != IntPtr.Zero) VirtualFreeEx(proc, remote, UIntPtr.Zero, 0x8000);
      if (thread != IntPtr.Zero) CloseHandle(thread);
      CloseHandle(proc);
    }
  }
}
'@

$status = ''
$image = [NativeInject]::Inject($GamePid, $dllFull, [ref]$status)
Write-Output (@{ ok = ($status -in @('loaded', 'already_loaded')); status = $status; pid = $GamePid; dll = $dllFull; image = $image } | ConvertTo-Json -Compress)
