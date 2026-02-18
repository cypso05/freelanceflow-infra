# test-local.ps1
Write-Host " Testing FreelanceFlow Pro API Locally" -ForegroundColor Green
Write-Host "========================================"

# Check if Node.js is installed
$nodeVersion = node --version
if ($LASTEXITCODE -ne 0) {
    Write-Host " Node.js is not installed. Please install Node.js 20+" -ForegroundColor Red
    exit 1
}
Write-Host " Node.js version: $nodeVersion" -ForegroundColor Green

# Check if Azure Functions Core Tools is installed
$funcVersion = func --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Azure Functions Core Tools not found, installing..." -ForegroundColor Yellow
    npm install -g azure-functions-core-tools@4 --unsafe-perm true
}

# Install dependencies
Write-Host "`n Installing API dependencies..." -ForegroundColor Yellow
Set-Location api
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host " Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host " Dependencies installed" -ForegroundColor Green

# Test environment variables
Write-Host "`n Checking environment variables..." -ForegroundColor Yellow
if (Test-Path "../.env") {
    Write-Host " .env file found" -ForegroundColor Green
} else {
    Write-Host "  .env file not found, creating from template..." -ForegroundColor Yellow
    @"
COSMOS_DB_CONNECTION_STRING=AccountEndpoint=https://cdb-freelanceflow-prod.documents.azure.com:443/;AccountKey=LeUyXQxVim9T9quXAXq4JWJW1OGHisYsLW7ltaCdWtrcMvQfriN8Dbj4hsg6KY5rWhB9cANeWgo6ACDb1zqnBQ==;
COSMOS_DATABASE_NAME=freelanceflow-db
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;EndpointSuffix=core.windows.net;AccountName=stfreelanceflowcore;AccountKey=2lFDexGPCDsJ8c3qqC35qEPJeS2bqZXOmhUd+tnlZmN1KCwf4no5FgiHTDs1Cke2Q0aMNGNjb+k8+ASt6e4lXA==;BlobEndpoint=https://stfreelanceflowcore.blob.core.windows.net/;FileEndpoint=https://stfreelanceflowcore.file.core.windows.net/;QueueEndpoint=https://stfreelanceflowcore.queue.core.windows.net/;TableEndpoint=https://stfreelanceflowcore.table.core.windows.net/
BLOB_CONTAINER_NAME=uploads
ALLOWED_ORIGINS=http://localhost:4280,https://kind-field-057dd3003.1.azurestaticapps.net
NODE_ENV=development
JWT_SECRET=70MFrYAsZeVGq1DjC3SbNI4TpkH5POBt
AZURE_SUBSCRIPTION_ID=af2a7744-19b9-4d62-b615-6f05bcae8863
AZURE_TENANT_ID=c4babf05-7a3a-4ae0-9e05-22d7deecb41c
"@ | Out-File -FilePath "../.env" -Encoding utf8
    Write-Host " .env template created" -ForegroundColor Green
}

# Test API connectivity
Write-Host "`n Testing API endpoints..." -ForegroundColor Yellow

# Start API in background
$apiProcess = Start-Process -FilePath "powershell" -ArgumentList "-Command func start" -PassThru -NoNewWindow

# Wait for API to start
Write-Host "Waiting for API to start..." -NoNewline
$maxAttempts = 30
$attempt = 0
$apiReady = $false

while ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 1
    Write-Host "." -NoNewline
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:7071/api/health" -Method GET -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $apiReady = $true
            break
        }
    } catch {
        # API not ready yet
    }
    $attempt++
}
Write-Host ""

if ($apiReady) {
    Write-Host " API is running at http://localhost:7071" -ForegroundColor Green
    
    # Test all endpoints
    $endpoints = @(
        "/api/health",
        "/api/forms",
        "/api/contracts",
        "/api/invoices",
        "/api/receipts"
    )
    
    foreach ($endpoint in $endpoints) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:7071$endpoint" -Method GET -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 401) {
                Write-Host "   $endpoint - $(if($response.StatusCode -eq 401){'Auth required (working)'}else{'OK'})" -ForegroundColor Green
            } else {
                Write-Host "    $endpoint - Status: $($response.StatusCode)" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "   $endpoint - Failed" -ForegroundColor Red
        }
    }
} else {
    Write-Host " API failed to start" -ForegroundColor Red
}

Write-Host "`n Local testing complete!" -ForegroundColor Green
Write-Host "API is running. Press Ctrl+C to stop when done testing." -ForegroundColor Yellow

# Keep the script running
Read-Host "Press Enter to stop the API and exit"

# Stop the API process
Stop-Process -Id $apiProcess.Id -Force
