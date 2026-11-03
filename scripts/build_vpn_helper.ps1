[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$TargetDir = Join-Path $ProjectRoot 'resources\vpn'
$TargetExe = Join-Path $TargetDir 'openvpn2socks.exe'
$HelperSource = Join-Path $ProjectRoot 'resources\vpn-helper-src\main.go'
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('drift-vpn-engine-' + [guid]::NewGuid().ToString('N'))
$SourceZip = Join-Path $TempRoot 'go-openvpn-source.zip'
$SourceRoot = Join-Path $TempRoot 'source'
$Commit = '2aa84a33b136'
$ModuleVersion = 'v0.0.0-20261001110108-2aa84a33b136'

try {
    if (-not (Test-Path -LiteralPath $HelperSource)) { throw "Drift's VPN helper source is missing: $HelperSource" }
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    New-Item -ItemType Directory -Path $SourceRoot -Force | Out-Null

    # Pin a reviewed source snapshot. This implementation supports the
    # OpenVPN3 profile modes used by VPN Gate, including AES-CBC data-channel
    # encryption, optional inline tls-auth/tls-crypt and plain TLS control mode.
    $headers = @{ 'User-Agent' = 'Drift-Browser-VPN-Helper-Build' }
    $archiveUrl = "https://codeload.github.com/buengese/go-openvpn/zip/$Commit"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $SourceZip -Headers $headers
    Expand-Archive -LiteralPath $SourceZip -DestinationPath $SourceRoot -Force

    $repository = Get-ChildItem -LiteralPath $SourceRoot -Directory | Select-Object -First 1
    if (-not $repository) { throw 'The OpenVPN engine source archive was empty.' }
    $goMod = Join-Path $repository.FullName 'go.mod'
    $license = Join-Path $repository.FullName 'LICENSE'
    $licenseException = Join-Path $repository.FullName 'LICENSE_USAGE_EXCEPTION'
    if (-not (Test-Path -LiteralPath $goMod)) { throw 'The pinned OpenVPN source archive has no go.mod.' }
    if (-not (Test-Path -LiteralPath $license)) { throw 'The OpenVPN LGPL license file is missing.' }
    if (-not (Test-Path -LiteralPath $licenseException)) { throw 'The OpenVPN usage exception is missing.' }

    $commandDir = Join-Path $repository.FullName 'cmd\drift-vpngate-proxy'
    New-Item -ItemType Directory -Path $commandDir -Force | Out-Null
    Copy-Item -LiteralPath $HelperSource -Destination (Join-Path $commandDir 'main.go') -Force

    $env:GOTOOLCHAIN = 'auto'
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'

    Push-Location -LiteralPath $repository.FullName
    try {
        # Vendor the exact pinned engine and transitive dependencies. The
        # matching source archive later contains the same vendor tree.
        & go mod vendor
        if ($LASTEXITCODE -ne 0) { throw 'go mod vendor failed.' }

        $buildArgs = @(
            'build', '-trimpath', '-buildvcs=false', '-mod=vendor',
            '-ldflags', '-s -w',
            '-o', $TargetExe,
            '.\cmd\drift-vpngate-proxy'
        )
        & go @buildArgs
        if ($LASTEXITCODE -ne 0) { throw 'The VPN Gate userspace helper did not compile for Windows x64.' }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $TargetExe)) { throw 'The compiler did not create openvpn2socks.exe.' }
    $file = Get-Item -LiteralPath $TargetExe
    if ($file.Length -lt 1MB) { throw "The VPN helper binary is unexpectedly small ($($file.Length) bytes)." }

    $sourceOffer = Join-Path $TargetDir 'GO-OPENVPN-CORRESPONDING-SOURCE.zip'
    if (Test-Path -LiteralPath $sourceOffer) { Remove-Item -LiteralPath $sourceOffer -Force }
    Compress-Archive -Path (Join-Path $repository.FullName '*') -DestinationPath $sourceOffer -CompressionLevel Optimal

    Copy-Item -LiteralPath $license -Destination (Join-Path $TargetDir 'GO-OPENVPN-LICENSE.txt') -Force
    Copy-Item -LiteralPath $licenseException -Destination (Join-Path $TargetDir 'GO-OPENVPN-LICENSE-EXCEPTION.txt') -Force

    $versionInfo = @(
        'Component: github.com/buengese/go-openvpn + Drift SOCKS5 bridge',
        "Source commit: $Commit",
        "Go module version: $ModuleVersion",
        "Built: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
        "Go: $((& go version) -join ' ')",
        'Target: windows/amd64; CGO_ENABLED=0',
        'Features: TLS-only, tls-crypt and tls-auth parsing; AES-GCM and AES-CBC data channels as allowed by pinned engine capability preflight; in-process gVisor userspace stack; loopback SOCKS5 CONNECT.',
        'Network scope: Drift browser session only; no TUN/TAP, host routes, DNS changes, firewall changes or elevation.',
        'License: LGPL-2.1-or-later with usage exception; see accompanying license files and corresponding source archive.'
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $TargetDir 'ENGINE-VERSION.txt') -Value $versionInfo -Encoding UTF8

    Write-Host "Built openvpn2socks.exe ($($file.Length) bytes) from buengese/go-openvpn commit $Commit"
    Write-Host 'The matching vendored source archive, LGPL license and usage exception are included beside the helper binary.'
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
