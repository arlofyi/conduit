#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only snapshot of Conduit's process tree and per-session memory on Windows.

.DESCRIPTION
    Prints, for the Conduit process (auto-detected, or -ConduitPid):
      * the full process tree under it
      * totals per direct child of Conduit. An agent session is its cmd.exe plus every
        descendant: claude.exe, MCP servers, npx/uv shims, venv launchers.
      * every claude.exe on the machine and which host owns it
      * orphans: watched processes (claude, node, python, uv, uvx, npx, bun, deno)
        whose parent is no longer running
      * machine-wide totals per process name

    A parent PID that now belongs to a process started AFTER the child is a reused PID,
    not the real parent, so the child is treated as orphaned.

    Nothing is changed, stopped or killed. Command lines are masked before they are
    printed or saved: values that look like keys, tokens, passwords or bearer
    credentials become ***.

    Memory columns:
      PrivMB  private bytes (commit charge): what adds up to "Committed" in Task Manager
      WsMB    working set: what is resident in RAM right now

    Runs on Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER ConduitPid
    PID of the Conduit process to treat as the root. Default: every running process whose
    name matches -ConduitNamePattern and whose parent is not also Conduit.

.PARAMETER ConduitNamePattern
    Regex for Conduit's executable name. Covers the installed app and a dev build.

.PARAMETER WatchNamePattern
    Regex for the process names checked for orphans.

.PARAMETER JsonPath
    Also save the snapshot (masked) as JSON, for comparing test steps.

.PARAMETER BaselinePath
    A JSON snapshot saved earlier with -JsonPath. Lists every process from that snapshot's
    Conduit children, claude.exe list and orphans that is STILL running now (same PID and
    same start time). This answers "did every descendant exit?".

.PARAMETER Label
    Free text stored in the JSON snapshot, e.g. "3 sessions open".

.PARAMETER MaxCommandLength
    Truncate printed command lines to this many characters. The JSON keeps the full
    masked line.

.PARAMETER NoTree
    Skip the full process-tree listing.

.PARAMETER StatePath
    Optional path to Conduit's state.json (normally %APPDATA%\ConduitTauri\state.json).
    When given, session ids are labelled "Project / Session" and the report counts how many
    sessions Conduit knows about versus how many are running. Only project names, session
    names, ids, agents and the stopped flag are read from it.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-sessions.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-sessions.ps1 -Label 'tabs closed' -JsonPath step3.json -BaselinePath step2.json
#>
[CmdletBinding()]
param(
    [int]$ConduitPid = 0,
    [string]$ConduitNamePattern = '^(conduit|conduit-tauri)\.exe$',
    [string]$WatchNamePattern = '^(claude|node|python|pythonw|uv|uvx|npx|bun|deno)\.exe$',
    [string]$JsonPath = '',
    [string]$BaselinePath = '',
    [string]$Label = '',
    [ValidateRange(40, 100000)]
    [int]$MaxCommandLength = 160,
    [switch]$NoTree,
    [string]$StatePath = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Names that are never a meaningful "host" for an agent: a claude.exe whose outermost
# ancestor is explorer.exe was started by something below it (a terminal, an IDE), and
# that something is the answer.
$osProcessPattern = '^(explorer|svchost|services|wininit|winlogon|sihost|userinit|smss|csrss|lsass|taskhostw|RuntimeBroker|ShellExperienceHost|StartMenuExperienceHost)\.exe$|^(System|Registry|Idle)$'

# Process names worth a line in the machine-wide totals besides the watched ones.
$totalsExtraPattern = '^(cmd|conhost|openconsole|msedgewebview2|bash|git|curl)\.exe$'

$ignoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
$caseSensitive = [System.Text.RegularExpressions.RegexOptions]::None

# Applied in order. Each rule keeps the NAME of what it masks (the flag, the variable, the
# query key) so the output still says what was there.
$secretRules = @(
    # user:password@ inside a URL
    @{ Regex = [regex]::new('(?<=://)[^/\s:@"'']+:[^/\s@"'']+@', $ignoreCase); Replacement = '***:***@' }
    # Bearer <token>
    @{ Regex = [regex]::new('(bearer\s+)[A-Za-z0-9._~+/=-]+', $ignoreCase); Replacement = '$1***' }
    # --api-key VALUE, --token=VALUE, -password "VALUE"
    @{ Regex = [regex]::new('((?<![\w-])--?[\w-]*(?:api[-_]?key|token|secret|passw(?:or)?d|credential|auth)[\w-]*(?:=|\s+))("[^"]*"|''[^'']*''|[^\s"'']+)', $ignoreCase); Replacement = '$1***' }
    # SOME_API_KEY=VALUE (upper-case names only, so ordinary words are left alone)
    @{ Regex = [regex]::new('(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*)("[^"]*"|[^\s"'',;&]+)', $caseSensitive); Replacement = '$1***' }
    # "apiKey": "VALUE" in inline JSON
    @{ Regex = [regex]::new('("[\w-]*(?:api[-_]?key|token|secret|passw(?:or)?d|credential|auth)[\w-]*"\s*:\s*")[^"]*(")', $ignoreCase); Replacement = '$1***$2' }
    # ?token=VALUE&key=VALUE
    @{ Regex = [regex]::new('([?&][\w-]*(?:token|key|secret|passw(?:or)?d|auth|sig)[\w-]*=)[^&\s"'']+', $ignoreCase); Replacement = '$1***' }
    # Well-known credential shapes
    @{ Regex = [regex]::new('\b(?:sk-ant-[\w-]{8,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|glpat-[\w-]{20,})', $caseSensitive); Replacement = '***' }
    # JWTs
    @{ Regex = [regex]::new('\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}', $caseSensitive); Replacement = '***' }
    # Any remaining long opaque run that mixes letters and digits. Dashed UUIDs (session
    # ids) are deliberately NOT matched: they are needed to attribute processes.
    @{ Regex = [regex]::new('(?<![\w/\\.:-])(?=[A-Za-z0-9+_=]*\d)(?=[A-Za-z0-9+_=]*[A-Za-z])[A-Za-z0-9+_=]{32,}(?![\w/\\.-])', $caseSensitive); Replacement = '***' }
)

function Hide-Secret {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $masked = $Text
    foreach ($rule in $secretRules) {
        $masked = $rule.Regex.Replace($masked, $rule.Replacement)
    }
    return $masked
}

function Format-CommandLine {
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Text, [int]$Max)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $flat = ($Text -replace '\s+', ' ').Trim()
    if ($flat.Length -le $Max) { return $flat }
    return $flat.Substring(0, $Max - 3) + '...'
}

