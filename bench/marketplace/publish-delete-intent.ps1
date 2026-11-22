param([Parameter(Mandatory = $true)][string] $Directory)

$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class DeleteIntent {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool GetVolumePathNameW(string path, StringBuilder root, uint capacity);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool GetVolumeInformationW(string root, IntPtr name, uint nameCapacity,
        IntPtr serial, IntPtr maxComponent, IntPtr flags, StringBuilder format, uint formatCapacity);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] record, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle file);

    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInfo {
        public uint ReplaceIfExists;
        public IntPtr RootDirectory;
        public uint FileNameLength;
        public ushort FileName;
    }

    public static void Publish(string directory) {
        string target = Path.Combine(directory, "state.json");
        var root = new StringBuilder(32768);
        var format = new StringBuilder(32);
        if (!GetVolumePathNameW(directory, root, (uint)root.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not identify the intent volume");
        if (GetDriveTypeW(root.ToString()) != 3 /* DRIVE_FIXED */ ||
            !GetVolumeInformationW(root.ToString(), IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, format, (uint)format.Capacity) ||
            format.ToString() != "NTFS")
            throw new IOException("Deletion intent requires a local fixed NTFS volume on Windows");

        // FILE_RENAME_INFO contains a variable-length UTF-16 name. Use the platform's
        // offsets (including pointer alignment); the zeroed root handle means an absolute path.
        byte[] name = Encoding.Unicode.GetBytes(target);
        int offset = Marshal.OffsetOf(typeof(RenameInfo), "FileName").ToInt32();
        byte[] record = new byte[Math.Max(Marshal.SizeOf(typeof(RenameInfo)), offset + name.Length + 2)];
        record[0] = 1; // ReplaceIfExists
        BitConverter.GetBytes(name.Length).CopyTo(record, Marshal.OffsetOf(typeof(RenameInfo), "FileNameLength").ToInt32());
        name.CopyTo(record, offset);

        // GENERIC_WRITE | DELETE, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH. NTFS flushes rename metadata
        // for this handle. No copy fallback, no volume/admin access, and no delete-then-rename.
        using (SafeFileHandle file = CreateFileW(target + ".delete-intent.tmp", 0x40010000, 0, IntPtr.Zero, 3, 0x80000000, IntPtr.Zero)) {
            if (file.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the staged intent for write-through rename");
            if (!SetFileInformationByHandle(file, 3 /* FileRenameInfo */, record, (uint)record.Length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "NTFS write-through intent rename failed");
            if (!FlushFileBuffers(file))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "NTFS intent flush after rename failed");
        }
    }
}
'@
    [DeleteIntent]::Publish($Directory)
    [Console]::Out.WriteLine('intent committed')
} catch {
    $reason = $_.Exception.GetBaseException()
    $detail = if ($reason -is [System.ComponentModel.Win32Exception]) { " (Windows error $($reason.NativeErrorCode))" } else { '' }
    [Console]::Error.WriteLine($reason.Message + $detail)
    exit 1
}
