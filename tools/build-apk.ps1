$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
$sdk  = 'C:\Users\luoch\AppData\Local\Temp\opencode\android\sdk'
$jdk  = 'C:\Users\luoch\AppData\Local\Temp\opencode\android\jdk'
$bt   = "$sdk\build-tools\34.0.0"
$aj   = "$sdk\platforms\android-34\android.jar"
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

foreach ($p in @("$bt\aapt2.exe", "$bt\d8.bat", "$bt\zipalign.exe", "$bt\apksigner.bat", $aj, "$jdk\bin\javac.exe")) {
  if (!(Test-Path $p)) { throw "missing build tool: $p" }
}

$work = "$root\android\build"
$app  = "$root\android\app\src\main"
$out  = "$root\release"
New-Item -ItemType Directory -Force $work, "$work\classes", "$work\dex", "$work\gen", $out, "$app\assets" | Out-Null
Remove-Item "$work\*.apk", "$work\res.zip" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$work\classes\*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$work\dex\*" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[1/6] build web bundle"
node "$root\tools\build-www.js"
if ($LASTEXITCODE -ne 0) { throw "web build failed" }
Copy-Item "$root\app\index.html" "$app\assets\index.html" -Force

Push-Location $app
try {
  Write-Host "[2/6] compile resources"
  & "$bt\aapt2.exe" compile --dir res -o "$work\res.zip"
  if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

  & "$bt\aapt2.exe" link -o "$work\base.apk" -I $aj --manifest AndroidManifest.xml -A assets --java "$work\gen" "$work\res.zip"
  if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }
} finally { Pop-Location }

Write-Host "[3/6] compile java"
$srcs = @(Get-ChildItem "$app\java" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$srcs += @(Get-ChildItem "$work\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& "$jdk\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $aj -d "$work\classes" $srcs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "[4/6] dex"
$classes = @(Get-ChildItem "$work\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& "$bt\d8.bat" --lib $aj --min-api 24 --output "$work\dex" $classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "[5/6] assemble apk"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$work\base.apk", 'Update')
$entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
$st = $entry.Open()
$dex = [System.IO.File]::ReadAllBytes("$work\dex\classes.dex")
$st.Write($dex, 0, $dex.Length)
$st.Close()
$zip.Dispose()

& "$bt\zipalign.exe" -f 4 "$work\base.apk" "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "[6/6] sign"
$ks = "$out\yuedu.jks"
if (!(Test-Path $ks)) {
  & "$jdk\bin\keytool.exe" -genkeypair -keystore $ks -alias yuedu -keyalg RSA -keysize 2048 -validity 10000 -storepass yuedu2026 -keypass yuedu2026 -dname "CN=Yuedu, O=Yuedu, C=CN"
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
$apk = "$out\yuedu-1.0.0.apk"
if (Test-Path $apk) { Remove-Item $apk -Force }
& "$bt\apksigner.bat" sign --ks $ks --ks-key-alias yuedu --ks-pass pass:yuedu2026 --key-pass pass:yuedu2026 --out $apk "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& "$bt\apksigner.bat" verify --print-certs $apk | Select-Object -First 4

$mb = [math]::Round((Get-Item $apk).Length / 1MB, 2)
Write-Host ("APK OK -> " + $apk + " (" + $mb + " MB)")
