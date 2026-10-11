# Создать красивую иконку с буквой "А" для АРТЕЛЬ
Add-Type -AssemblyName System.Drawing

# Размер иконки
$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

# Фон: градиент синий
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 102, 204))
$graphics.FillRectangle($brush, 0, 0, $size, $size)

# Буква "А" большая белая
$font = New-Object System.Drawing.Font("Arial", 180, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$graphics.DrawString("А", $font, $textBrush, 20, 15)

# Сохранить как PNG первый раз
$pngPath = "F:\Artel APP GitHub\artel-icon.png"
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Конвертировать PNG в ICO
$icoPath = "F:\Artel APP GitHub\Артель.ico"
$image = [System.Drawing.Image]::FromFile($pngPath)
$icon = [System.Drawing.Icon]::FromHandle($image.GetHicon())
$fileStream = [System.IO.File]::Create($icoPath)
$icon.Save($fileStream)
$fileStream.Close()

Write-Host "✅ Иконка создана: $icoPath"
Write-Host "📍 Дизайн: Синий фон, белая буква А"