function Format-Time {
    [OutputType([string])]
    param($Value)
    if ($null -eq $Value) { return '' }
    return ([datetime]$Value).ToString('yyyy-MM-dd HH:mm')
}

function Format-Iso {
    [OutputType([string])]
    param($Value)
    if ($null -eq $Value) { return '' }
    return ([datetime]$Value).ToString('o')
}

# Exact start time as UTC ticks: the second half of a process identity (PID, start time),
# compared across snapshots. A digit string, not an ISO date, because PowerShell 7's
# ConvertFrom-Json turns ISO strings back into dates and the comparison would drift.
function Get-StartKey {
    [OutputType([string])]
    param($Value)
    if ($null -eq $Value) { return '' }
    return [string]([datetime]$Value).ToUniversalTime().Ticks
}

function Get-AgeHours {
    param($Value, [datetime]$Now)
    if ($null -eq $Value) { return $null }
    return [math]::Round(($Now - [datetime]$Value).TotalHours, 1)
}

function Get-Total {
    param([object[]]$Items, [string]$Property)
    $sum = 0.0
    foreach ($item in $Items) { $sum += [double]$item.$Property }
    return [math]::Round($sum, 1)
}

function Format-Breakdown {
    [OutputType([string])]
    param([object[]]$Items)
    $sortSpec = @(@{ Expression = 'Count'; Descending = $true }, @{ Expression = 'Name'; Descending = $false })
    $groups = @($Items | Group-Object -Property Name | Sort-Object -Property $sortSpec)
    return (($groups | ForEach-Object { '{0} {1}' -f ($_.Name -replace '\.exe$', ''), $_.Count }) -join ', ')
}

function Get-ProcessSnapshot {
    [CmdletBinding()]
    param()
    # Get-Process supplies the memory figures (the counters Task Manager shows); Win32_Process
    # supplies what Get-Process cannot: the parent PID and the command line.
    $memoryById = @{}
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
        $memoryById[[int]$proc.Id] = $proc
    }
    $snapshot = @{}
    foreach ($cim in @(Get-CimInstance -ClassName Win32_Process -Verbose:$false)) {
        $id = [int]$cim.ProcessId
        if ($id -eq 0) { continue }
        $wsBytes = [double]$cim.WorkingSetSize
        $privateBytes = [double]$cim.PrivatePageCount
        $live = $memoryById[$id]
        if ($null -ne $live) {
            $wsBytes = [double]$live.WorkingSet64
            $privateBytes = [double]$live.PrivateMemorySize64
        }
        $raw = [string]$cim.CommandLine
        $snapshot[$id] = [pscustomobject]@{
            Pid            = $id
            ParentPid      = [int]$cim.ParentProcessId
            Name           = [string]$cim.Name
            Created        = $cim.CreationDate
            WsMB           = [math]::Round($wsBytes / 1MB, 1)
            PrivMB         = [math]::Round($privateBytes / 1MB, 1)
            CommandLineRaw = $raw
            CommandLine    = Hide-Secret -Text $raw
        }
    }
    return $snapshot
}

