<#
  Installs dsh-android-phone into a DSH profile.

  Why not `dsh plugin add`: the official CLI refuses the `desktop` profile outright
  ("managed exclusively by the Electron application"). This script does the same
  three things the plugin market does — put the package where the loader can
  resolve it, list it in dsh.profile.bundles, and declare the dependency — and
  nothing else.

  Default behaviour is a **junction link** back to this source tree, so editing
  index.js / client.js / src/ here and reloading picks the change up. Use -Copy for
  a self-contained copy under <profile>\vendor\dsh-android-phone.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIfOnly
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Copy
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [string]$ProfileDir,
  [string]$Source,
  [string]$AdbPath,
  [switch]$Copy,
  [switch]$Uninstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-android-phone'

if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
$Source = (Resolve-Path $Source).Path

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not $Profile) { $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' } }
if (-not $ProfileDir) { $ProfileDir = Join-Path $dshHome "profiles\$Profile" }

$profileJson = Join-Path $ProfileDir 'package.json'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$linkPath = Join-Path $ProfileDir "node_modules\$pluginName"
$vendorPath = Join-Path $ProfileDir "vendor\$pluginName"

Write-Host "dsh home : $dshHome"
Write-Host "profile  : $Profile"
Write-Host "source   : $Source"
Write-Host "mode     : $(if ($Copy) { 'copy (self-contained)' } else { 'link (edit-and-reload)' })"

# ------------------------------------------------------------------ preflight
if (-not (Test-Path $dshHome)) { throw "DSH home not found: $dshHome (is DSH installed, and has it run once?)" }
if (-not (Test-Path $ProfileDir)) { throw "profile directory not found: $ProfileDir`nBoot that profile once, then re-run this script." }
if (-not (Test-Path $profileJson)) { throw "no package.json in $ProfileDir" }

if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "not a plugin folder (no package.json): $Source" }
if (-not (Test-Path (Join-Path $Source 'index.js'))) { throw "not a plugin folder (no index.js): $Source" }
if (-not (Test-Path (Join-Path $Source 'client.js'))) { throw "not a plugin folder (no client.js): $Source" }
if (-not (Test-Path (Join-Path $Source 'src\android\adb.js'))) { throw "missing src\android\adb.js in $Source" }

