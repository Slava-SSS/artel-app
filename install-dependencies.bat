@echo off
REM ============================================
REM УСТАНОВКА NPM ЗАВИСИМОСТЕЙ ДЛЯ АРТЕЛЬ v0.9
REM ============================================

echo.
echo 📦 Установка npm пакетов для 3D превью...
echo.

REM Проверяем есть ли npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ npm не найден в PATH!
    echo.
    echo Решение: Установите Node.js с https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo ✅ npm найден
echo.

REM Устанавливаем пакеты
npm install

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ УСПЕШНО! Пакеты установлены!
    echo.
    echo Теперь:
    echo 1. Перезагрузи приложение
    echo 2. Нажми "🎬 Индекс превью"
    echo 3. Смотри на 3D превью для STL/STEP/3MF файлов!
    echo.
    pause
) else (
    echo.
    echo ❌ ОШИБКА при установке пакетов!
    echo.
    pause
    exit /b 1
)