function Test-LiveParent {
    [OutputType([bool])]
    param([Parameter(Mandatory)] $Process, [Parameter(Mandatory)] [hashtable]$ById)
    $parent = $ById[$Process.ParentPid]
    if ($null -eq $parent -or $parent.Pid -eq $Process.Pid) { return $false }
    # Windows recycles PIDs: a "parent" that started after the child is a stranger that
    # inherited the dead parent's number.
    if ($null -ne $parent.Created -and $null -ne $Process.Created -and $parent.Created -gt $Process.Created) {
        return $false
    }
    return $true
}

function Get-ChildMap {
    param([hashtable]$ById)
    $map = @{}
    foreach ($proc in $ById.Values) {
        if (-not (Test-LiveParent -Process $proc -ById $ById)) { continue }
        if (-not $map.ContainsKey($proc.ParentPid)) {
            $map[$proc.ParentPid] = New-Object System.Collections.Generic.List[object]
        }
        $map[$proc.ParentPid].Add($proc)
    }
    return $map
}

function Get-Descendant {
    param([int]$RootPid, [hashtable]$ChildMap)
    $found = New-Object System.Collections.Generic.List[object]
    $pending = New-Object System.Collections.Generic.Stack[int]
    $pending.Push($RootPid)
    $visited = @{}
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        if ($visited.ContainsKey($current)) { continue }
        $visited[$current] = $true
        $children = $ChildMap[$current]
        if ($null -eq $children) { continue }
        foreach ($child in $children) {
            $found.Add($child)
            $pending.Push($child.Pid)
        }
    }
    return $found.ToArray()
}

function Get-AncestorChain {
    param($Process, [hashtable]$ById)
    $chain = New-Object System.Collections.Generic.List[object]
    $current = $Process
    while ($chain.Count -lt 64 -and (Test-LiveParent -Process $current -ById $ById)) {
        $current = $ById[$current.ParentPid]
        $chain.Add($current)
    }
    return $chain.ToArray()
}

# What a direct child of Conduit is, from its command line. Agent sessions run
# `cmd.exe /K <dataDir>\spawn-<sessionId>.cmd` (pty.rs write_spawn_script); the
# companion shell is a bare cmd.exe; `claude -p` children are the titler or root chat.
function Get-ConduitChildKind {
    param($Process)
    $name = $Process.Name.ToLowerInvariant()
    $raw = $Process.CommandLineRaw
    if ($null -eq $raw) { $raw = '' }
    $idPattern = '(--session-id|--resume)\s+"?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
    if ($name -eq 'cmd.exe') {
        if ($raw -match 'spawn-([^\\/\s"^]+?)\.cmd') { return @{ Kind = 'agent-session'; SessionId = $Matches[1] } }
        if ($raw -match 'claude(\.exe)?"?\s+-p\b') {
            if ($raw -match $idPattern) { return @{ Kind = 'claude -p (root chat)'; SessionId = $Matches[2] } }
            if ($raw -match '--model\s+haiku') { return @{ Kind = 'claude -p (titler)'; SessionId = '' } }
            return @{ Kind = 'claude -p'; SessionId = '' }
        }
        # Spawn-script write failed: pty.rs falls back to the inline invocation.
        if ($raw -match $idPattern) { return @{ Kind = 'agent-session (inline)'; SessionId = $Matches[2] } }
        if ($raw -match '\s/[KkCc]\s') { return @{ Kind = 'cmd (unrecognized)'; SessionId = '' } }
        return @{ Kind = 'shell'; SessionId = '' }
    }
    if ($name -eq 'conhost.exe' -or $name -eq 'openconsole.exe') { return @{ Kind = 'conpty-host'; SessionId = '' } }
    if ($name -eq 'msedgewebview2.exe') { return @{ Kind = 'webview2'; SessionId = '' } }
    return @{ Kind = 'other'; SessionId = '' }
}