# adb 优先级：config 的 adbPath > 插件自带 vendor\platform-tools\adb.exe > QtScrcpy 目录 > Android SDK。
# 本包已自带 adb（vendor\），所以正常情况下这里不会告警。
$adbHint = $AdbPath
$adbBundled = Join-Path $Source 'vendor\platform-tools\adb.exe'
if (-not $adbHint) {
  $cands = @(
    $adbBundled,
    (Join-Path $env:USERPROFILE 'Desktop\QtScrcpy-win-x64-v4.2.1\QtScrcpy-win-x64-v4.2.1\adb.exe'),
    (Join-Path $env:USERPROFILE 'Desktop\QtScrcpy-win-x64-v4.2.1\adb.exe'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
  )
  $adbHint = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($adbHint -and $adbHint -eq $adbBundled -and (Test-Path $adbBundled)) { Write-Host "adb      : $adbHint (插件自带)" }
elseif ($adbHint) { Write-Host "adb      : $adbHint" }
else { Write-Warning "没有找到 adb.exe；插件自带 vendor\platform-tools\adb.exe 缺失，请重新下载完整包" }

$existing = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
if ($existing -and -not $existing.LinkType) {
  throw "$linkPath exists and is not a link; remove it by hand first."
}

# ------------------------------------------------ skill 根接线（技能随插件走）
# 技能本体在 <插件目录>\skills\<name>\SKILL.md。DSH 只认 profile 的 cordis.patch.yml 里
# `skill-filesystem` 行的 customSkillDirs 白名单，所以这里把 "<插件目录>\skills" 并进去。
# **必须在已有条目里加一项**，不能新加一条 `- id: skill-filesystem` —— 同 id 多条目时
# 后者会覆盖前者，会把别的插件（如 dsh-sanjip-ops）注册的技能根整个抹掉。
# 技能名不写死：插件包可以完全不带 skill（公共仓库只保留 skills\ 目录），也可以放任意多个
# 自己的 skill。这里动态取第一个带 SKILL.md 的子目录名；没有就跳过 skill 根接线。
function Get-BundledSkillName {
  param([string]$SkillsDir)
  if (-not (Test-Path -LiteralPath $SkillsDir)) { return $null }
  $hit = Get-ChildItem -LiteralPath $SkillsDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
    Select-Object -First 1
  if ($hit) { return $hit.Name }
  return $null
}

function Update-SkillRoot {
  param([string]$File, [string]$Dir, [switch]$Remove)

  $enc = New-Object System.Text.UTF8Encoding($false)
  $lines = @()
  # 坑 14：必须显式按 UTF-8 读！Windows PowerShell 5.1 的 Get-Content 对「无 BOM 的 UTF-8」会按
  # ANSI(CP936) 解码，中文变成「杩愯惴…」这种乱码，再写回 UTF-8 就把用户文件写坏了
  # （实测把 sanjip-ops 的 docBase 写成乱码，还吃掉了结尾的单引号）。
  if (Test-Path -LiteralPath $File) {
    $text = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
    $lines = @($text -split "`r?`n")
    if ($lines.Count -gt 0 -and $lines[-1] -eq '') { $lines = @($lines[0..($lines.Count - 2)]) }
  }

  # 1) 清掉本脚本上次写的托管块（旧版本的写法）
  $clean = New-Object System.Collections.Generic.List[string]
  $inBlock = $false
  foreach ($l in $lines) {
    if ($l -match '^#\s*>>>\s*dsh-android-phone') { $inBlock = $true; continue }
    if ($l -match '^#\s*<<<\s*dsh-android-phone') { $inBlock = $false; continue }
    if (-not $inBlock) { [void]$clean.Add($l) }
  }

  $quoted = "'" + $Dir + "'"
  # 坑 20：①包目录改过名（dsh-android-phone → feiniao-android-phone），所以不能把目录名写死，
  #         只认「…android-phone\skills」这个形状；
  #       ②列表项是缩进的（"      - '...'"），正则漏了 `^\s*` 就永远匹配不到，
  #         于是每次安装都往 customSkillDirs 里再塞一条（实测重构后残留了旧路径）。
  $ours = '^\s*-\s*[''"]?.*android-phone[\\/]+skills[''"]?\s*$'
  $exact = '^\s*-\s*[''"]?' + [regex]::Escape($Dir) + '[''"]?\s*$'

  # 清掉「指向本插件、但目录已不存在」的旧根（搬目录/重构后会残留），
  # 以及重复条目（同类只保留第一条），避免 customSkillDirs 越积越多。
  $pruned = New-Object System.Collections.Generic.List[string]
  $prunedCount = 0
  $seenOurs = $false
  foreach ($l in $clean) {
    if ($l -match '^\s*-\s*[''"]?([^''"]+)[''"]?\s*$') {
      $p = $Matches[1].Trim()
      if ($p -match 'android-phone' -and $p -match 'skills') {
        if (-not (Test-Path -LiteralPath $p)) { $prunedCount++; continue }
        if ($seenOurs) { $prunedCount++; continue }
        $seenOurs = $true
      }
    }
    [void]$pruned.Add($l)
  }
  if ($prunedCount -gt 0) {
    Write-Host "pruned $prunedCount stale/duplicate skill root(s) from $File"
    $clean = $pruned
  }

  # 2) 找 `- id: skill-filesystem` 条目
  $idx = -1
  for ($i = 0; $i -lt $clean.Count; $i++) {
    if ($clean[$i] -match '^\s*-\s*id:\s*skill-filesystem\s*$') { $idx = $i; break }
  }

  if ($idx -ge 0) {
    $end = $clean.Count
    for ($i = $idx + 1; $i -lt $clean.Count; $i++) { if ($clean[$i] -match '^-\s') { $end = $i; break } }

    if ($Remove) {
      $kept = New-Object System.Collections.Generic.List[string]
      for ($i = 0; $i -lt $clean.Count; $i++) {
        if ($i -gt $idx -and $i -lt $end -and $clean[$i].Trim() -match $ours) { continue }
        [void]$kept.Add($clean[$i])
      }
      Write-Host "removed skill root from $File"
      [System.IO.File]::WriteAllText($File, (($kept -join "`r`n") + "`r`n"), $enc)
      return
    }

    if ($clean[$idx..($end - 1)] -match $exact) {
      # 坑 21：上面剪掉的重复/失效条目只在内存里，提前 return 会把这次修剪丢掉
      # （表现：每次安装都打印 pruned 1，但列表里始终还是 2 条）。
      if ($prunedCount -gt 0) { [System.IO.File]::WriteAllText($File, (($clean -join "`r`n") + "`r`n"), $enc) }
      Write-Host "skill root already present in $File"
      return
    }

    $listIdx = -1
    for ($i = $idx + 1; $i -lt $end; $i++) {
      if ($clean[$i] -match '^(\s*)customSkillDirs:\s*$') { $listIdx = $i; break }
      if ($clean[$i] -match '^(\s*)customSkillDirs:\s*\[(.*)\]\s*$') {
        # flow 风格：往中括号里补一项
        $pad = ([regex]::Match($clean[$i], '^(\s*)')).Groups[1].Value
        $body = $Matches[2].Trim()
        $newBody = if ($body) { "$body, $quoted" } else { $quoted }
        $clean[$i] = "$pad" + "customSkillDirs: [$newBody]"
        Write-Host "appended skill root to existing customSkillDirs (flow style) in $File"
        [System.IO.File]::WriteAllText($File, (($clean -join "`r`n") + "`r`n"), $enc)
        return
      }
    }

    if ($listIdx -ge 0) {
      $indent = ([regex]::Match($clean[$listIdx], '^(\s*)')).Groups[1].Value + '  '
      $clean.Insert($listIdx + 1, "$indent- $quoted")
    } else {
      $cfgIdx = -1
      for ($i = $idx + 1; $i -lt $end; $i++) { if ($clean[$i] -match '^(\s*)config:\s*$') { $cfgIdx = $i; break } }
      if ($cfgIdx -lt 0) { throw "skill-filesystem entry in $File has no config: line; 手动加一行 customSkillDirs 再重跑" }
      $indent = ([regex]::Match($clean[$cfgIdx], '^(\s*)')).Groups[1].Value + '  '
      $clean.Insert($cfgIdx + 1, "$indent" + 'customSkillDirs:')
      $clean.Insert($cfgIdx + 2, "$indent  - $quoted")
    }
    Write-Host "added skill root to existing skill-filesystem entry: $Dir"
    [System.IO.File]::WriteAllText($File, (($clean -join "`r`n") + "`r`n"), $enc)
    return
  }

  if ($Remove) { return }   # 本来就没这条，卸载时不用管

  if ($clean.Count -and $clean[$clean.Count - 1].Trim() -ne '') { [void]$clean.Add('') }
  [void]$clean.Add('# >>> dsh-android-phone (managed) >>>')
  [void]$clean.Add('- id: skill-filesystem')
  [void]$clean.Add('  disabled: false')
  [void]$clean.Add('  config:')
  [void]$clean.Add('    customSkillDirs:')
  [void]$clean.Add("      - $quoted")
  [void]$clean.Add('# <<< dsh-android-phone (managed) <<<')
  Write-Host "created skill-filesystem entry with skill root: $Dir"
  [System.IO.File]::WriteAllText($File, (($clean -join "`r`n") + "`r`n"), $enc)
}

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
  if ($WhatIfOnly) { Write-Host "[what-if] would remove $linkPath, drop '$pluginName' from the manifest, and remove the skill root from $patchFile"; return }
  foreach ($file in @($profileJson, $patchFile)) {
    if (Test-Path $file) { Copy-Item $file "$file.bak-android-phone" -Force }
  }
  if (Test-Path $linkPath) { (Get-Item $linkPath -Force).Delete(); Write-Host "removed link $linkPath" }
  if (Test-Path $vendorPath) { Remove-Item $vendorPath -Recurse -Force; Write-Host "removed $vendorPath" }
  Update-SkillRoot -File $patchFile -Remove
  $enc = New-Object System.Text.UTF8Encoding($false)
  $json = [System.IO.File]::ReadAllText($profileJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $pluginName })
  $json.dependencies.PSObject.Properties.Remove($pluginName)
  [System.IO.File]::WriteAllText($profileJson, ($json | ConvertTo-Json -Depth 20), $enc)
  Write-Host "uninstalled. Restart DSH to drop the host half." -ForegroundColor Green
  return
}

