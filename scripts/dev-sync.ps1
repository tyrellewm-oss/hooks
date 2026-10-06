# Local web site that keeps itself up to date (Windows PowerShell). It starts the Vite dev server and pulls the
# branch you are on from GitHub every few seconds; Vite reloads the open page when pulled files change.
# Start it by double-clicking scripts\dev-sync.cmd, or from a terminal in the repo:
#   scripts\dev-sync.cmd          sample tokens (fixtures)      -> http://127.0.0.1:5176
#   scripts\dev-sync.cmd -Live    real devnet data; needs the page server on 5175 (pnpm page -- --cluster devnet --web)
# Stop it with Ctrl+C. It only ever fast-forwards: your own commits and edits are never overwritten.
param([switch]$Live, [int]$Every = 15)

$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'web'
Set-Location $root

function Say($text, $colour = 'Gray') { Write-Host "[sync $(Get-Date -Format HH:mm:ss)] $text" -ForegroundColor $colour }

function Install {
  Say 'Installing packages...'
  Push-Location $web
  pnpm install
  Pop-Location
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$script:warned = ''

# Fetch the branch; fast-forward to it when GitHub has new commits. Anything that needs a person (your own commits on
# the branch, or edits in the way) is reported once per new GitHub commit, never forced.
function Sync {
  git fetch --quiet origin $branch 2>$null
  if ($LASTEXITCODE -ne 0) { Say 'Could not reach GitHub. Trying again shortly.' 'Yellow'; return }
  $remote = "origin/$branch"
  $behind = [int](git rev-list --count "HEAD..$remote")
  if ($behind -eq 0) { return }
  $before = (git rev-parse HEAD).Trim()
  git merge --ff-only --quiet $remote 2>$null
  if ($LASTEXITCODE -ne 0) {
    $tip = (git rev-parse $remote).Trim()
    if ($script:warned -ne $tip) {
      Say "GitHub has $behind new commit(s), but your copy has its own commits or edits in the way, so nothing was pulled. Run: git status" 'Yellow'
      $script:warned = $tip
    }
    return
  }
  Say "Pulled $behind new commit(s):" 'Green'
  git log --oneline "$before..HEAD" | ForEach-Object { Write-Host "    $_" -ForegroundColor Green }
  if (git diff --name-only $before HEAD | Where-Object { $_ -match '(^|/)(package\.json|pnpm-lock\.yaml)$' }) { Install }
}

if ($branch -eq 'HEAD') { Say 'You are not on a branch (detached HEAD). Run: git checkout <branch>' 'Red'; exit 1 }
Say "Following $branch on GitHub, checking every $Every s."
Sync
Install

# Vite's own entry point, the same as `pnpm dev` / `pnpm dev:fixtures` in web/package.json, run straight with node so
# Ctrl+C stops it cleanly.
$viteArgs = @('node_modules/vite/bin/vite.js')
if (-not $Live) { $viteArgs += @('--mode', 'fixtures') }
$site = Start-Process -FilePath 'node' -ArgumentList $viteArgs -WorkingDirectory $web -NoNewWindow -PassThru
try {
  while (-not $site.HasExited) {
    Start-Sleep -Seconds $Every
    if (-not $site.HasExited) { Sync }
  }
  Say 'The site stopped. Is something else already using port 5176?' 'Red'
} finally {
  if (-not $site.HasExited) { Stop-Process -Id $site.Id -Force -ErrorAction SilentlyContinue }
}