# Who owns a process: a Conduit child (named by session), an orphaned tree, or the
# outermost non-OS ancestor (a terminal, an IDE).
function Get-HostLabel {
    param($Process, [hashtable]$ById, [hashtable]$ConduitRoots, [hashtable]$DirectChildInfo)
    # The desktop app's Electron processes are ALSO named claude.exe; a count by name alone
    # mixes them with Claude Code CLI sessions.
    if ($Process.CommandLineRaw -match '\\WindowsApps\\Claude_|\\AnthropicClaude\\') { return 'Claude desktop app' }
    $chain = @(Get-AncestorChain -Process $Process -ById $ById)
    $below = $Process
    foreach ($ancestor in $chain) {
        if ($ConduitRoots.ContainsKey($ancestor.Pid)) {
            $info = $DirectChildInfo[$below.Pid]
            if ($null -eq $info) { return 'Conduit' }
            if ($info.SessionId) { return "Conduit $($info.Kind) $($info.SessionId)" }
            return "Conduit $($info.Kind)"
        }
        $below = $ancestor
    }
    if ($chain.Count -eq 0) { return 'ORPHAN (parent gone)' }
    $root = $chain[$chain.Count - 1]
    if ($root.Name -match $WatchNamePattern) { return "ORPHANED TREE under $($root.Name) $($root.Pid)" }
    $outermostApp = $null
    foreach ($ancestor in $chain) {
        if ($ancestor.Name -notmatch $osProcessPattern) { $outermostApp = $ancestor }
    }
    if ($null -eq $outermostApp) { return $chain[0].Name }
    return $outermostApp.Name
}

# Session id -> project/session/agent/stopped, from Conduit's state.json. Handles the legacy
# layout where the file is a bare array of projects.
function Get-SessionCatalog {
    param([string]$Path)
    $catalog = @{}
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $projects = $state
    if ($null -ne $state.PSObject.Properties['projects']) { $projects = $state.projects }
    foreach ($project in @($projects)) {
        if ($null -eq $project -or $null -eq $project.PSObject.Properties['sessions']) { continue }
        foreach ($session in @($project.sessions)) {
            $stopped = $false
            if ($null -ne $session.PSObject.Properties['stopped']) { $stopped = [bool]$session.stopped }
            $agent = ''
            if ($null -ne $session.PSObject.Properties['agent']) { $agent = [string]$session.agent }
            $catalog[[string]$session.id] = [pscustomobject]@{
                Project = [string]$project.name
                Session = [string]$session.name
                Agent   = $agent
                Stopped = $stopped
            }
        }
    }
    return $catalog
}

function Get-SessionLabel {
    param([string]$SessionId, [hashtable]$Catalog)
    if (-not $SessionId) { return '' }
    $entry = $Catalog[$SessionId]
    if ($null -eq $entry) { return '' }
    return '{0} / {1}' -f $entry.Project, $entry.Session
}

function Get-SystemMemory {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -Verbose:$false
    $result = [ordered]@{
        TotalRamGB        = [math]::Round(([double]$os.TotalVisibleMemorySize * 1KB) / 1GB, 1)
        AvailableGB       = $null
        CommittedGB       = $null
        CommitLimitGB     = $null
        CompressedStoreMB = $null
    }
    try {
        $perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -Verbose:$false
        $result.AvailableGB = [math]::Round([double]$perf.AvailableMBytes / 1KB, 1)
        $result.CommittedGB = [math]::Round([double]$perf.CommittedBytes / 1GB, 1)
        $result.CommitLimitGB = [math]::Round([double]$perf.CommitLimit / 1GB, 1)
    }
    catch {
        Write-Verbose "Memory performance counters unavailable: $($_.Exception.Message)"
        $result.AvailableGB = [math]::Round(([double]$os.FreePhysicalMemory * 1KB) / 1GB, 1)
    }
    $compression = @(Get-Process -Name 'Memory Compression' -ErrorAction SilentlyContinue)
    if ($compression.Count -gt 0) {
        $result.CompressedStoreMB = [math]::Round([double]$compression[0].WorkingSet64 / 1MB)
    }
    return [pscustomobject]$result
}

function Get-TreeRow {
    param($Process, [int]$Depth, [hashtable]$ChildMap)
    [pscustomobject]@{
        Process     = ('  ' * $Depth) + $Process.Name
        Pid         = $Process.Pid
        PPid        = $Process.ParentPid
        PrivMB      = $Process.PrivMB
        WsMB        = $Process.WsMB
        Started     = Format-Time $Process.Created
        CommandLine = Format-CommandLine -Text $Process.CommandLine -Max $MaxCommandLength
    }
    $children = $ChildMap[$Process.Pid]
    if ($null -eq $children) { return }
    foreach ($child in @($children | Sort-Object -Property Created)) {
        Get-TreeRow -Process $child -Depth ($Depth + 1) -ChildMap $ChildMap
    }
}

function ConvertTo-ProcessRecord {
    param($Process)
    [ordered]@{
        Pid         = $Process.Pid
        ParentPid   = $Process.ParentPid
        Name        = $Process.Name
        Created     = Format-Iso $Process.Created
        StartKey    = Get-StartKey $Process.Created
        PrivMB      = $Process.PrivMB
        WsMB        = $Process.WsMB
        CommandLine = $Process.CommandLine
    }
}

