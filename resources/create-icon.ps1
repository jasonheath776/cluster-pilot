Add-Type -AssemblyName System.Drawing

$bitmap = New-Object System.Drawing.Bitmap 128, 128
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'

# Background
$graphics.Clear([System.Drawing.Color]::FromArgb(30, 58, 95))

# Propeller blades (blue)
$blueBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(74, 144, 226))
$graphics.FillEllipse($blueBrush, 52, 10, 24, 48)  # Top blade
$graphics.FillEllipse($blueBrush, 70, 52, 48, 24)  # Right blade
$graphics.FillEllipse($blueBrush, 52, 70, 24, 48)  # Bottom blade
$graphics.FillEllipse($blueBrush, 10, 52, 48, 24)  # Left blade

# Center hub (orange)
$orangeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(243, 156, 18))
$graphics.FillEllipse($orangeBrush, 48, 48, 32, 32)

# Center detail (dark)
$darkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(52, 73, 94))
$graphics.FillEllipse($darkBrush, 56, 56, 16, 16)

# Save
$bitmap.Save("$PSScriptRoot\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Icon created successfully: icon.png (128x128)"
