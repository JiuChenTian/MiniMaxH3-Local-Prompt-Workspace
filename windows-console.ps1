param([switch]$NoBrowser, [switch]$NoHold, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Set-Location -LiteralPath $PSScriptRoot
# A kernel Job Object owns this console worker and every process it starts.
# Windows closes its handle even on forced console termination, releasing GPU
# memory by killing the model/server descendants. No external process is added.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class H3ConsoleJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long UserTime, JobTime; public uint Flags;
        public UIntPtr Min, Max; public uint Active;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic Limits; public Io Counters;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    public static IntPtr Handle;
    public static void Attach() {
        Handle=CreateJobObject(IntPtr.Zero,null);
        if(Handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var value=new Extended(); value.Limits.Flags=0x2000;
        int size=Marshal.SizeOf(value); var ptr=Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(value,ptr,false);
            if(!SetInformationJobObject(Handle,9,ptr,(uint)size)) throw new System.ComponentModel.Win32Exception();
            if(!AssignProcessToJobObject(Handle,GetCurrentProcess())) throw new System.ComponentModel.Win32Exception();
        } finally {Marshal.FreeHGlobal(ptr);}
    }
}
'@
try {
    if (-not $NoBrowser -and -not $CheckOnly) {
        $browserPort = if ($env:PORT) { $env:PORT } else { '3210' }
        $openerArgs = @(('"' + (Join-Path $PSScriptRoot 'open-workbench.mjs') + '"'), $browserPort, [string]$PID)
        Start-Process -FilePath (Get-Command node).Source -ArgumentList $openerArgs -WindowStyle Hidden
    }
    [H3ConsoleJob]::Attach()
    $launchArgs = @((Join-Path $PSScriptRoot 'launch.mjs'), '--no-browser')
    if ($CheckOnly) { $launchArgs += '--check-only' }
    & node @launchArgs
} catch { Write-Host $_.Exception.Message -ForegroundColor Red }
if (-not $NoHold) {
    Write-Host 'Workbench stopped. This console stays open. Close it when finished.'
    while ($true) { [void](Read-Host 'Press Enter to keep this console open') }
}