function Write-Table {
    param([object[]]$Rows, [string[]]$Property)
    if (@($Rows).Count -eq 0) {
        Write-Output '  (none)'
        return
    }
    $tableArgs = @{ Property = $Property; AutoSize = $true }
    $text = $Rows | Format-Table @tableArgs | Out-String -Width 4096
    Write-Output $text.TrimEnd()
}

try {
    $now = Get-Date
    $byId = Get-ProcessSnapshot
    $childMap = Get-ChildMap -ById $byId
    $system = Get-SystemMemory
    $catalog = @{}
    if ($StatePath) {
        try {
            $catalog = Get-SessionCatalog -Path $StatePath
        }
        catch {
            Write-Warning "Could not read session names from $($StatePath): $($_.Exception.Message)"
        }
    }

    # ---- Conduit roots ---------------------------------------------------------------
    $conduitRoots = @{}
    if ($ConduitPid -gt 0) {
        if ($byId.ContainsKey($ConduitPid)) {
            $conduitRoots[$ConduitPid] = $byId[$ConduitPid]
        }
        else {
            Write-Warning "No running process has PID $($ConduitPid)."
        }
    }
    else {
        foreach ($proc in $byId.Values) {
            if ($proc.Name -notmatch $ConduitNamePattern) { continue }
            $parentIsConduit = (Test-LiveParent -Process $proc -ById $byId) -and ($byId[$proc.ParentPid].Name -match $ConduitNamePattern)
            if (-not $parentIsConduit) { $conduitRoots[$proc.Pid] = $proc }
        }
    }

    $underConduit = @{}
    foreach ($root in $conduitRoots.Values) {
        $underConduit[$root.Pid] = $true
        foreach ($proc in @(Get-Descendant -RootPid $root.Pid -ChildMap $childMap)) { $underConduit[$proc.Pid] = $true }
    }

    Write-Output ('== Conduit memory snapshot  {0}  {1}' -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $Label)
    Write-Output ('System: RAM {0} GB | available {1} GB | committed {2} GB of {3} GB limit | compressed store {4} MB' -f $system.TotalRamGB, $system.AvailableGB, $system.CommittedGB, $system.CommitLimitGB, $system.CompressedStoreMB)
    Write-Output ''

    # ---- Per Conduit root: children, totals by kind, tree ----------------------------
    $directChildInfo = @{}
    $childRecords = New-Object System.Collections.Generic.List[object]
    if ($conduitRoots.Count -eq 0) {
        Write-Output "== Conduit is not running (no process matches '$($ConduitNamePattern)')."
        Write-Output ''
    }
    foreach ($root in @($conduitRoots.Values | Sort-Object -Property Created)) {
        Write-Output ('== Conduit {0} PID {1}, started {2}, own memory: priv {3} MB, ws {4} MB' -f $root.Name, $root.Pid, (Format-Time $root.Created), $root.PrivMB, $root.WsMB)

        $rows = New-Object System.Collections.Generic.List[object]
        # Iterated without @(): Windows PowerShell 5.1 throws "Argument types do not match"
        # on @() around a List[object] of objects, so Lists are walked directly or
        # converted with ToArray() throughout this script.
        $rootChildren = $childMap[$root.Pid]
        if ($null -eq $rootChildren) { $rootChildren = New-Object System.Collections.Generic.List[object] }
        foreach ($child in $rootChildren) {
            $info = Get-ConduitChildKind -Process $child
            $directChildInfo[$child.Pid] = $info
            $members = @($child) + @(Get-Descendant -RootPid $child.Pid -ChildMap $childMap)
            $claudeMembers = @($members | Where-Object { $_.Name -ieq 'claude.exe' })
            $privTotal = Get-Total -Items $members -Property 'PrivMB'
            $claudePriv = Get-Total -Items $claudeMembers -Property 'PrivMB'
            $row = [pscustomobject]@{
                Kind         = $info.Kind
                SessionId    = $info.SessionId
                Name         = Get-SessionLabel -SessionId $info.SessionId -Catalog $catalog
                ChildPid     = $child.Pid
                Started      = Format-Time $child.Created
                AgeH         = Get-AgeHours -Value $child.Created -Now $now
                Procs        = $members.Count
                ClaudePrivMB = $claudePriv
                OtherPrivMB  = [math]::Round($privTotal - $claudePriv, 1)
                PrivMB       = $privTotal
                WsMB         = Get-Total -Items $members -Property 'WsMB'
                Breakdown    = Format-Breakdown -Items $members
            }
            $rows.Add($row)
            $childRecords.Add([ordered]@{
                    ConduitPid = $root.Pid
                    Kind       = $info.Kind
                    SessionId  = $info.SessionId
                    Name       = $row.Name
                    ChildPid   = $child.Pid
                    PrivMB     = $row.PrivMB
                    WsMB       = $row.WsMB
                    Breakdown  = $row.Breakdown
                    Processes  = @($members | ForEach-Object { ConvertTo-ProcessRecord -Process $_ })
                })
        }

        Write-Output ''
        Write-Output '-- Agent sessions and claude -p children (one row each, largest first)'
        $sessionLike = @($rows | Where-Object { $_.Kind -like 'agent-session*' -or $_.Kind -like 'claude -p*' } | Sort-Object -Property PrivMB -Descending)
        $sessionColumns = @('Kind', 'SessionId', 'ChildPid', 'Started', 'AgeH', 'Procs', 'ClaudePrivMB', 'OtherPrivMB', 'PrivMB', 'WsMB', 'Breakdown')
        if ($catalog.Count -gt 0) { $sessionColumns = @('Kind', 'Name') + $sessionColumns[1..($sessionColumns.Count - 1)] }
        Write-Table -Rows $sessionLike -Property $sessionColumns

        Write-Output ''
        Write-Output '-- Totals by kind (Conduit itself included)'
        $kindRows = New-Object System.Collections.Generic.List[object]
        $kindRows.Add([pscustomobject]@{ Kind = 'conduit (own process)'; Count = 1; Procs = 1; PrivMB = $root.PrivMB; WsMB = $root.WsMB })
        foreach ($group in @($rows | Group-Object -Property Kind | Sort-Object -Property Name)) {
            $kindRows.Add([pscustomobject]@{
                    Kind   = $group.Name
                    Count  = $group.Count
                    Procs  = [int](Get-Total -Items @($group.Group) -Property 'Procs')
                    PrivMB = Get-Total -Items @($group.Group) -Property 'PrivMB'
                    WsMB   = Get-Total -Items @($group.Group) -Property 'WsMB'
                })
        }
        $kindRows.Add([pscustomobject]@{
                Kind   = 'TOTAL'
                Count  = $rows.Count + 1
                Procs  = [int](Get-Total -Items $kindRows.ToArray() -Property 'Procs')
                PrivMB = Get-Total -Items $kindRows.ToArray() -Property 'PrivMB'
                WsMB   = Get-Total -Items $kindRows.ToArray() -Property 'WsMB'
            })
        Write-Table -Rows $kindRows.ToArray() -Property @('Kind', 'Count', 'Procs', 'PrivMB', 'WsMB')

        if (-not $NoTree) {
            Write-Output ''
            Write-Output '-- Process tree'
            Write-Table -Rows @(Get-TreeRow -Process $root -Depth 0 -ChildMap $childMap) -Property @('Process', 'Pid', 'PPid', 'PrivMB', 'WsMB', 'Started', 'CommandLine')
        }
        Write-Output ''
    }

    if ($catalog.Count -gt 0) {
        $liveIds = @{}
        foreach ($info in $directChildInfo.Values) {
            if ($info.SessionId -and $info.Kind -like 'agent-session*') { $liveIds[$info.SessionId] = $true }
        }
        $entries = @($catalog.Values)
        $stoppedCount = @($entries | Where-Object { $_.Stopped }).Count
        $liveKnown = @($catalog.Keys | Where-Object { $liveIds.ContainsKey($_) }).Count
        Write-Output ('== state.json: {0} sessions in {1} projects | running now {2} | marked stopped {3} | not running and not stopped {4}' -f $entries.Count, @($entries | Select-Object -ExpandProperty Project -Unique).Count, $liveKnown, $stoppedCount, ($entries.Count - $liveKnown - $stoppedCount))
        Write-Output '   Every session in the sidebar also holds a mounted terminal in the UI, running or not.'
        Write-Output ''
    }

    # ---- Every claude.exe on the machine ---------------------------------------------
    $claudeRows = New-Object System.Collections.Generic.List[object]
    $claudeRecords = New-Object System.Collections.Generic.List[object]
    foreach ($proc in @($byId.Values | Where-Object { $_.Name -ieq 'claude.exe' } | Sort-Object -Property Created)) {
        $descendants = @(Get-Descendant -RootPid $proc.Pid -ChildMap $childMap)
        $hostLabel = Get-HostLabel -Process $proc -ById $byId -ConduitRoots $conduitRoots -DirectChildInfo $directChildInfo
        $sessionName = ''
        if ($hostLabel -match '\s(\S+)$') { $sessionName = Get-SessionLabel -SessionId $Matches[1] -Catalog $catalog }
        $claudeRows.Add([pscustomobject]@{
                Host        = $hostLabel
                Name        = $sessionName
                Pid         = $proc.Pid
                Started     = Format-Time $proc.Created
                AgeH        = Get-AgeHours -Value $proc.Created -Now $now
                PrivMB      = $proc.PrivMB
                WsMB        = $proc.WsMB
                ChildProcs  = $descendants.Count
                ChildPrivMB = Get-Total -Items $descendants -Property 'PrivMB'
                Children    = Format-Breakdown -Items $descendants
                CommandLine = Format-CommandLine -Text $proc.CommandLine -Max $MaxCommandLength
            })
        $record = ConvertTo-ProcessRecord -Process $proc
        $record.Host = $hostLabel
        $record.Children = @($descendants | ForEach-Object { ConvertTo-ProcessRecord -Process $_ })
        $claudeRecords.Add($record)
    }
    Write-Output ('== claude.exe processes on this machine: {0}, private {1} MB, working set {2} MB' -f $claudeRows.Count, (Get-Total -Items $claudeRows.ToArray() -Property 'PrivMB'), (Get-Total -Items $claudeRows.ToArray() -Property 'WsMB'))
    $claudeColumns = @('Host', 'Pid', 'Started', 'AgeH', 'PrivMB', 'WsMB', 'ChildProcs', 'ChildPrivMB', 'Children', 'CommandLine')
    if ($catalog.Count -gt 0) { $claudeColumns = @('Host', 'Name') + $claudeColumns[1..($claudeColumns.Count - 1)] }
    Write-Table -Rows $claudeRows.ToArray() -Property $claudeColumns
    Write-Output ''
    Write-Output '-- claude.exe grouped by host'
    $hostRows = @($claudeRows | Group-Object -Property { ($_.Host -replace '\s[0-9a-fA-F-]{36}$', '') -replace '\s\d+$', '' } | ForEach-Object {
            [pscustomobject]@{
                Host        = $_.Name
                Count       = $_.Count
                PrivMB      = Get-Total -Items @($_.Group) -Property 'PrivMB'
                ChildPrivMB = Get-Total -Items @($_.Group) -Property 'ChildPrivMB'
            }
        } | Sort-Object -Property PrivMB -Descending)
    Write-Table -Rows $hostRows -Property @('Host', 'Count', 'PrivMB', 'ChildPrivMB')
    Write-Output ''

    # ---- Orphans ---------------------------------------------------------------------
    $orphanRows = New-Object System.Collections.Generic.List[object]
    $orphanRecords = New-Object System.Collections.Generic.List[object]
    $orphans = @($byId.Values | Where-Object { $_.Name -match $WatchNamePattern -and -not (Test-LiveParent -Process $_ -ById $byId) } | Sort-Object -Property Created)
    foreach ($proc in $orphans) {
        $subtree = @(Get-Descendant -RootPid $proc.Pid -ChildMap $childMap)
        $orphanRows.Add([pscustomobject]@{
                Name          = $proc.Name
                Pid           = $proc.Pid
                GoneParent    = $proc.ParentPid
                Started       = Format-Time $proc.Created
                AgeH          = Get-AgeHours -Value $proc.Created -Now $now
                PrivMB        = $proc.PrivMB
                WsMB          = $proc.WsMB
                SubtreeProcs  = $subtree.Count
                SubtreePrivMB = Get-Total -Items $subtree -Property 'PrivMB'
                CommandLine   = Format-CommandLine -Text $proc.CommandLine -Max $MaxCommandLength
            })
        $record = ConvertTo-ProcessRecord -Process $proc
        $record.Subtree = @($subtree | ForEach-Object { ConvertTo-ProcessRecord -Process $_ })
        $orphanRecords.Add($record)
    }
    $orphanPriv = (Get-Total -Items $orphanRows.ToArray() -Property 'PrivMB') + (Get-Total -Items $orphanRows.ToArray() -Property 'SubtreePrivMB')
    Write-Output ('== Orphans (watched name, parent no longer running): {0}, private incl. subtrees {1} MB' -f $orphanRows.Count, $orphanPriv)
    Write-Table -Rows $orphanRows.ToArray() -Property @('Name', 'Pid', 'GoneParent', 'Started', 'AgeH', 'PrivMB', 'WsMB', 'SubtreeProcs', 'SubtreePrivMB', 'CommandLine')
    Write-Output ''

    # ---- Machine-wide totals per name ------------------------------------------------
    $nameRows = @($byId.Values | Where-Object { $_.Name -match $WatchNamePattern -or $_.Name -match $totalsExtraPattern -or $_.Name -match $ConduitNamePattern } | Group-Object -Property { $_.Name.ToLowerInvariant() } | ForEach-Object {
            $group = @($_.Group)
            [pscustomobject]@{
                Name         = $_.Name
                Count        = $group.Count
                UnderConduit = @($group | Where-Object { $underConduit.ContainsKey($_.Pid) }).Count
                NoLiveParent = @($group | Where-Object { -not (Test-LiveParent -Process $_ -ById $byId) }).Count
                PrivMB       = Get-Total -Items $group -Property 'PrivMB'
                WsMB         = Get-Total -Items $group -Property 'WsMB'
            }
        } | Sort-Object -Property PrivMB -Descending)
    Write-Output '== Machine-wide totals per process name'
    Write-Table -Rows $nameRows -Property @('Name', 'Count', 'UnderConduit', 'NoLiveParent', 'PrivMB', 'WsMB')
    Write-Output ''

    # ---- Survivors from a baseline snapshot ------------------------------------------
    if ($BaselinePath) {
        $baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
        $entries = New-Object System.Collections.Generic.List[object]
        foreach ($child in @($baseline.ConduitChildren)) {
            if ($null -eq $child) { continue }
            foreach ($p in @($child.Processes)) { $entries.Add(@{ Group = ('{0} {1}' -f $child.Kind, $child.SessionId).Trim(); Entry = $p }) }
        }
        foreach ($c in @($baseline.Claude)) {
            if ($null -eq $c) { continue }
            $entries.Add(@{ Group = 'claude.exe list'; Entry = $c })
            foreach ($p in @($c.Children)) { $entries.Add(@{ Group = 'claude.exe list'; Entry = $p }) }
        }
        foreach ($o in @($baseline.Orphans)) {
            if ($null -eq $o) { continue }
            $entries.Add(@{ Group = 'orphans'; Entry = $o })
            foreach ($p in @($o.Subtree)) { $entries.Add(@{ Group = 'orphans'; Entry = $p }) }
        }
        $seen = @{}
        $survivors = New-Object System.Collections.Generic.List[object]
        foreach ($item in $entries) {
            if ($null -eq $item.Entry) { continue }
            $key = '{0}|{1}' -f $item.Entry.Pid, $item.Entry.StartKey
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $current = $byId[[int]$item.Entry.Pid]
            if ($null -eq $current) { continue }
            if ((Get-StartKey $current.Created) -ne [string]$item.Entry.StartKey) { continue }
            $survivors.Add([pscustomobject]@{
                    BaselineGroup = $item.Group
                    Name          = $current.Name
                    Pid           = $current.Pid
                    Started       = Format-Time $current.Created
                    PrivMB        = $current.PrivMB
                    UnderConduit  = $underConduit.ContainsKey($current.Pid)
                    LiveParent    = Test-LiveParent -Process $current -ById $byId
                    CommandLine   = Format-CommandLine -Text $current.CommandLine -Max $MaxCommandLength
                })
        }
        Write-Output ('== Still running from baseline {0} ({1}): {2} of {3} processes, private {4} MB' -f $BaselinePath, $baseline.Label, $survivors.Count, $seen.Count, (Get-Total -Items $survivors.ToArray() -Property 'PrivMB'))
        $survivorGroups = @($survivors | Group-Object -Property BaselineGroup | ForEach-Object {
                [pscustomobject]@{
                    BaselineGroup = $_.Name
                    Survivors     = $_.Count
                    PrivMB        = Get-Total -Items @($_.Group) -Property 'PrivMB'
                    Orphaned      = @($_.Group | Where-Object { -not $_.LiveParent }).Count
                }
            } | Sort-Object -Property PrivMB -Descending)
        Write-Table -Rows $survivorGroups -Property @('BaselineGroup', 'Survivors', 'Orphaned', 'PrivMB')
        Write-Output ''
        Write-Table -Rows @($survivors | Sort-Object -Property BaselineGroup, Started) -Property @('BaselineGroup', 'Name', 'Pid', 'Started', 'PrivMB', 'UnderConduit', 'LiveParent', 'CommandLine')
        Write-Output ''
    }

    if ($JsonPath) {
        $document = [ordered]@{
            Label           = $Label
            TakenAt         = $now.ToString('o')
            System          = $system
            ConduitRoots    = @($conduitRoots.Values | ForEach-Object { ConvertTo-ProcessRecord -Process $_ })
            ConduitChildren = $childRecords.ToArray()
            Claude          = $claudeRecords.ToArray()
            Orphans         = $orphanRecords.ToArray()
            NameTotals      = $nameRows
        }
        $document | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $JsonPath -Encoding UTF8
        Write-Output "Snapshot saved to $($JsonPath)"
    }
}
catch {
    Write-Error "measure-sessions failed: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
    exit 1
}
