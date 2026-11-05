<#
.SYNOPSIS
  Create the phone app's release signing key, and optionally store it as GitHub secrets.

.DESCRIPTION
  The key signs every APK .github/workflows/mobile-release.yml publishes. Android installs an
  update only when it is signed with the SAME key as the installed app, so:
    - keep the .jks and its password safe (a password manager), outside this repository;
    - losing it means every phone must uninstall Conduit once to take a build signed by a new key.

  Without -SetSecrets the script only creates the key and tells you what to store where.
  With -SetSecrets it also runs `gh secret set` for the four MOBILE_* secrets on -Repo.

  Windows PowerShell 5.1 compatible. Needs keytool (any JDK 17) and, for -SetSecrets, gh.

.EXAMPLE
  & ./mobile/scripts/New-ReleaseKey.ps1 -OutFile "$HOME/conduit-keys/conduit-release.jks" -SetSecrets
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutFile,
  [string]$Alias = 'conduit-release',
  [string]$Repo = 'arlofyi/conduit',
  [switch]$SetSecrets
)

$ErrorActionPreference = 'Stop'

function New-RandomSecret {
  param([int]$Bytes = 24)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  # URL-safe base64, no padding: keytool and gradle take it as-is.
  return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Keytool {
  $candidates = @()
  if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin/keytool.exe') }
  $onPath = Get-Command keytool -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw 'keytool not found: set JAVA_HOME to a JDK 17 or put keytool on PATH.'
}

try {
  if (Test-Path $OutFile) {
    throw "$($OutFile) already exists. Refusing to overwrite a signing key (installed phones depend on it)."
  }
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
  $outFull = [System.IO.Path]::GetFullPath($OutFile)
  if ($outFull.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Put the key OUTSIDE the repository.'
  }
  $dir = Split-Path -Parent $outFull
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

  $keytool = Get-Keytool
  # PKCS12 keystores use one password for the store and the key.
  $password = New-RandomSecret
  $keytoolArgs = @(
    '-genkeypair', '-v',
    '-storetype', 'PKCS12',
    '-keystore', $outFull,
    '-alias', $Alias,
    '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '10000',
    '-storepass', $password,
    '-keypass', $password,
    '-dname', 'CN=Conduit phone app, O=Arlo'
  )
  & $keytool @keytoolArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $($LASTEXITCODE)." }
  Write-Output "Created $($outFull)"

  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($outFull))
  if ($SetSecrets) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { throw 'gh not found; install the GitHub CLI or set the secrets by hand.' }
    $secrets = [ordered]@{
      MOBILE_KEYSTORE_BASE64   = $b64
      MOBILE_KEYSTORE_PASSWORD = $password
      MOBILE_KEY_ALIAS         = $Alias
      MOBILE_KEY_PASSWORD      = $password
    }
    foreach ($name in $secrets.Keys) {
      # Piped on stdin so the value never appears on a command line.
      $secrets[$name] | & gh secret set $name --repo $Repo
      if ($LASTEXITCODE -ne 0) { throw "gh secret set $($name) failed." }
      Write-Output "Set secret $($name) on $($Repo)"
    }
  }

  # Never printed: a terminal's scrollback (or a transcript) is not a place for it.
  Set-Clipboard -Value $password
  Write-Output ''
  Write-Output 'The key password is on your clipboard. Store it in your password manager NOW,'
  Write-Output 'together with the keystore file below (neither is saved anywhere else):'
  Write-Output "  keystore file : $($outFull)"
  Write-Output "  alias         : $($Alias)"
  if (-not $SetSecrets) {
    Write-Output ''
    Write-Output "Then set the four MOBILE_* secrets on $($Repo) (see mobile/README.md, 'Releases'),"
    Write-Output 'or run this script again on a new -OutFile with -SetSecrets.'
  }
}
catch {
  Write-Error "New-ReleaseKey: $($_.Exception.Message)"
  exit 1
}
