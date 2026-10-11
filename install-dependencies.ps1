#!/usr/bin/env powershell

# ============================================
# УСТАНОВКА NPM ЗАВИСИМОСТЕЙ ДЛЯ АРТЕЛЬ v0.9
# ============================================

Write-Host ""
Write-Host "📦 Установка npm пакетов для 3D превью..." -ForegroundColor Cyan
Write-Host ""

# Проверяем есть ли npm
$npmPath = where.exe npm 2>$null
if (-not $npmPath) {
    Write-Host "❌ npm не найден в PATH!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Решение: Установите Node.js с https://nodejs.org/" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

Write-Host "✅ npm найден: $npmPath" -ForegroundColor Green
Write-Host ""

# Устанавливаем пакеты
Write-Host "⏳ Загружаю пакеты..." -ForegroundColor Yellow
npm install

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ УСПЕШНО! Пакеты установлены!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Теперь:" -ForegroundColor Cyan
    Write-Host "1. Перезагрузи приложение"
    Write-Host "2. Нажми '🎬 Индекс превью'"
    Write-Host "3. Смотри на 3D превью для STL/STEP/3MF файлов!"
    Write-Host ""
    Read-Host "Нажмите Enter для выхода"
} else {
    Write-Host ""
    Write-Host "❌ ОШИБКА при установке пакетов!" -ForegroundColor Red
    Write-Host ""
    Read-Host "Нажмите Enter для выхода"
    exit 1
}
