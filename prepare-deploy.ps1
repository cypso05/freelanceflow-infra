# prepare-deploy.ps1
param(
    [string]$RepoPath = "https://github.com/cypso05/freelanceflow-infra.git",
    [switch]$PushToGitHub = $false
)

Write-Host "🚀 Preparing FreelanceFlow Pro for Deployment" -ForegroundColor Green
Write-Host "============================================"

# Step 1: Clean up old files (optional - comment out if you want to keep everything)
Write-Host "`n🧹 Checking for old files..." -ForegroundColor Yellow
$foldersToKeep = @(".git", "public", "api", ".github", "terraform")
$filesToKeep = @(".gitignore", "README.md", "LICENSE", ".env", "backend.tf", "main.tf", "variables.tf", "outputs.tf")

# Only remove if they exist and aren't in the keep list
Get-ChildItem -Path . -Directory | ForEach-Object {
    if ($_.Name -notin $foldersToKeep) {
        Write-Host "  Found folder: $($_.Name) (will keep)" -ForegroundColor Yellow
    }
}

Get-ChildItem -Path . -File | ForEach-Object {
    if ($_.Name -notin $filesToKeep -and !$_.Name.EndsWith(".ps1")) {
        Write-Host "  Found file: $($_.Name) (will keep)" -ForegroundColor Yellow
    }
}

# Step 2: Verify all production files are in place
Write-Host "`n✅ Verifying production files..." -ForegroundColor Yellow

$requiredFiles = @(
    "api\_lib\config.js",
    "api\routes\forms.js",
    "api\routes\contracts.js",
    "api\routes\invoices.js",
    "api\routes\receipts.js",
    "api\index.js",
    "api\package.json",
    "api\host.json",
    "api\local.settings.json",
    "public\index.html",
    "public\contracts.html",
    "public\invoices.html",
    "public\receipts.html",
    "public\dashboard.html",
    "public\navigation.js",
    ".github\workflows\freelanceflow-pro.yml",
    "backend.tf",
    ".env"
)

$allFound = $true
foreach ($file in $requiredFiles) {
    if (Test-Path $file) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file - MISSING!" -ForegroundColor Red
        $allFound = $false
    }
}

if (-not $allFound) {
    Write-Host "`n❌ Some required files are missing!" -ForegroundColor Red
    exit 1
}

# Step 3: Update version in package.json
Write-Host "`n📦 Updating version in package.json..." -ForegroundColor Yellow
$packageJsonPath = "api\package.json"
if (Test-Path $packageJsonPath) {
    $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
    $versionParts = $packageJson.version -split '\.'
    if ($versionParts.Count -eq 3) {
        $versionParts[2] = [int]$versionParts[2] + 1
        $newVersion = $versionParts -join '.'
        $packageJson.version = $newVersion
        $packageJson | ConvertTo-Json -Depth 10 | Set-Content $packageJsonPath
        Write-Host "  Version updated to: $newVersion" -ForegroundColor Green
    } else {
        Write-Host "  Version format not recognized, keeping current: $($packageJson.version)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  package.json not found, skipping version update" -ForegroundColor Yellow
}

# Step 4: Create deployment commit message
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$commitMessage = "Production update: $timestamp`n`n- Full Express Azure Function API with forms, contracts, invoices, receipts`n- Integrated with Azure Cosmos DB and Blob Storage`n- Complete CI/CD pipeline with GitHub Actions`n- Terraform infrastructure as code"

# Step 5: Push to GitHub if requested
if ($PushToGitHub) {
    Write-Host "`n📤 Pushing to GitHub..." -ForegroundColor Yellow
    
    # Check if git is available
    $gitVersion = git --version
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Git is not installed or not in PATH" -ForegroundColor Red
        exit 1
    }
    
    # Check if we're in a git repository
    if (-not (Test-Path ".git")) {
        Write-Host "❌ Not a git repository. Please initialize git first:" -ForegroundColor Red
        Write-Host "  git init" -ForegroundColor Yellow
        Write-Host "  git remote add origin $RepoPath" -ForegroundColor Yellow
        exit 1
    }
    
    # Check if remote exists
    $remoteUrl = git config --get remote.origin.url
    if (-not $remoteUrl) {
        git remote add origin $RepoPath
        Write-Host "  Added remote: $RepoPath" -ForegroundColor Green
    }
    
    # Add all files
    git add .
    
    # Check if there are changes to commit
    $status = git status --porcelain
    if ($status) {
        git commit -m $commitMessage
        
        # Push to main branch
        Write-Host "  Pushing to origin main..." -ForegroundColor Yellow
        git push origin main --force
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Successfully pushed to GitHub!" -ForegroundColor Green
        } else {
            Write-Host "❌ Failed to push to GitHub" -ForegroundColor Red
        }
    } else {
        Write-Host "  No changes to commit" -ForegroundColor Yellow
    }
} else {
    Write-Host "`n📝 Ready to commit with message:" -ForegroundColor Yellow
    Write-Host $commitMessage -ForegroundColor Cyan
    Write-Host "`nRun these commands to push manually:" -ForegroundColor Yellow
    Write-Host "  git add ." -ForegroundColor Green
    Write-Host "  git commit -m `"$commitMessage`"" -ForegroundColor Green
    Write-Host "  git push origin main" -ForegroundColor Green
}

Write-Host "`n✨ Preparation complete!" -ForegroundColor Green