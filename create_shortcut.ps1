# Создать ярлык для АРТЕЛЬ на рабочем столе
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "АРТЕЛЬ.lnk"
$AppPath = "F:\Artel APP GitHub\start.bat"

# Создать объект Shell
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)

# Установить свойства
$Shortcut.TargetPath = $AppPath
$Shortcut.WorkingDirectory = "F:\Artel APP GitHub"
$Shortcut.Description = "АРТЕЛЬ - Система управления файлами проектов"
$Shortcut.WindowStyle = 1  # Normal window

# Сохранить ярлык
$Shortcut.Save()

Write-Host "✅ Ярлык создан на рабочем столе: АРТЕЛЬ.lnk" -ForegroundColor Green
