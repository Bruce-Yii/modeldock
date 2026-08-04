$chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
$out = 'D:\projects\modeldock\test\dashboard.png'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
$p = Start-Process -FilePath $chrome -ArgumentList '--headless=new','--disable-gpu','--hide-scrollbars','--window-size=1440,900',"--screenshot=$out",'http://127.0.0.1:4097' -Wait -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
if (Test-Path -LiteralPath $out) { Get-Item -LiteralPath $out | Select-Object FullName, Length, LastWriteTime } else { Write-Output 'SCREENSHOT MISSING'; Write-Output "chrome exit: $($p.ExitCode)" }
