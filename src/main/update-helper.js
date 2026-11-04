'use strict';

// Generates the long-lived, hidden Windows helper that owns the update lock.
// It writes a readiness marker before Drift exits, waits for the exact browser
// PID to close, and keeps running until Setup has installed and health-checked
// the new browser. PowerShell is used as the persistent helper process so the
// PID recorded in apply.lock remains alive for the whole handoff.

function psLiteral(value) {
  const text = String(value == null ? '' : value);
  if (/[\0\r\n]/.test(text)) throw new Error('Unsafe character in an update path.');
  return `'${text.replace(/'/g, "''")}'`;
}

// Windows CommandLineToArgvW-compatible quoting for ProcessStartInfo.Arguments.
function quoteWindowsArg(value) {
  const text = String(value == null ? '' : value);
  if (text.length && !/[\s"]/.test(text)) return text;
  let out = '"';
  let slashes = 0;
  for (const char of text) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  out += '\\'.repeat(slashes * 2) + '"';
  return out;
}

function buildApplyScript(options) {
  const {
    pid, installer, installDir, exe, lock, pending, log, readyFile, readyToken,
    healthcheckFile, healthcheckToken, relaunch = false,
    baseCacheDir, baseFile, baseMeta, baseVersion, baseSha256, baseSize
  } = options || {};
  const required = { installer, installDir, exe, lock, pending, log, readyFile, readyToken };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null || String(value) === '') throw new Error(`Missing update helper value: ${name}`);
  }
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw new Error('Invalid Drift process ID for update helper.');
  if (!/^[a-f0-9]{32,64}$/i.test(String(readyToken))) throw new Error('Invalid update helper readiness token.');

  const argumentsList = ['/S', '--updated', '--silent-update', `--update-dir=${installDir}`, `--pending-file=${pending}`];
  if (healthcheckFile && healthcheckToken) {
    argumentsList.push(`--healthcheck-file=${healthcheckFile}`, `--healthcheck-token=${healthcheckToken}`);
  }
  if (relaunch) argumentsList.push('--force-run');
  const argumentLine = argumentsList.map(quoteWindowsArg).join(' ');
  const cacheEnabled = baseCacheDir && baseFile && baseMeta && /^\d+\.\d+\.\d+$/.test(String(baseVersion || ''))
    && /^[a-f0-9]{64}$/i.test(String(baseSha256 || '')) && Number.isSafeInteger(Number(baseSize)) && Number(baseSize) > 0;

  return [
    "$ErrorActionPreference = 'Stop'",
    `$DriftPid = ${Number(pid)}`,
    `$Installer = ${psLiteral(installer)}`,
    `$InstallDir = ${psLiteral(installDir)}`,
    `$DriftExe = ${psLiteral(exe)}`,
    `$LockFile = ${psLiteral(lock)}`,
    `$PendingFile = ${psLiteral(pending)}`,
    `$LogFile = ${psLiteral(log)}`,
    `$ReadyFile = ${psLiteral(readyFile)}`,
    `$ReadyToken = ${psLiteral(readyToken)}`,
    `$Relaunch = $${relaunch ? 'true' : 'false'}`,
    `$InstallerArguments = ${psLiteral(argumentLine)}`,
    ...(cacheEnabled ? [
      `$BaseDir = ${psLiteral(baseCacheDir)}`,
      `$BaseFile = ${psLiteral(baseFile)}`,
      `$BaseMeta = ${psLiteral(baseMeta)}`,
      `$BaseVersion = ${psLiteral(baseVersion)}`,
      `$BaseSha256 = ${psLiteral(baseSha256)}`,
      `$BaseSize = ${Number(baseSize)}`
    ] : ['$BaseDir = $null', '$BaseFile = $null', '$BaseMeta = $null']),
    'function Write-UpdateLog([string]$Message) {',
    '  try {',
    '    $line = "[$([DateTime]::Now.ToString(\'o\'))] helper: $Message" + [Environment]::NewLine',
    '    [IO.File]::AppendAllText($LogFile, $line)',
    '  } catch { }',
    '}',
    'function Test-DriftProcessAlive {',
    '  try {',
    '    $item = Get-CimInstance Win32_Process -Filter "ProcessId=$DriftPid" -ErrorAction Stop',
    '    if (-not $item) { return $false }',
    '    if ($item.Name -ne \'Drift.exe\') { return $false }',
    '    $root = $InstallDir.TrimEnd([char]92) + [char]92',
    '    return [bool]($item.ExecutablePath -and $item.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))',
    '  } catch {',
    '    try { $fallback = Get-Process -Id $DriftPid -ErrorAction Stop; return ($fallback.ProcessName -ieq \'Drift\') } catch { return $false }',
    '  }',
    '}',
    '$ExitCode = 1',
    'try {',
    '  Write-UpdateLog "helper running; waiting for Drift PID $DriftPid"',
    '  [IO.File]::WriteAllText($ReadyFile, $ReadyToken, [Text.Encoding]::ASCII)',
    '  $deadline = [DateTime]::Now.AddMinutes(3)',
    '  while (Test-DriftProcessAlive) {',
    '    if ([DateTime]::Now -gt $deadline) { throw "Drift process $DriftPid did not close within 3 minutes." }',
    '    Start-Sleep -Milliseconds 350',
    '  }',
    '  Start-Sleep -Milliseconds 700',
    '  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "The staged installer is missing: $Installer" }',
    '  Write-UpdateLog "starting verified Setup package"',
    '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
    '  $psi.FileName = $Installer',
    '  $psi.Arguments = $InstallerArguments',
    '  $psi.WorkingDirectory = $env:TEMP',
    '  $psi.UseShellExecute = $false',
    '  $psi.CreateNoWindow = $true',
    '  $setup = [System.Diagnostics.Process]::Start($psi)',
    '  if (-not $setup) { throw "Windows did not start the Setup package." }',
    '  $setup.WaitForExit()',
    '  $setupCode = $setup.ExitCode',
    '  Write-UpdateLog "Setup process exited with code $setupCode"',
    '  if ($setupCode -ne 0) { throw "Setup failed with exit code $setupCode." }',
    ...(cacheEnabled ? [
      '  try {',
      '    New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null',
      '    Copy-Item -LiteralPath $Installer -Destination $BaseFile -Force',
      '    $meta = @{ version = $BaseVersion; sha256 = $BaseSha256; size = $BaseSize; file = [IO.Path]::GetFileName($BaseFile) } | ConvertTo-Json -Compress',
      '    $tempMeta = "$BaseMeta.tmp"',
      '    [IO.File]::WriteAllText($tempMeta, $meta, [Text.UTF8Encoding]::new($false))',
      '    Move-Item -LiteralPath $tempMeta -Destination $BaseMeta -Force',
      '    Get-ChildItem -LiteralPath $BaseDir -Filter \'Drift-Setup-*.exe\' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $BaseFile } | Remove-Item -Force -ErrorAction SilentlyContinue',
      '    Write-UpdateLog "cached verified v$BaseVersion Setup as next differential base"',
      '  } catch { Write-UpdateLog "could not cache Setup for differential updates: $($_.Exception.Message)" }'
    ] : []),
    '  Remove-Item -LiteralPath $PendingFile -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue',
    '  Write-UpdateLog "update finished and health-checked"',
    '  $ExitCode = 0',
    '} catch {',
    '  $message = $_.Exception.Message',
    '  Write-UpdateLog "UPDATE FAILED: $message"',
    '  try {',
    '    if (Test-Path -LiteralPath $PendingFile) {',
    '      $state = Get-Content -LiteralPath $PendingFile -Raw | ConvertFrom-Json',
    '      $state | Add-Member -NotePropertyName nextAttemptAt -NotePropertyValue ([DateTimeOffset]::UtcNow.AddMinutes(15).ToUnixTimeMilliseconds()) -Force',
    '      $state | Add-Member -NotePropertyName lastError -NotePropertyValue ([string]$message).Substring(0, [Math]::Min(500, ([string]$message).Length)) -Force',
    '      $json = $state | ConvertTo-Json -Depth 8',
    '      [IO.File]::WriteAllText($PendingFile, $json, [Text.UTF8Encoding]::new($false))',
    '    }',
    '  } catch { Write-UpdateLog "could not persist retry delay: $($_.Exception.Message)" }',
    '  if ($Relaunch -and (Test-Path -LiteralPath $DriftExe -PathType Leaf)) {',
    '    try { Start-Process -FilePath $DriftExe -WorkingDirectory $InstallDir | Out-Null; Write-UpdateLog "reopened the previous Drift installation after update failure" }',
    '    catch { Write-UpdateLog "could not reopen Drift after update failure: $($_.Exception.Message)" }',
    '  }',
    '  $ExitCode = 1',
'} finally {',
    '  Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue',
'}',
'exit $ExitCode'
  ].join('\r\n');
}

module.exports = { buildApplyScript, quoteWindowsArg, psLiteral };
