# Local-only saved-file integrity verification for the LAN Room MULTI-03 test kit.
# Supply explicit saved-file paths: browser download suffixes such as "(1)" are
# allowed, and the script never selects a file by name or uploads its contents.
[CmdletBinding()]
param(
    [string]$AFromB,
    [string]$BFromA,
    [string]$C5MiB,
    [string]$C64KiB,
    [string]$C0B,
    [string]$RunLabel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$checks = @(
    [pscustomobject]@{ Slot = 'A-from-B';  Path = $AFromB; Fixture = 'B_reply_1MiB.bin'; Bytes = 1048576L; Sha = '63a651a42cb119a1feda62ed2e3e2f49b1f8fb6f2649c7bce86ff0f76d7e496c' }
    [pscustomobject]@{ Slot = 'B-from-A';  Path = $BFromA; Fixture = 'A_main_5MiB.bin'; Bytes = 5242880L; Sha = 'a742eacc473b469beb92b53518f78c236f72f22d428d1976a56bb5430da4f9f4' }
    [pscustomobject]@{ Slot = 'C-5MiB';    Path = $C5MiB;   Fixture = 'A_main_5MiB.bin'; Bytes = 5242880L; Sha = 'a742eacc473b469beb92b53518f78c236f72f22d428d1976a56bb5430da4f9f4' }
    [pscustomobject]@{ Slot = 'C-64KiB';   Path = $C64KiB;  Fixture = 'A_extra_64KiB.bin'; Bytes = 65536L; Sha = 'b695fdc3ca0b26f98145b736a63d6b206feeecc4e19c31b3e4d12b91ae5f96b4' }
    [pscustomobject]@{ Slot = 'C-0B';      Path = $C0B;     Fixture = 'A_empty_0B.bin'; Bytes = 0L; Sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
)

if (-not [string]::IsNullOrWhiteSpace($RunLabel)) {
    Write-Output "Run label (operator supplied; not verified): $RunLabel"
}
Write-Output 'Compare *saved* files from one synchronized run. No network or uploads are used.'
$passed = 0
$pending = 0
$failed = 0

foreach ($check in $checks) {
    if ([string]::IsNullOrWhiteSpace($check.Path)) {
        $pending++
        Write-Output "PENDING $($check.Slot): no saved-file path supplied"
        continue
    }

    try {
        $file = Get-Item -LiteralPath $check.Path -ErrorAction Stop
        if ($file -isnot [System.IO.FileInfo]) {
            throw 'Not a regular file'
        }
        # Get-FileHash reads the file locally; no browser, server or online service.
        $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        $actualBytes = $file.Length
        if ($actualBytes -eq $check.Bytes -and $actualHash -eq $check.Sha) {
            $passed++
            Write-Output "PASS    $($check.Slot): $($check.Fixture) bytes=$actualBytes sha256=$actualHash"
        } else {
            $failed++
            Write-Output "FAIL    $($check.Slot): $($check.Fixture) bytes=$actualBytes expectedBytes=$($check.Bytes)"
            Write-Output "        actualSHA256=$actualHash expectedSHA256=$($check.Sha)"
        }
    } catch {
        $failed++
        # Do not echo absolute device paths or exception text in shareable results.
        Write-Output "ERROR   $($check.Slot): saved file could not be read; check the local path and permissions"
    }
}

Write-Output "Totals: passed=$passed failed=$failed pending=$pending"
if ($failed -gt 0) {
    Write-Output 'RESULT: FAIL - at least one provided saved file is incorrect or unreadable'
    exit 1
}
if ($pending -gt 0) {
    Write-Output 'RESULT: PARTIAL - all provided files matched, but missing receipt slots remain'
    exit 2
}
Write-Output 'RESULT: ALL HASHES MATCH - operator must separately confirm same-run provenance'
exit 0
