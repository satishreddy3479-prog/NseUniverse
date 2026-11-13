# Off-server copy of everything that cannot be re-created: the stored option-chain snapshots, the end-of-day archives and manifests,
# and the nightly database backups. The server keeps one copy only; this puts a second one on your own disk.
#   powershell -ExecutionPolicy Bypass -File scripts\pull-backups.ps1                 # copy what is new
#   powershell -ExecutionPolicy Bypass -File scripts\pull-backups.ps1 -ListOnly       # only say what would be copied
#   powershell -ExecutionPolicy Bypass -File scripts\pull-backups.ps1 -Dest D:\NseBackup
# Safe to run any time and as often as you like: it only ever ADDS or completes files here; it never deletes anything, on either side.
# Needs the same ssh access you already use (`ssh nse-server`) and Windows' built-in tar.
param(
  [string]$Dest = "S:\NseUniverse-backups",
  [string]$Server = "nse-server",
  [switch]$ListOnly
)
$ErrorActionPreference = "Stop"

function Remote([string]$cmd) { $out = & ssh $Server $cmd; if ($LASTEXITCODE -ne 0) { throw "ssh failed: $cmd" }; $out }

# (remote folder, folders inside it to copy, local sub-folder)
$jobs = @(
  @{ Root = "/var/lib/nse-universe/data"; Paths = "archive snapshots manifests"; Local = "data" },
  @{ Root = "/var/backups/nse-universe"; Paths = "."; Local = "db-backups" }
)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$totalFiles = 0; $totalBytes = 0

foreach ($j in $jobs) {
  $local = Join-Path $Dest $j.Local
  New-Item -ItemType Directory -Force -Path $local | Out-Null
  Write-Host "== $($j.Root) -> $local"
  # every regular file with its size, relative to the root; '.tmp' files are in-progress writes and are skipped
  $lines = Remote "cd $($j.Root) && find $($j.Paths) -type f ! -name '*.tmp' ! -name '*.sqlite3-wal' ! -name '*.sqlite3-shm' -printf '%p\t%s\n' | sed 's/^\.\///'"
  $missing = New-Object System.Collections.Generic.List[string]
  $bytes = 0
  foreach ($l in $lines) {
    if (-not $l) { continue }
    $p = $l -split "`t"
    if ($p.Count -lt 2) { continue }
    $f = Join-Path $local ($p[0] -replace "/", "\")
    if (-not (Test-Path $f) -or (Get-Item $f).Length -ne [int64]$p[1]) { $missing.Add($p[0]); $bytes += [int64]$p[1] }
  }
  Write-Host ("   {0} files on the server, {1} to copy ({2:N1} MB)" -f @($lines).Count, $missing.Count, ($bytes / 1MB))
  $totalFiles += $missing.Count; $totalBytes += $bytes
  if ($ListOnly -or $missing.Count -eq 0) { continue }
  # one archive per job: far faster than one transfer per file
  $tmpList = New-TemporaryFile
  [System.IO.File]::WriteAllText($tmpList, (($missing -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))   # LF line ends, no byte-order mark: tar reads the list on Linux
  $stamp = Get-Date -Format "yyyyMMddHHmmss"
  $remoteList = "/tmp/nse-pull-$stamp.list"; $remoteTgz = "/tmp/nse-pull-$stamp.tgz"
  & scp -q $tmpList "${Server}:$remoteList"
  if ($LASTEXITCODE -ne 0) { throw "could not send the file list" }
  Remote "cd $($j.Root) && tar -czf $remoteTgz -T $remoteList" | Out-Null
  $localTgz = Join-Path $env:TEMP "nse-pull-$stamp.tgz"
  & scp -q "${Server}:$remoteTgz" $localTgz
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }
  & tar -xzf $localTgz -C $local
  if ($LASTEXITCODE -ne 0) { throw "could not unpack $localTgz" }
  Remove-Item $localTgz, $tmpList -Force
  Remote "rm -f $remoteList $remoteTgz" | Out-Null
  # verify: every file that was missing is now here with the server's size
  $bad = 0
  foreach ($l in $lines) { $p = $l -split "`t"; if ($p.Count -ge 2 -and $missing.Contains($p[0])) { $f = Join-Path $local ($p[0] -replace "/", "\"); if (-not (Test-Path $f) -or (Get-Item $f).Length -ne [int64]$p[1]) { $bad++ } } }
  if ($bad -gt 0) { Write-Host "   WARNING: $bad file(s) did not arrive complete; run this script again" -ForegroundColor Yellow } else { Write-Host "   copied and checked" -ForegroundColor Green }
}
if ($ListOnly) { Write-Host ("Would copy {0} file(s), {1:N1} MB. Nothing was changed." -f $totalFiles, ($totalBytes / 1MB)) }
else { Write-Host ("Done: {0} file(s), {1:N1} MB copied to {2}." -f $totalFiles, ($totalBytes / 1MB), $Dest) }
