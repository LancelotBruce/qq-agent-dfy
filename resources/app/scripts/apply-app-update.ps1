# Runs outside the installation. No network, package commands, registry writes,
# or third-party updater code. Windows PowerShell 5.1 / .NET only.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Validate','Stage','Launch','Apply','Recover')][string]$Action,
      [Parameter(Mandatory=$true)][string]$Job)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
function Absolute([string]$Value) {
    if([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value) -or $Value -match '[\x00-\x1f"<>|?*]' -or $Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\')){throw 'Invalid update path'}
    $full=[IO.Path]::GetFullPath($Value).TrimEnd('\','/')
    if($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')){throw 'A disk root cannot be updated'}
    return $full
}
function Within([string]$Child,[string]$Root){return $Child.Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)}
function No-Link([string]$Value) {
    $current=Absolute $Value
    while($current){
        if((Test-Path -LiteralPath $current) -and (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "Filesystem links are not allowed: $current"}
        $next=[IO.Path]::GetDirectoryName($current);if($next -eq $current){break};$current=$next
    }
}
function Relative([string]$Value) {
    $value=$Value.Replace('\','/')
    if(-not $value -or $value.StartsWith('/') -or $value -match '[\x00-\x1f:<>"|?*]' -or $value -match '(^|/)\.\.?(/|$)'){throw 'Invalid archive path'}
    foreach($part in $value.Split('/')){if(-not $part -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'){throw 'Invalid Windows archive filename'}}
    return $value
}
function Child([string]$Root,[string]$Rel){$full=Absolute ([IO.Path]::Combine($Root,(Relative $Rel)));if($full -eq $Root -or -not (Within $full $Root)){throw 'Update path escaped its root'};return $full}
function Hash([string]$File){
    No-Link $File;$stream=[IO.File]::OpenRead($File);$algorithm=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
    finally{$algorithm.Dispose();$stream.Dispose()}
}
function Atomic([string]$File,$Value){
    No-Link $File;$tmp=$File+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Depth 20 -Compress),$utf8)
    if([IO.File]::Exists($File)){[IO.File]::Replace($tmp,$File,[NullString]::Value)}else{[IO.File]::Move($tmp,$File)}
}
$jobFile=Absolute $Job;No-Link $jobFile
if([IO.Path]::GetFileName($jobFile) -ne 'job.json'){throw 'Invalid job filename'}
$jobRoot=Absolute ([IO.Path]::GetDirectoryName($jobFile));$j=Get-Content -LiteralPath $jobFile -Raw -Encoding UTF8|ConvertFrom-Json
[IO.File]::AppendAllText((Join-Path $jobRoot 'helper.log'),([DateTime]::UtcNow.ToString('o')+' action='+$Action+"`r`n"),$utf8)
if($j.schema -ne 1 -or $j.id -notmatch '^[a-f0-9-]{36}$' -or $j.nonce -notmatch '^[a-f0-9]{64}$' -or $j.kind -notin @('source','desktop')){throw 'Invalid job identity'}
$install=Absolute $j.installRoot;$appRoot=Absolute $j.appRoot;No-Link $install;No-Link $appRoot
if((Within $jobRoot $install) -or (Within $install $jobRoot)){throw 'Updater must run outside installation'}
if(($j.kind -eq 'source' -and $appRoot -ne $install) -or ($j.kind -eq 'desktop' -and $appRoot -ne (Child $install 'resources/app'))){throw 'Application layout mismatch'}
if((Test-Path -LiteralPath (Join-Path $install '.git')) -or (Test-Path -LiteralPath (Join-Path $appRoot '.git'))){throw 'Refusing to update a Git development checkout'}
$units=@($j.units|ForEach-Object {Relative $_})
foreach($unit in $units){if($unit -match '(^|/)(?i:data(?:-\d+)?|protocols|runtime|plugins|skills|overrides|\.git)(/|$)'){throw 'User data cannot be a program unit'}}
$payload=Child $jobRoot 'payload';$backup=Child $jobRoot 'backup';$stateFile=Child $jobRoot 'state.json';$receiptFile=Child $jobRoot 'backup.json';$indexFile=Child $jobRoot 'stage.json'
function State([string]$Phase,[string]$ErrorText='',[string]$InstalledVersion=''){
    $value=@{id=$j.id;phase=$Phase;oldVersion=$j.oldVersion;version=$j.version;total=$j.asset.size;received=$j.asset.size;error=$ErrorText;installedVersion=$InstalledVersion}
    Atomic $stateFile $value
}
function Policy([string]$Rel){
    $r=$Rel.Replace('\','/')
    foreach($unit in $units){if($r.Equals($unit,[StringComparison]::OrdinalIgnoreCase) -or $r.StartsWith($unit+'/',[StringComparison]::OrdinalIgnoreCase)){return 'Program'}}
    foreach($unit in $units){if($unit.StartsWith($r+'/',[StringComparison]::OrdinalIgnoreCase)){return 'Container'}}
    return 'Retain'
}
function Scan([string]$Root,[string]$Prefix='',[bool]$SkipRuntimeCache=$false){
    No-Link $Root
    $result=New-Object 'System.Collections.Generic.List[object]'
    if(-not (Test-Path -LiteralPath $Root)){return @()}
    function Visit([string]$File,[string]$Rel){
        if($SkipRuntimeCache -and [IO.Path]::GetFileName($File) -eq 'data-plugin-runtime'){return}
        No-Link $File;$item=Get-Item -LiteralPath $File -Force
        [void]$result.Add([pscustomobject]@{relative=$Rel;directory=[bool]$item.PSIsContainer;length=if($item.PSIsContainer){0}else{$item.Length};sha256=if($item.PSIsContainer){''}else{Hash $File}})
        if($item.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $File -Force)){Visit $child.FullName ($Rel+'/'+$child.Name)}}
    }
    foreach($item in @(Get-ChildItem -LiteralPath $Root -Force)){Visit $item.FullName ($Prefix+$item.Name)}
    return $result.ToArray()
}
function Remove-Safe([string]$Target,[string]$Root){
    $target=Absolute $Target;$root=Absolute $Root
    if($target -eq $root -or -not (Within $target $root)){throw 'Refusing recursive removal outside expected root'}
    No-Link $target
    if(-not (Test-Path -LiteralPath $target)){return}
    $item=Get-Item -LiteralPath $target -Force
    if($item.PSIsContainer){$null=Scan $target;Remove-Item -LiteralPath $target -Recurse -Force}else{Remove-Item -LiteralPath $target -Force}
}
function Copy-Tree([string]$From,[string]$To,$Entries){
    No-Link $To;[void][IO.Directory]::CreateDirectory($To)
    foreach($entry in @($Entries|Sort-Object {$_.relative.Length})){
        $source=Child $From $entry.relative;$target=Child $To $entry.relative;No-Link $source;No-Link $target
        if($entry.directory){[void][IO.Directory]::CreateDirectory($target);continue}
        if((Hash $source) -ne $entry.sha256){throw 'Source changed while copying the update or recovery data'}
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        if([IO.File]::Exists($target) -and (Hash $target) -eq $entry.sha256){continue}
        [IO.File]::Copy($source,$target,$true)
        if((Hash $target) -ne $entry.sha256){throw 'Copied file failed verification'}
    }
}
function Selections([string]$Root){
    $result=New-Object 'System.Collections.Generic.List[string]'
    function Visit-Container([string]$Directory,[string]$Prefix){
        No-Link $Directory
        foreach($item in @(Get-ChildItem -LiteralPath $Directory -Force)){
            if($item.Name -eq 'data-plugin-runtime'){continue}
            $rel=if($Prefix){$Prefix+'/'+$item.Name}else{$item.Name};$policy=Policy $rel
            if($policy -eq 'Container') {if($item.PSIsContainer){Visit-Container $item.FullName $rel}else{throw 'Program container is not a directory'}}
            elseif($policy -eq 'Retain'){[void]$result.Add($rel)}
        }
    }
    Visit-Container $Root '';return $result.ToArray()
}
function Region-Entries([string]$Root,$Paths){
    $all=New-Object 'System.Collections.Generic.List[object]'
    foreach($rel in @($Paths)){
        $file=Child $Root $rel;No-Link $file
        if(-not (Test-Path -LiteralPath $file)){continue};$item=Get-Item -LiteralPath $file -Force
        [void]$all.Add([pscustomobject]@{relative=$rel;directory=[bool]$item.PSIsContainer;length=if($item.PSIsContainer){0}else{$item.Length};sha256=if($item.PSIsContainer){''}else{Hash $file}})
        if($item.PSIsContainer){foreach($entry in @(Scan $file ($rel+'/') ((Policy $rel) -eq 'Retain'))){[void]$all.Add($entry)}}
    }
    return $all.ToArray()
}
function Verify-Tree([string]$Root,$Entries){foreach($entry in @($Entries)){ $file=Child $Root $entry.relative;No-Link $file;if($entry.directory){if(-not [IO.Directory]::Exists($file)){throw 'Recovery directory missing'}}elseif(-not [IO.File]::Exists($file) -or (Hash $file) -ne $entry.sha256){throw 'Recovery file hash mismatch'}}}
function Check-Running([bool]$IgnoreParent) {
    $needle=if($j.kind -eq 'desktop'){[string]$j.restart.exe}else{[string]$j.restart.args[0]}
    foreach($process in @(Get-CimInstance Win32_Process)){
        if($IgnoreParent -and $process.ProcessId -eq $j.parentPid){continue}
        if(([string]$process.ExecutablePath).Equals([string]$j.restart.exe,[StringComparison]::OrdinalIgnoreCase) -and
            ([string]$process.CommandLine).IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            ($j.kind -eq 'source' -or ([string]$process.CommandLine) -notmatch '--type=')){throw 'Close other QQA instances using this installation before updating'}
    }
}
function Stage {
    State 'staging'
    $current=Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($current.name -ne 'qq-agent' -or $current.version -ne $j.oldVersion){throw 'The installed version changed while downloading'}
    if($Action -eq 'Stage'){Check-Running $true}
    $zip=Child $jobRoot 'package.zip'
    if((Get-Item -LiteralPath $zip).Length -ne $j.asset.size -or (Hash $zip) -ne $j.asset.sha256){throw 'Downloaded ZIP failed verification'}
    if(Test-Path -LiteralPath $payload){Remove-Safe $payload $jobRoot};[void][IO.Directory]::CreateDirectory($payload)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $archive=[IO.Compression.ZipFile]::OpenRead($zip);$seen=@{};$files=New-Object 'System.Collections.Generic.List[object]';[long]$expanded=0
    try{
        if($archive.Entries.Count -gt 60000){throw 'Too many files in update ZIP'}
        foreach($entry in $archive.Entries){
            $rel=Relative ($entry.FullName.TrimEnd('/'));$directory=$entry.FullName.EndsWith('/');$key=$rel.ToLowerInvariant()
            if($seen.ContainsKey($key)){throw 'Duplicate Windows archive path'};$seen[$key]=$true
            $kind=([long]$entry.ExternalAttributes -shr 16) -band 61440
            if($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384){throw 'Archive links and special files are not allowed'}
            if((Policy $rel) -ne 'Program' -and -not ($directory -and (Policy $rel) -eq 'Container') -and $rel -ne 'qq-agent-update.json'){throw "Update ZIP attempts to replace a non-program path: $rel"}
            $expanded+=$entry.Length
            if($entry.Length -gt 536870912 -or $expanded -gt $j.asset.unpackedSize -or $expanded -gt 3221225472){throw 'Expanded ZIP exceeds its declared size'}
            $target=Child $payload $rel;No-Link $target
            if($directory){[void][IO.Directory]::CreateDirectory($target);continue}
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $input=$entry.Open();$output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{[long]$written=0;$buffer=New-Object byte[] 131072;while(($n=$input.Read($buffer,0,$buffer.Length)) -gt 0){$written+=$n;if($written -gt $entry.Length){throw 'ZIP entry expands beyond its header'};$output.Write($buffer,0,$n)};if($written -ne $entry.Length){throw 'Incomplete ZIP entry'}}finally{$output.Dispose();$input.Dispose()}
        }
    }finally{$archive.Dispose()}
    if($expanded -ne $j.asset.unpackedSize){throw 'Expanded ZIP size does not match signed manifest'}
    $meta=Get-Content -LiteralPath (Child $payload 'qq-agent-update.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($meta.schema -ne 1 -or $meta.appId -ne 'cn.kondius.qq-agent' -or $meta.version -ne $j.version -or $meta.kind -ne $j.kind){throw 'Update package identity does not match manifest'}
    $packageRel=if($j.kind -eq 'desktop'){'resources/app/package.json'}else{'package.json'}
    $pkg=Get-Content -LiteralPath (Child $payload $packageRel) -Raw -Encoding UTF8|ConvertFrom-Json
    if($pkg.name -ne 'qq-agent' -or $pkg.version -ne $j.version){throw 'Actual application version does not match update'}
    foreach($required in @('src/server.js','electron/main.js','ui/shell/index.html','scripts/apply-app-update.ps1')){
        $rel=if($j.kind -eq 'desktop'){'resources/app/'+$required}else{$required};if(-not [IO.File]::Exists((Child $payload $rel))){throw "Incomplete application package: $required"}
    }
    if($j.kind -eq 'desktop' -and -not [IO.File]::Exists((Child $payload 'QQ Agent.exe'))){throw 'Desktop executable is missing'}
    $entries=@(Scan $payload);Atomic $indexFile @{entries=$entries;sha256=$j.asset.sha256}
    $parent=Get-Process -Id $j.parentPid -ErrorAction Stop
    $j|Add-Member -NotePropertyName parentStartedAt -NotePropertyValue $parent.StartTime.ToUniversalTime().Ticks.ToString() -Force
    Atomic $jobFile $j
    State 'ready'
}
function Quote-Argument([string]$Value){
    if($Value -notmatch '[\s"]' -and $Value.Length -gt 0){return $Value}
    $value=[regex]::Replace($Value,'(\\*)"','$1$1\"');$value=[regex]::Replace($value,'(\\+)$','$1$1')
    return '"'+$value+'"'
}
function Start-App([string]$Mode){
    $j.bootMode=$Mode;Atomic $jobFile $j
    $health=Child $jobRoot 'health.json';if(Test-Path -LiteralPath $health){Remove-Item -LiteralPath $health -Force}
    $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=Absolute $j.restart.exe;$info.WorkingDirectory=$install
    $info.UseShellExecute=$false;$info.CreateNoWindow=($j.kind -eq 'source');$info.Arguments=(@($j.restart.args|ForEach-Object {Quote-Argument ([string]$_)}) -join ' ')
    foreach($property in $j.env.PSObject.Properties){$info.EnvironmentVariables[$property.Name]=[string]$property.Value}
    $info.EnvironmentVariables['QQ_AGENT_UPDATE_JOB']=$jobFile
    return [Diagnostics.Process]::Start($info)
}
function Wait-Health($Process,[string]$Mode){
    $healthySince=$null;$until=[DateTime]::UtcNow.AddMilliseconds($j.healthTimeoutMs);$expected=if($Mode -eq 'rollback'){$j.oldVersion}else{$j.version}
    do{
        $Process.Refresh();if($Process.HasExited){throw 'Application exited before startup was confirmed'}
        $file=Child $jobRoot 'health.json'
        if(Test-Path -LiteralPath $file){
            try{$health=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
                if($health.nonce -eq $j.nonce -and $health.version -eq $expected -and $health.pid -eq $Process.Id -and $health.mode -eq $Mode){if($null -eq $healthySince){$healthySince=[DateTime]::UtcNow};if(([DateTime]::UtcNow-$healthySince).TotalMilliseconds -ge 1000){return}}
            }catch{}
        }
        Start-Sleep -Milliseconds 100
    }while([DateTime]::UtcNow -lt $until)
    throw 'Application startup confirmation timed out'
}
function Stop-NewTree($Process){
    if(-not $Process){return};$Process.Refresh();if($Process.HasExited){return}
    $children=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId)
    function Stop-Children([int]$Parent){foreach($child in $children){if($child.ParentProcessId -eq $Parent){Stop-Children $child.ProcessId;Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue}}}
    Stop-Children $Process.Id
    $Process.Refresh();if(-not $Process.HasExited){$Process.Kill();$null=$Process.WaitForExit(10000)}
}
function Backup-All {
    State 'backingUp'
    $retained=@(Selections $install);$program=@(Region-Entries $install $units);$user=@(Region-Entries $install $retained)
    $externals=New-Object 'System.Collections.Generic.List[object]';[long]$needed=16777216
    foreach($entry in @($program)+@($user)){$needed+=$entry.length}
    $i=0
    foreach($rootValue in @($j.externalRoots)){
        $root=Absolute $rootValue;No-Link $root
        if((Within $root $install) -or (Within $install $root) -or (Within $jobRoot $root) -or (Within $root $jobRoot)){throw 'External data overlaps installation or update directory'}
        $exists=[IO.Directory]::Exists($root);$entries=if($exists){@(Scan $root '' $true)}else{@()}
        foreach($entry in $entries){$needed+=$entry.length}
        [void]$externals.Add([pscustomobject]@{root=$root;slot='external/'+$i;exists=$exists;entries=@($entries)});$i++
    }
    foreach($entry in @((Get-Content -LiteralPath $indexFile -Raw -Encoding UTF8|ConvertFrom-Json).entries)){$needed+=$entry.length}
    $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($backup));if($drive.AvailableFreeSpace -lt $needed){throw 'Not enough free disk space for verified update and recovery copies'}
    [void][IO.Directory]::CreateDirectory($backup)
    Copy-Tree $install (Child $backup 'program') $program;Copy-Tree $install (Child $backup 'user') $user
    foreach($region in $externals){if($region.exists){Copy-Tree $region.root (Child $backup $region.slot) $region.entries}}
    $receipt=@{program=@($program);user=@($user);retained=@($retained);external=@($externals.ToArray())}
    Atomic $receiptFile $receipt
    return $receipt
}
function Restore-Region([string]$Root,[string]$Source,$Entries,[bool]$SkipRuntimeCache=$true){
    No-Link $Root;[void][IO.Directory]::CreateDirectory($Root)
    $expected=@{};foreach($entry in @($Entries)){$expected[$entry.relative.ToLowerInvariant()]=$entry}
    foreach($entry in @((Scan $Root '' $SkipRuntimeCache)|Sort-Object {$_.relative.Length} -Descending)){
        if(-not $expected.ContainsKey($entry.relative.ToLowerInvariant())){Remove-Safe (Child $Root $entry.relative) $Root}
    }
    Copy-Tree $Source $Root $Entries
}
function Restore-All {
    $receipt=Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8|ConvertFrom-Json
    Verify-Tree (Child $backup 'program') $receipt.program;Verify-Tree (Child $backup 'user') $receipt.user
    foreach($region in @($receipt.external)){if($region.exists){Verify-Tree (Child $backup $region.slot) $region.entries}}
    foreach($unit in $units){
        $target=Child $install $unit;$entries=@($receipt.program|Where-Object {$_.relative -eq $unit -or $_.relative.StartsWith($unit+'/',[StringComparison]::OrdinalIgnoreCase)})
        if(-not $entries.Count){if(Test-Path -LiteralPath $target){Remove-Safe $target $install};continue}
        $top=@($entries|Where-Object {$_.relative -eq $unit})[0]
        if($top.directory){
            if([IO.File]::Exists($target)){Remove-Safe $target $install}
            $children=@($entries|Where-Object {$_.relative -ne $unit}|ForEach-Object {[pscustomobject]@{relative=$_.relative.Substring($unit.Length+1);directory=$_.directory;length=$_.length;sha256=$_.sha256}})
            Restore-Region $target (Child (Child $backup 'program') $unit) $children $false
        }else{if([IO.Directory]::Exists($target)){Remove-Safe $target $install};Copy-Tree (Child $backup 'program') $install @($top)}
    }
    $keep=@{};foreach($rel in @($receipt.retained)){$keep[$rel.ToLowerInvariant()]=$true}
    foreach($rel in @(Selections $install)){if(-not $keep.ContainsKey($rel.ToLowerInvariant())){Remove-Safe (Child $install $rel) $install}}
    foreach($rel in @($receipt.retained)){
        $target=Child $install $rel;$entries=@($receipt.user|Where-Object {$_.relative -eq $rel -or $_.relative.StartsWith($rel+'/',[StringComparison]::OrdinalIgnoreCase)})
        $top=@($entries|Where-Object {$_.relative -eq $rel})[0]
        if($top.directory){
            if([IO.File]::Exists($target)){Remove-Safe $target $install}
            $children=@($entries|Where-Object {$_.relative -ne $rel}|ForEach-Object {[pscustomobject]@{relative=$_.relative.Substring($rel.Length+1);directory=$_.directory;length=$_.length;sha256=$_.sha256}})
            Restore-Region $target (Child (Child $backup 'user') $rel) $children
        }else{Copy-Tree (Child $backup 'user') $install @($top)}
    }
    foreach($region in @($receipt.external)){
        if($region.exists){Restore-Region $region.root (Child $backup $region.slot) $region.entries}
        elseif(Test-Path -LiteralPath $region.root){Remove-Safe $region.root ([IO.Path]::GetDirectoryName($region.root))}
    }
}
function Unlock {
    $file=Join-Path ([IO.Path]::GetDirectoryName($jobRoot)) 'update.lock'
    if(Test-Path -LiteralPath $file){try{$held=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json;if($held.id -eq $j.id){Remove-Item -LiteralPath $file -Force}}catch{}}
}
$started=$null;$changed=$false;$backedUp=$false
try{
    if($Action -in @('Validate','Stage')){Stage;exit 0}
    if($Action -eq 'Launch'){
        $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Action','Apply','-Job',$jobFile)
        $argumentLine=(@($arguments|ForEach-Object {Quote-Argument ([string]$_)}) -join ' ')
        $helper=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argumentLine -WorkingDirectory $jobRoot -WindowStyle Hidden -RedirectStandardOutput (Child $jobRoot 'install.stdout.log') -RedirectStandardError (Child $jobRoot 'install.log') -PassThru
        Atomic (Child $jobRoot 'launch.json') @{pid=$helper.Id;nonce=$j.nonce}
        exit 0
    }
    if($Action -eq 'Recover'){
        # Manual power-loss recovery must not overwrite a live installation.
        # Do this outside the rollback catch, which must not spawn another app
        # after a deliberate refusal to touch an already-running instance.
        try{Check-Running $false;if(-not [IO.File]::Exists($receiptFile)){throw 'No verified backup is available'}}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 4}
    }else{
        $index=Get-Content -LiteralPath $indexFile -Raw -Encoding UTF8|ConvertFrom-Json;Verify-Tree $payload $index.entries
        [IO.File]::AppendAllText((Join-Path $jobRoot 'helper.log'),"payload verified`r`n",$utf8)
    }
    if($Action -eq 'Apply'){
        [IO.File]::WriteAllText((Child $jobRoot 'helper.ready'),$j.nonce,$utf8)
        $until=[DateTime]::UtcNow.AddMilliseconds($j.shutdownTimeoutMs);$parentAlive=$true
        do{
            if(Test-Path -LiteralPath (Child $jobRoot 'cancel')){State 'cancelled';Unlock;exit 0}
            $parent=Get-Process -Id $j.parentPid -ErrorAction SilentlyContinue
            $parentAlive=$null -ne $parent -and $parent.StartTime.ToUniversalTime().Ticks.ToString() -eq $j.parentStartedAt
            $go=Child $jobRoot 'shutdown.ok'
            if(-not $parentAlive){
                if([IO.File]::Exists($go) -and [IO.File]::ReadAllText($go) -eq $j.nonce){break}
                throw 'The old application exited without confirming saved data; relaunching the unchanged version'
            }
            if([DateTime]::UtcNow -ge $until){throw 'The old application did not finish a confirmed shutdown'}
            Start-Sleep -Milliseconds 100
        }while($true)
        $null=Backup-All;$backedUp=$true;State 'installing';$changed=$true
        foreach($unit in $units){$target=Child $install $unit;if(Test-Path -LiteralPath $target){Remove-Safe $target $install}}
        $program=@($index.entries|Where-Object {(Policy $_.relative) -eq 'Program'})
        Copy-Tree $payload $install $program
        Verify-Tree $install $program
        State 'restarting';$started=Start-App 'upgrade';Wait-Health $started 'upgrade';State 'complete' '' $j.version
    }else{
        State 'rollingBack';Restore-All;$started=Start-App 'rollback';Wait-Health $started 'rollback';State 'rolledBack' '已恢复旧版' $j.oldVersion
    }
    Unlock;exit 0
}catch{
    $message=$_.Exception.Message
    if($Action -in @('Validate','Stage')){State 'error' $message;exit 1}
    try{
        Stop-NewTree $started
        if($changed -and $backedUp){State 'rollingBack' $message;Restore-All}
        $parent=Get-Process -Id $j.parentPid -ErrorAction SilentlyContinue
        if($null -eq $parent -or $parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $j.parentStartedAt){
            $started=Start-App 'rollback';Wait-Health $started 'rollback';State 'rolledBack' $message $j.oldVersion
        }else{State 'error' $message}
        Unlock;exit 2
    }catch{State 'rollbackFailed' ($message+'; 恢复失败: '+$_.Exception.Message+'; 恢复副本: '+$backup);Unlock;exit 3}
}