if ($WhatIfOnly) {
  Write-Host "`n[what-if] package       : $Source"
  if ($Copy) { Write-Host "[what-if] would copy to : $vendorPath" }
  Write-Host "[what-if] would link    : $linkPath -> $(if ($Copy) { $vendorPath } else { $Source })"
  Write-Host "[what-if] would add     : '$pluginName' to dsh.profile.bundles"
  Write-Host "[what-if] would declare : dependencies['$pluginName']"
  Write-Host "[what-if] would add skill root to $patchFile :"
  Write-Host "                       $(Join-Path $(if ($Copy) { $vendorPath } else { $Source }) 'skills')"
  return
}

# ------------------------------------------------------------------- 1. backup
foreach ($file in @($profileJson, $patchFile)) {
  if (Test-Path $file) { Copy-Item $file "$file.bak-android-phone" -Force }
}
Write-Host 'backed up profile files (*.bak-android-phone)'

# ----------------------------------------------------------- 2. place package
if ($Copy) {
  if (Test-Path $vendorPath) { Remove-Item $vendorPath -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $vendorPath | Out-Null
  # robocopy exit codes below 8 mean success (1 = files copied).
  $null = robocopy $Source $vendorPath /E /NFL /NDL /NJH /NJS /NP /XD '.git' 'recon' 'logs' '/XF' '*.tgz'
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  $target = $vendorPath
  Write-Host "copied plugin to $vendorPath"
} else {
  $target = $Source
}

if (Test-Path $linkPath) { (Get-Item $linkPath -Force).Delete() }
New-Item -ItemType Junction -Path $linkPath -Target $target | Out-Null
Write-Host "linked $linkPath -> $target"

# ------------------------------------------------------- 3. declare dependency
$dependencySpec = if ($Copy) {
  "file:vendor/$pluginName"
} else {
  # A relative spec, so the manifest stays valid if the whole tree moves.
  # (Path.GetRelativePath is .NET Core only; PowerShell 5.1 would blow up on it.)
  Push-Location $ProfileDir
  try { $rel = [string](Resolve-Path -LiteralPath $Source -Relative) } finally { Pop-Location }
  "link:" + $rel.Replace('\', '/')
}

$enc = New-Object System.Text.UTF8Encoding($false)
$json = [System.IO.File]::ReadAllText($profileJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$changed = $false

if (@($json.dsh.profile.bundles) -notcontains $pluginName) {
  $json.dsh.profile.bundles = @($json.dsh.profile.bundles) + $pluginName
  $changed = $true
  Write-Host "added '$pluginName' to dsh.profile.bundles"
}
$current = $json.dependencies.PSObject.Properties[$pluginName]
if (-not $current) {
  $json.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $dependencySpec -Force
  $changed = $true
  Write-Host "declared dependency: $pluginName = $dependencySpec"
} elseif ($current.Value -ne $dependencySpec) {
  $current.Value = $dependencySpec
  $changed = $true
  Write-Host "updated dependency spec to $dependencySpec"
}
if ($changed) {
  # No BOM: a BOM in package.json is a boot-time parse error.
  [System.IO.File]::WriteAllText($profileJson, ($json | ConvertTo-Json -Depth 20), $enc)
}
[System.IO.File]::ReadAllText($profileJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json | Out-Null   # prove it still parses
Write-Host 'profile manifest is valid JSON'

# --------------------------------------------------- 3b. 注册 skill 根（技能随插件走）
$skillDir = Join-Path $target 'skills'
$skillName = Get-BundledSkillName $skillDir
if ($skillName) {
  Update-SkillRoot -File $patchFile -Dir $skillDir
} else {
  Write-Host "插件包没自带 skill（$skillDir 下没有 SKILL.md）—— 只装插件，不注册 skill 根"
}

# ------------------------------------------------------------------ 4. verify
$link = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
if (-not $link) { throw "verification failed: $linkPath missing" }
foreach ($f in @('index.js', 'client.js', 'src\android\adb.js', 'src\android\video.js')) {
  if (-not (Test-Path (Join-Path $linkPath $f))) { throw "verification failed: $f not reachable through $linkPath" }
}
$check = [System.IO.File]::ReadAllText($profileJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (@($check.dsh.profile.bundles) -notcontains $pluginName) { throw "verification failed: '$pluginName' not in dsh.profile.bundles" }
if (-not $check.dependencies.PSObject.Properties[$pluginName]) { throw "verification failed: dependency '$pluginName' missing" }
$patchText = if (Test-Path $patchFile) { [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8) } else { '' }
if ($skillName -and (Test-Path $SkillDir)) {
  if ($patchText -notmatch [regex]::Escape($SkillDir)) { throw "verification failed: skill root '$SkillDir' not registered in $patchFile" }
  if (-not (Test-Path (Join-Path $SkillDir "$skillName\SKILL.md"))) { throw "verification failed: $skillName\SKILL.md missing under $SkillDir" }
  Write-Host "skill root registered: $SkillDir" -ForegroundColor Green
}
$skillCount = ([regex]::Matches($patchText, '(?m)^\s*customSkillDirs:\s*$')).Count +
              ([regex]::Matches($patchText, '(?m)^\s*customSkillDirs:\s*\[')).Count
if ($skillCount -gt 1) { Write-Warning "cordis.patch.yml 里有 $skillCount 处 customSkillDirs（同 id 多条会互相覆盖，检查一下）" }

Write-Host ''
Write-Host "installed $pluginName into profile '$Profile'." -ForegroundColor Green
Write-Host 'Next: restart DSH (the host half only loads on boot), then hard-refresh the sidebar (Ctrl+Shift+R).'