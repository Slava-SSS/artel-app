const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { execSync } = require('child_process');
const JSZip = require('jszip');
const dotenv = require('dotenv');

// Логирование в файл (для Electron main process)
const LOG_FILE = path.join(process.env.TEMP || '/tmp', 'artel-debug.log');
const logs = []; // Хранит последние 500 логов для отправки в UI
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  const logEntry = { timestamp, msg };

  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    console.error('Log write error:', e.message);
  }

  // Сохраняем в памяти и отправляем в UI
  logs.push(logEntry);
  if (logs.length > 500) logs.shift();

  // Отправляем в UI если окно открыто
  try {
    if (mainWindow && typeof mainWindow === 'object' && mainWindow.webContents) {
      mainWindow.webContents.send('log', logEntry);
    }
  } catch (e) {
    // Окно еще не инициализировано или не готово
  }
}

// Загрузить .env файл
dotenv.config({ path: path.join(__dirname, '.env') });
log('[INIT] TELEGRAM_BOT_TOKEN: ' + (process.env.TELEGRAM_BOT_TOKEN ? '✅ OK' : '❌ NOT SET'));

const telegramBot = require('./telegram-bot');
const { dialog } = require('electron');

// ============================================
// КОНФИГ И ПОРТАТИВНОСТЬ ПУТЕЙ
// ============================================

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(configData);
    }
  } catch (err) {
    log(`[CONFIG] ❌ Error loading config: ${err.message}`);
  }
  return null;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    log('[CONFIG] ✅ Config saved');
  } catch (err) {
    log(`[CONFIG] ❌ Error saving config: ${err.message}`);
  }
}

async function ensureConfigured(mainWin) {
  log('[CONFIG] Проверка конфигурации...');

  let config = loadConfig();

  if (!config || !config.rootPath || !fs.existsSync(config.rootPath)) {
    log('[CONFIG] ⚠️ Конфиг не найден или путь неверный. Запрашиваю папку у пользователя...');

    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Выберите папку "Артель"',
      message: 'Пожалуйста, выберите корневую папку проекта АРТЕЛЬ',
      properties: ['openDirectory'],
      defaultPath: process.env.USERPROFILE
    });

    if (result.canceled || !result.filePaths[0]) {
      log('[CONFIG] ❌ Папка не выбрана, приложение выходит');
      app.quit();
      return false;
    }

    const selectedPath = result.filePaths[0];
    config = {
      rootPath: selectedPath,
      projectsSubfolder: 'Проекты',
      version: '0.8-architecture',
      configuredAt: new Date().toISOString(),
      notes: 'Портативная архитектура путей как Obsidian'
    };

    saveConfig(config);
    log(`[CONFIG] ✅ Конфигурация сохранена: ${selectedPath}`);
  }

  ROOT_PATH = config.rootPath;
  PROJECTS_PATH = path.join(ROOT_PATH, config.projectsSubfolder);

  log(`[CONFIG] ROOT_PATH: ${ROOT_PATH}`);
  log(`[CONFIG] PROJECTS_PATH: ${PROJECTS_PATH}`);

  return true;
}

// Функция для преобразования абсолютного пути в относительный от ROOT_PATH
function makeRelativePath(absolutePath) {
  if (!ROOT_PATH) return absolutePath;
  try {
    return path.relative(ROOT_PATH, absolutePath);
  } catch (err) {
    log(`[PATHS] Error making relative path: ${err.message}`);
    return absolutePath;
  }
}

// Функция для преобразования относительного пути в абсолютный
function makeAbsolutePath(relativePath) {
  if (!ROOT_PATH) return relativePath;
  try {
    return path.join(ROOT_PATH, relativePath);
  } catch (err) {
    log(`[PATHS] Error making absolute path: ${err.message}`);
    return relativePath;
  }
}

// Пути
const APP_PATH = __dirname;
const DATA_PATH = path.join(APP_PATH, 'data');
const DB_FILE = path.join(DATA_PATH, 'artel.json');
const CONFIG_FILE = path.join(APP_PATH, 'config.json');
const CACHE_PATH = path.join(APP_PATH, 'cache');

// Портативные пути (зависят от конфига)
let ROOT_PATH = null;
let PROJECTS_PATH = null;

let mainWindow = null;
let db = {
  projects: {},
  files: [],
  categories: [],
  tags: {},
  relationships: [],
};

log('[DEBUG] PROJECTS_PATH: ' + PROJECTS_PATH);

// ============================================
// ФУНКЦИИ ПРОВЕРКИ И УПРАВЛЕНИЯ КАРТИНКАМИ (v0.8)
// ============================================

const INDEXABLE_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'];

// Backup расширения (ИСКЛЮЧАЮТСЯ ИЗ ИНДЕКСАЦИИ - ПРАВИЛО 10)
const BACKUP_EXTENSIONS = [
  '3dmbak',    // Rhino backup
  'rhl',       // Rhino lock file
  'dwgbak',    // AutoCAD backup
  'dwfbak',    // DWF backup
  'pdfbak',    // PDF backup
  'aibak',     // Adobe Illustrator backup
  'skb',       // SketchUp backup
  'bak',       // Generic backup
];

function isBackupFile(file) {
  if (!file || !file.ext) return false;
  const ext = file.ext.toLowerCase().replace(/^\./, ''); // Remove leading dot
  return BACKUP_EXTENSIONS.includes(ext) || file.name.endsWith('~');
}

function canIndexThumbnail(file) {
  if (!file || !file.ext) return false;
  // ❌ Исключаем backup файлы (ПРАВИЛО 10)
  if (isBackupFile(file)) return false;
  return INDEXABLE_IMAGE_FORMATS.includes(file.ext.toLowerCase());
}

function getThumbnailStatus(file) {
  // 1. Если не картинка
  if (!canIndexThumbnail(file)) {
    return 'not_image';
  }

  // 2. Если уже проиндексирована
  if (file.thumbnail && file.thumbnail.status === 'indexed') {
    // Проверяем не изменился ли файл (по contentHash)
    try {
      if (file.contentHash && file.thumbnail.contentHash === file.contentHash) {
        return 'indexed';
      }
      return 'not_found'; // Изменилась - нужна переиндексация
    } catch (e) {
      return 'not_found';
    }
  }

  // 3. Если никогда не индексирована
  if (!file.thumbnail || file.thumbnail === null) {
    return 'pending';
  }

  // 4. Если был статус но файл потеряется
  if (file.thumbnail && file.thumbnail.status === 'missing') {
    return 'missing';
  }

  return 'not_found';
}

// Миграция БД для добавления правильной структуры thumbnail (v0.8)
function migrateToV0_8() {
  log('[MIGRATE] Начало миграции на v0.8 структуру');

  let changedCount = 0;

  if (!db.files || !Array.isArray(db.files)) {
    log('[MIGRATE] ❌ Файлы не найдены в БД');
    return false;
  }

  for (let i = 0; i < db.files.length; i++) {
    const file = db.files[i];

    // Если thumbnail уже новая структура - пропускаем
    if (file.thumbnail && typeof file.thumbnail === 'object' && file.thumbnail.status) {
      continue;
    }

    // Обновляем структуру thumbnail
    const status = canIndexThumbnail(file) ? 'pending' : 'not_image';

    file.thumbnail = {
      status: status,
      previewPath: null,
      thumbPath: null,
      contentHash: null,
      width: null,
      height: null,
      format: null,
      indexedAt: null
    };

    changedCount++;
  }

  log(`[MIGRATE] ✅ Миграция завершена: обновлено ${changedCount} файлов`);
  return changedCount > 0;
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.webContents.openDevTools();
}

app.on('ready', async () => {
  log('[APP] ready event fired');
  if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
  if (!fs.existsSync(CACHE_PATH)) fs.mkdirSync(CACHE_PATH, { recursive: true });

  log('[APP] Creating window...');
  createWindow();

  log('[APP] Ensuring configuration...');
  const configured = await ensureConfigured(mainWindow);
  if (!configured) return;

  log('[APP] Loading database...');
  loadDatabase();
  log('[APP] Indexing projects...');
  await indexProjects();

  // Запуск Telegram-бота если есть токен
  if (process.env.TELEGRAM_BOT_TOKEN) {
    log('[APP] Starting Telegram bot...');
    const photoDir = path.join(DATA_PATH, 'photos');
    telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN, photoDir);

    // Функция синхронизации заказов
    const syncTelegramOrders = () => {
      const newOrders = telegramBot.getOrders();

      if (newOrders && newOrders.length > 0) {
        if (!db.orders) db.orders = [];
        const existingIds = new Set(db.orders.map(o => o.messageId));

        let addedCount = 0;
        newOrders.forEach(order => {
          if (!existingIds.has(order.messageId)) {
            const dbOrder = {
              id: order.id,
              title: order.title,
              description: order.description || '',
              author: order.author,
              photos: order.photos || [],
              comments: [],
              createdAt: order.date,
              messageId: order.messageId,
              category: null,
              deadline: null,
              assignee: null,
              status: 'новый',
              history: [{ action: 'created_from_telegram', timestamp: new Date().toISOString(), author: order.author }]
            };
            db.orders.push(dbOrder);
            existingIds.add(order.messageId);
            addedCount++;

            if (mainWindow) {
              mainWindow.webContents.send('new-order-telegram', dbOrder);
            }
          }
        });

        if (addedCount > 0) {
          saveDatabase();
        }
      }
    };

    // Периодическая синхронизация каждые 10 минут
    setInterval(syncTelegramOrders, 600000);

    // IPC handler для ручной синхронизации
    ipcMain.handle('telegram:sync', async () => {
      syncTelegramOrders();
      return { success: true };
    });
  } else {
    log('[TELEGRAM] Bot token не установлен в .env');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ============================================
// DATABASE (JSON)
// ============================================

// Миграция БД: конвертировать абсолютные пути в относительные (v0.8-architecture)
function migrateDatabasePaths() {
  log('[DB-MIGRATE] Проверка путей в БД...');

  let changed = false;

  // Конвертируем пути проектов
  if (db.projects) {
    for (const projectName in db.projects) {
      const project = db.projects[projectName];
      if (project.path && path.isAbsolute(project.path)) {
        const oldPath = project.path;
        project.path = makeRelativePath(oldPath);
        log(`[DB-MIGRATE] Project path converted: ${oldPath} → ${project.path}`);
        changed = true;
      }
    }
  }

  // Конвертируем пути файлов
  if (db.files && Array.isArray(db.files)) {
    for (const file of db.files) {
      if (file.fullPath && path.isAbsolute(file.fullPath)) {
        const oldPath = file.fullPath;
        file.fullPath = makeRelativePath(oldPath);
        log(`[DB-MIGRATE] File path converted: ${oldPath} → ${file.fullPath}`);
        changed = true;
      }
    }
  }

  if (changed) {
    log('[DB-MIGRATE] ✅ БД пути успешно конвертированы');
    return true;
  }

  log('[DB-MIGRATE] Пути уже в правильном формате (относительные)');
  return false;
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(data);

      // МИГРАЦИЯ v1: конвертировать старые категории (строки) в объекты
      if (db.categories && db.categories.length > 0 && typeof db.categories[0] === 'string') {
        log('[DB] Migrating categories from string format...');
        db.categories = db.categories.map((catName, idx) => ({
          id: `cat-${idx}`,
          name: catName,
          description: '',
          color: '#1688FF',
          icon: '🏷️',
        }));
      }

      // МИГРАЦИЯ v2: конвертировать links в category поле файлов
      if (db.links && db.links.length > 0) {
        log('[DB] Migrating links to file category field...');
        for (const link of db.links) {
          const file = db.files.find(f => f.project === link.project && f.name === link.file);
          if (file) {
            file.category = link.category;
            console.log(`  [MIGRATE] ${link.project}/${link.file} → ${link.category}`);
          }
        }
        delete db.links; // Удаляем старый формат после миграции
      }

      // МИГРАЦИЯ v3: конвертировать ID файлов (старый hash-based → новый name-based)
      if (db.files && db.files.length > 0) {
        const oldFiles = [...db.files];
        db.files = [];

        for (const oldFile of oldFiles) {
          // Проверяем нужна ли миграция ID (старый ID = projectName__hash)
          if (oldFile.id && oldFile.id.includes('__') && oldFile.id.split('__')[1].length === 32) {
            // Это старый hash-based ID, конвертируем
            const newId = `${oldFile.project}__${oldFile.name}`;
            oldFile.id = newId;
            console.log(`  [MIGRATE] ID: ${oldFile.project}__hash → ${newId}`);
          }

          // Добавляем новые поля если их нет
          if (!oldFile.contentHash) oldFile.contentHash = null;
          if (!oldFile.history) oldFile.history = [{ action: 'migrated', timestamp: new Date().toISOString() }];
          if (oldFile.deleted === undefined) oldFile.deleted = false;

          db.files.push(oldFile);
        }
      }

      // Инициализировать новые поля если их нет
      if (!db.files) db.files = [];
      if (!db.tags) db.tags = {};
      if (!db.relationships) db.relationships = {};

      // Миграция путей (v0.8-architecture)
      const pathsChanged = migrateDatabasePaths();
      if (pathsChanged) {
        saveDatabase('paths_migration_0.8');
      }

      log('[DB] Loaded and migrated');
    } else {
      db = {
        projects: {},
        files: [],
        categories: [
          {
            id: 'cat-1',
            name: 'Рабочий файл',
            description: 'Файлы в процессе разработки',
            color: '#1688FF',
            icon: '⭐',
          },
          {
            id: 'cat-2',
            name: 'Чертёж',
            description: 'Готовые чертежи',
            color: '#00FF00',
            icon: '📐',
          },
        ],
        tags: {},
        relationships: {},
      };
      saveDatabase();
    }
  } catch (err) {
    console.error('[DB] Load error:', err);
    db = {
      projects: {},
      files: [],
      categories: [
        {
          id: 'cat-1',
          name: 'Рабочий файл',
          description: 'Файлы в процессе разработки',
          color: '#1688FF',
          icon: '⭐',
        },
        {
          id: 'cat-2',
          name: 'Чертёж',
          description: 'Готовые чертежи',
          color: '#00FF00',
          icon: '📐',
        },
      ],
      tags: {},
      relationships: {},
    };
  }

  // МИГРАЦИЯ v0.8: Добавить правильную структуру thumbnail (индексация картинок)
  if (db && db.files) {
    const hasMigrated = migrateToV0_8();
    if (hasMigrated) {
      saveDatabase('v0.8-migration-thumbnail-structure');
    }
  }
}

function saveDatabase(reason = 'manual') {
  try {
    // Создаем backup перед сохранением (v0.8 requirement)
    const BACKUPS_PATH = path.join(DATA_PATH, 'backups');
    if (!fs.existsSync(BACKUPS_PATH)) {
      fs.mkdirSync(BACKUPS_PATH, { recursive: true });
    }

    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);

    const backupName = `auto_${timestamp}_${reason}.json`;
    const backupPath = path.join(BACKUPS_PATH, backupName);

    // Копируем текущий файл как backup
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, backupPath);
    }

    // Сохраняем новую версию
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    log(`[DB] ✅ Saved (${reason})`);
    log(`[BACKUP] 📦 ${backupName}`);

  } catch (err) {
    log(`[DB] ❌ Save error: ${err.message}`);
    throw err;
  }
}

// ============================================
// INDEXING
// ============================================

async function indexProjects() {
  if (!fs.existsSync(PROJECTS_PATH)) {
    console.log('[INDEX] Projects path not found');
    return;
  }

  const entries = fs.readdirSync(PROJECTS_PATH, { withFileTypes: true });
  db.projects = {};

  // НЕ стираем db.files! Только обновляем существующие и добавляем новые
  const existingFiles = db.files || [];
  db.files = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === 'Assignments') {
      continue;
    }

    const projectPath = path.join(PROJECTS_PATH, entry.name);
    const projectName = entry.name;

    const projectFiles = indexProjectFiles(projectPath, projectName, existingFiles);

    db.projects[projectName] = {
      id: projectName.toLowerCase().replace(/\s+/g, '-'),
      name: projectName,
      path: makeRelativePath(projectPath),
      description: '',
      created_at: new Date().toISOString(),
      fileCount: projectFiles.length,
    };

    db.files.push(...projectFiles);
    log('[INDEX] ' + projectName + ': ' + projectFiles.length + ' files');
  }

  // Отмечаем удаленные файлы (которые были в БД но исчезли с диска)
  for (const oldFile of existingFiles) {
    const stillExists = db.files.some(f => f.id === oldFile.id);
    if (!stillExists && !oldFile.deleted) {
      oldFile.deleted = true;
      oldFile.history.push({ action: 'deleted', timestamp: new Date().toISOString(), reason: 'not_found_on_disk' });
      db.files.push(oldFile);
      console.log(`[INDEX] Marked as deleted: ${oldFile.project}/${oldFile.name}`);
    }
  }

  saveDatabase();
  log('[INDEX] Total files indexed: ' + db.files.length);
}

function indexProjectFiles(projectPath, projectName, existingFiles) {
  const files = [];
  const newFilesList = [];

  function walkDir(dir, relDir = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = relDir ? path.join(relDir, entry.name) : entry.name;

        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else {
          // ❌ ИСКЛЮЧАЕМ BACKUP ФАЙЛЫ (ПРАВИЛО 10)
          const extLower = path.extname(entry.name).substring(1).toLowerCase();
          if (BACKUP_EXTENSIONS.includes(extLower) || entry.name.endsWith('~')) {
            console.log(`  [SKIP BACKUP] ${projectName}/${entry.name}`);
            continue;
          }

          try {
            const stat = fs.statSync(fullPath);
            const ext = path.extname(entry.name).substring(1).toUpperCase() || 'UNKNOWN';
            const fileName = entry.name;
            const fileSize = stat.size;
            const fileDate = new Date(stat.mtime).toLocaleString('ru-RU');

            // Считаем contentHash от содержимого файла (для отслеживания изменений)
            const fileContent = fs.readFileSync(fullPath);
            const contentHash = crypto.createHash('md5').update(fileContent).digest('hex');

            // ✅ ИСПРАВЛЕНО v0.8: ID теперь включает ПОЛНЫЙ ПУТЬ (для уникальности в разных папках)
            // Это позволяет иметь файлы с одинаковым именем в разных папках
            const newId = `${projectName}__${relPath}`;
            let existingFile = existingFiles.find(f => f.id === newId && f.project === projectName);

            let fileObj;
            if (existingFile) {
              // Файл уже был в БД - обновляем его
              fileObj = { ...existingFile };

              // Обнаруживаем изменения
              const contentChanged = fileObj.contentHash && fileObj.contentHash !== contentHash;
              if (contentChanged) {
                fileObj.history.push({
                  action: 'modified',
                  timestamp: new Date().toISOString(),
                  oldContentHash: fileObj.contentHash,
                  newContentHash: contentHash,
                  oldSize: fileObj.size,
                  newSize: fileSize,
                });
                console.log(`  [MODIFIED] ${projectName}/${fileName}`);
              }

              // Обновляем текущие данные
              fileObj.size = fileSize;
              fileObj.sizeFormatted = formatSize(fileSize);
              fileObj.modified_at = fileDate;
              fileObj.contentHash = contentHash;
            } else {
              // Это новый файл - создаем с нуля
              fileObj = {
                id: newId,
                project: projectName,
                name: fileName,
                ext: ext,
                path: relPath,
                fullPath: makeRelativePath(fullPath),
                size: fileSize,
                sizeFormatted: formatSize(fileSize),
                modified_at: fileDate,
                created_at: new Date().toISOString(),
                contentHash: contentHash,
                isDirectory: false,
                parent: relDir || null,

                // Организация
                category: null,
                description: '',
                tags: [],
                status: 'active',

                // Связи
                relatedFiles: [],
                basedOn: null,
                version: null,

                // Визуализация
                thumbnail: {
                  status: 'not_image',
                  previewPath: null,
                  thumbPath: null,
                  contentHash: null,
                  width: null,
                  height: null,
                  format: null,
                  indexedAt: null
                },
                preview: null,

                // Состояние
                deleted: false,
                notes: '',

                // История
                history: [{ action: 'created', timestamp: new Date().toISOString() }],
              };
              console.log(`  [NEW] ${projectName}/${fileName}`);
            }

            files.push(fileObj);
            newFilesList.push(newId);
          } catch (err) {
            console.error(`[INDEX] File stat error for ${fullPath}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error(`[INDEX] Walk error in ${dir}:`, err.message);
    }
  }

  walkDir(projectPath);

  // Проверяем переименования: ищем файлы которые исчезли но их contentHash существует
  for (const oldFile of existingFiles.filter(f => f.project === projectName)) {
    if (!newFilesList.includes(oldFile.id) && oldFile.contentHash) {
      // Файл с таким ID не найден, ищем его по contentHash (вероятно переименован)
      const renamedFile = files.find(f => f.contentHash === oldFile.contentHash && !files.some(x => x.id === oldFile.id));
      if (renamedFile) {
        console.log(`  [RENAMED] ${oldFile.project}/${oldFile.name} → ${renamedFile.name}`);
        renamedFile.history.push({
          action: 'renamed_detected',
          timestamp: new Date().toISOString(),
          oldName: oldFile.name,
          newName: renamedFile.name,
        });
        // Переносим все старые данные на новый файл
        renamedFile.category = oldFile.category;
        renamedFile.tags = oldFile.tags;
        renamedFile.description = oldFile.description;
        renamedFile.notes = oldFile.notes;
        renamedFile.history = [...oldFile.history, ...renamedFile.history];
      }
    }
  }

  // ============================================
  // ДЕТЕКТИРОВАНИЕ ДУБЛИКАТОВ ПО CONTENTHASH (v0.8)
  // ============================================

  const duplicateGroups = {};

  // Группируем файлы по contentHash
  files.forEach(file => {
    if (file.contentHash) {
      if (!duplicateGroups[file.contentHash]) {
        duplicateGroups[file.contentHash] = [];
      }
      duplicateGroups[file.contentHash].push(file);
    }
  });

  // Помечаем дубликаты
  let duplicateCount = 0;
  Object.entries(duplicateGroups).forEach(([hash, filesWithSameHash]) => {
    if (filesWithSameHash.length > 1) {
      // Это дубликаты!
      filesWithSameHash.forEach((file, idx) => {
        file.duplicateGroup = hash;
        file.isDuplicate = true;
        file.markedForDeletion = false;
        file.duplicateIndex = idx;

        // Сортируем по дате - самый старый first
        filesWithSameHash.sort((a, b) => {
          const dateA = new Date(a.modified_at).getTime();
          const dateB = new Date(b.modified_at).getTime();
          return dateA - dateB;
        });

        // Если это не последняя версия (не самая свежая) - помечаем как кандидат на удаление
        const isLatest = file === filesWithSameHash[filesWithSameHash.length - 1];
        file.isDuplicateOldVersion = !isLatest;
      });

      duplicateCount += filesWithSameHash.length;
      log(`[DUPLICATES] ⚠️ Найден дубликат (${filesWithSameHash.length} версий):`);
      filesWithSameHash.forEach((f, idx) => {
        const isLatest = f === filesWithSameHash[filesWithSameHash.length - 1];
        const marker = isLatest ? '✓ СВЕЖАЯ' : '❌ СТАРАЯ';
        log(`  ${marker}: ${f.project}/${f.path} (${new Date(f.modified_at).toLocaleString()})`);
      });
    }
  });

  if (duplicateCount > 0) {
    log(`[DUPLICATES] ⚠️ ИТОГО: найдено ${duplicateCount} файлов в ${Object.keys(duplicateGroups).filter(h => duplicateGroups[h].length > 1).length} группах дубликатов`);
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// ============================================
// ИНДЕКСАЦИЯ ПРЕВЬЮ ДЛЯ ВСЕХ ФАЙЛОВ (v0.8)
// ============================================

// ⚠️ ФАЙЛЫ КОТОРЫЕ WINDOWS НЕ МОЖЕТ ПРЕВЬЮИРОВАТЬ:
// (требуют установленные программы: SolidWorks, SketchUp, Rhino, CorelDraw)
const NO_PREVIEW_EXTENSIONS = ['sldprt', 'sldasm', 'skp', '3dm', 'cdr'];

function canIndexThumbnail(file) {
  if (!file || !file.ext) return false;
  const ext = file.ext.toLowerCase().replace(/^\./, '');
  // Windows НЕ может превьюировать эти форматы без установленных программ
  return !NO_PREVIEW_EXTENSIONS.includes(ext);
}

// ============================================
// РЕНДЕРИНГ 3D МОДЕЛЕЙ (STL, STEP, 3MF)
// ============================================

const STL_EXTENSIONS = ['stl'];
const STEP_EXTENSIONS = ['step', 'stp'];
const MODEL_3MF_EXTENSIONS = ['3mf'];

async function render3DModel(filePath, outputPath) {
  try {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    if (STL_EXTENSIONS.includes(ext)) {
      return await renderSTL(filePath, outputPath);
    } else if (STEP_EXTENSIONS.includes(ext)) {
      return await renderSTEP(filePath, outputPath);
    } else if (MODEL_3MF_EXTENSIONS.includes(ext)) {
      return await render3MF(filePath, outputPath);
    }

    return null;
  } catch (err) {
    log(`[3D] ⚠️ Ошибка рендеринга 3D: ${err.message}`);
    return null;
  }
}

async function renderSTL(filePath, outputPath) {
  try {
    const { createCanvas } = require('canvas');
    const THREE = require('three');
    const STLLoader = require('three-stl-loader')(THREE);

    const canvas = createCanvas(256, 256);
    const context = canvas.getContext('2d');

    // Загружаем STL файл
    const geometry = new THREE.BufferGeometry();
    const stlData = require('fs').readFileSync(filePath);

    // Простой парсинг STL (binary формат)
    const view = new DataView(stlData.buffer, stlData.byteOffset, stlData.byteLength);
    const triangles = view.getUint32(80, true);

    const vertices = [];
    let offset = 84;

    for (let i = 0; i < triangles; i++) {
      offset += 12; // пропускаем нормаль
      for (let j = 0; j < 3; j++) {
        vertices.push(view.getFloat32(offset, true));
        offset += 4;
        vertices.push(view.getFloat32(offset, true));
        offset += 4;
        vertices.push(view.getFloat32(offset, true));
        offset += 4;
      }
      offset += 2; // атрибут
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.computeVertexNormals();
    geometry.center();

    // Рисуем силуэт на canvas
    context.fillStyle = '#1a1a1a';
    context.fillRect(0, 0, 256, 256);
    context.strokeStyle = '#00ff00';
    context.lineWidth = 2;
    context.strokeRect(20, 20, 216, 216);

    context.fillStyle = '#00ff00';
    context.font = 'bold 16px Arial';
    context.fillText('STL', 110, 140);

    context.fillStyle = '#888';
    context.font = '12px Arial';
    context.fillText(`${(triangles)} triangles`, 60, 170);

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    require('fs').writeFileSync(outputPath, buffer);

    log(`[3D] ✅ STL рендер: ${path.basename(filePath)}`);
    return true;
  } catch (err) {
    log(`[3D] ⚠️ Ошибка STL: ${err.message}`);
    return false;
  }
}

async function renderSTEP(filePath, outputPath) {
  try {
    const { createCanvas } = require('canvas');

    const canvas = createCanvas(256, 256);
    const context = canvas.getContext('2d');

    // STEP файлы сложные - просто показываем логотип
    context.fillStyle = '#1a1a1a';
    context.fillRect(0, 0, 256, 256);
    context.strokeStyle = '#ff9800';
    context.lineWidth = 2;
    context.strokeRect(20, 20, 216, 216);

    context.fillStyle = '#ff9800';
    context.font = 'bold 16px Arial';
    context.fillText('STEP', 100, 140);

    context.fillStyle = '#888';
    context.font = '12px Arial';
    context.fillText('3D CAD Model', 90, 170);

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    require('fs').writeFileSync(outputPath, buffer);

    log(`[3D] ✅ STEP рендер: ${path.basename(filePath)}`);
    return true;
  } catch (err) {
    log(`[3D] ⚠️ Ошибка STEP: ${err.message}`);
    return false;
  }
}

async function render3MF(filePath, outputPath) {
  try {
    const { createCanvas } = require('canvas');
    const JSZip = require('jszip');
    const fs = require('fs');

    // 3MF это ZIP архив
    const buffer = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(buffer);

    // Проверяем есть ли модели внутри
    const modelFile = zip.file('3D/model.xml');
    if (!modelFile) {
      throw new Error('Model.xml not found in 3MF');
    }

    const canvas = createCanvas(256, 256);
    const context = canvas.getContext('2d');

    context.fillStyle = '#1a1a1a';
    context.fillRect(0, 0, 256, 256);
    context.strokeStyle = '#4caf50';
    context.lineWidth = 2;
    context.strokeRect(20, 20, 216, 216);

    context.fillStyle = '#4caf50';
    context.font = 'bold 16px Arial';
    context.fillText('3MF', 105, 140);

    context.fillStyle = '#888';
    context.font = '12px Arial';
    context.fillText('3D Print Model', 80, 170);

    const outBuffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    fs.writeFileSync(outputPath, outBuffer);

    log(`[3D] ✅ 3MF рендер: ${path.basename(filePath)}`);
    return true;
  } catch (err) {
    log(`[3D] ⚠️ Ошибка 3MF: ${err.message}`);
    return false;
  }
}

// ============================================
// ПОЛУЧЕНИЕ ПРЕВЬЮ ЧЕРЕЗ WINDOWS SHELL API
// ============================================

async function getWindowsShellThumbnail(filePath, outputPath) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');

    // PowerShell скрипт для вызова Windows Shell API
    const psScript = `
[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null

$file = Get-Item -LiteralPath '${filePath.replace(/'/g, "''")}'
$folder = $file.DirectoryName
$filename = $file.Name

$shell = New-Object -ComObject Shell.Application
$shellfolder = $shell.CreateShellFolderObject(0, $folder)
$shellfile = $shellfolder.ParseName($filename)

# Получаем превью через IExtractImage
$image = $shellfile.ExtendedProperty('System.ThumbnailCachePath')
if ($image) {
  Write-Output "CACHE:$image"
  exit 0
}

# Если нет в кэше - получаем иконку
$icon = $shellfile.ExtendedProperty('System.ItemTypeText')
Write-Output "ICON"
`.trim();

    const cmd = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;

    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      const result = stdout.trim();
      if (result.startsWith('CACHE:')) {
        const cachePath = result.substring(6);
        if (fs.existsSync(cachePath)) {
          try {
            fs.copyFileSync(cachePath, outputPath);
            resolve({ type: 'cached', path: outputPath });
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error('Cache file not found'));
        }
      } else {
        reject(new Error('No preview available'));
      }
    });
  });
}

async function indexAllThumbnails() {
  log('[THUMB] 🎬 НОВАЯ ИНДЕКСАЦИЯ: Windows Shell API для ВСЕХ форматов');
  const startTime = Date.now();

  try {
    if (!db || !db.files) {
      log('[THUMB] ❌ БД не загружена');
      return { success: false, error: 'БД не загружена' };
    }

    const totalFiles = db.files.length;
    let processedCount = 0;
    let thumbCount = 0;
    let iconCount = 0;
    let errorCount = 0;

    // Проходим по каждому файлу
    for (const file of db.files) {
      processedCount++;

      // Отправляем прогресс в UI
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('thumbnail-progress', {
          current: processedCount,
          total: totalFiles,
          fileName: file.name,
          status: 'processing'
        });
      }

      try {
        // Переводим относительный путь в абсолютный
        const absolutePath = makeAbsolutePath(file.fullPath);

        if (!fs.existsSync(absolutePath)) {
          file.icon = null;
          file.iconStatus = 'missing';
          continue;
        }

        // Определяем папку проекта
        const projectName = file.project || file.id.split('__')[0];
        const projectPath = path.join(ROOT_PATH, 'Проекты', projectName);
        const artelDir = path.join(projectPath, '.artel');
        const thumbDir = path.join(artelDir, 'thumbnails');

        // Создаем папку .artel/thumbnails если нет
        if (!fs.existsSync(artelDir)) {
          fs.mkdirSync(artelDir, { recursive: true });
        }
        if (!fs.existsSync(thumbDir)) {
          fs.mkdirSync(thumbDir, { recursive: true });
        }

        const thumbFileName = `${file.name}.thumb.jpg`;
        const thumbPath = path.join(thumbDir, thumbFileName);

        // 🎯 Сначала пробуем 3D модели (STL, STEP, 3MF)
        const ext = file.ext.toLowerCase().replace(/^\./, '');
        if ([...STL_EXTENSIONS, ...STEP_EXTENSIONS, ...MODEL_3MF_EXTENSIONS].includes(ext)) {
          const render3DSuccess = await render3DModel(absolutePath, thumbPath);
          if (render3DSuccess) {
            const relThumbPath = `.artel/thumbnails/${thumbFileName}`;
            file.icon = relThumbPath;
            file.iconStatus = '3d_model';
            thumbCount++;
            log(`[THUMB] ✅ 3D Model: ${file.name}`);
            continue;
          }
        }

        // Пытаемся получить превью через Windows Shell API
        if (canIndexThumbnail(file)) {
          try {
            await getWindowsShellThumbnail(absolutePath, thumbPath);
            const relThumbPath = `.artel/thumbnails/${thumbFileName}`;
            file.icon = relThumbPath;
            file.iconStatus = 'shell_preview';
            thumbCount++;
            log(`[THUMB] ✅ Shell Preview: ${file.name}`);
          } catch (shellErr) {
            // Shell превью не сработало - используем Windows иконку
            try {
              const icon = await app.getFileIcon(absolutePath, { size: 'small' });
              const iconPath = path.join(CACHE_PATH, 'icons', `${crypto.createHash('md5').update(absolutePath).digest('hex')}.png`);

              if (!fs.existsSync(path.dirname(iconPath))) {
                fs.mkdirSync(path.dirname(iconPath), { recursive: true });
              }

              fs.writeFileSync(iconPath, icon.toPNG());

              const relIconPath = `../../cache/icons/${path.basename(iconPath)}`;
              file.icon = relIconPath;
              file.iconStatus = 'icon_cached';
              iconCount++;
              log(`[THUMB] 🏷️ Windows Icon: ${file.name}`);
            } catch (iconErr) {
              log(`[THUMB] ⚠️ Ошибка: ${file.name} - ${iconErr.message}`);
              file.icon = null;
              file.iconStatus = 'no_preview';
              errorCount++;
            }
          }
        } else {
          log(`[THUMB] ⏭️ Пропущен (нет превью): ${file.name}`);
          file.icon = null;
          file.iconStatus = 'no_preview_available';
        }
      } catch (err) {
        log(`[THUMB] ❌ Ошибка обработки ${file.name}: ${err.message}`);
        file.icon = null;
        file.iconStatus = 'error';
        errorCount++;
      }
    }

    // Сохраняем обновленную БД
    await saveDatabase('indexAllThumbnails');

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = `[THUMB] ✅ ЗАВЕРШЕНО: ${thumbCount} (3D + Shell) + ${iconCount} Icons, ошибок: ${errorCount}, время: ${duration}s`;
    log(summary);

    return {
      success: true,
      totalFiles,
      thumbnails: thumbCount,
      icons: iconCount,
      errors: errorCount,
      duration
    };
  } catch (err) {
    log(`[THUMB] ❌ КРИТИЧЕСКАЯ ОШИБКА: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ============================================
// IPC HANDLERS
// ============================================

ipcMain.handle('api:getData', async () => {
  try {
    const projectsList = Object.values(db.projects).map(p => ({
      id: p.id,
      name: p.name,
      path: p.path,
      fileCount: p.fileCount || 0,
    }));

    return {
      projects: projectsList,
      categories: db.categories || [],
      orders: db.orders || [],
      stats: {
        totalFiles: db.files.length,
        totalProjects: Object.keys(db.projects).length,
      },
    };
  } catch (err) {
    console.error('[API] getData error:', err);
    return { projects: [], categories: [], orders: [], stats: {} };
  }
});

ipcMain.handle('api:getProjectFiles', async (_, projectName) => {
  try {
    const files = db.files.filter(f => f.project === projectName);
    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('[API] getProjectFiles error:', err);
    return [];
  }
});

ipcMain.handle('api:addCategory', async (_, categoryName) => {
  try {
    const exists = db.categories.some(c => c.name === categoryName);
    if (!exists) {
      const newCategory = {
        id: `cat-${Date.now()}`,
        name: categoryName,
        description: '',
        color: '#1688FF',
        icon: '🏷️',
      };
      db.categories.push(newCategory);
      saveDatabase();
    }
    return db.categories;
  } catch (err) {
    console.error('[API] addCategory error:', err);
    return db.categories;
  }
});

ipcMain.handle('api:linkFile', async (_, { fileId, categoryName }) => {
  try {
    const file = db.files.find(f => f.id === fileId);
    if (!file) return { success: false, error: 'File not found' };

    file.category = categoryName;
    saveDatabase();
    return { success: true };
  } catch (err) {
    console.error('[API] linkFile error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('api:refreshProjects', async () => {
  console.log('[REFRESH] Rescanning...');
  await indexProjects();
  mainWindow.webContents.send('projects-refreshed');
  return { success: true };
});

ipcMain.handle('api:addProject', async (_, { name, folderPath }) => {
  try {
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Папка не найдена' };
    }

    if (db.projects[name]) {
      return { success: false, error: 'Проект с таким именем уже существует' };
    }

    const projectFiles = indexProjectFiles(folderPath, name);
    db.projects[name] = {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      path: makeRelativePath(folderPath),
      description: '',
      created_at: new Date().toISOString(),
      fileCount: projectFiles.length,
    };

    db.files.push(...projectFiles);
    saveDatabase();
    console.log(`[PROJECT] Added: ${name} with ${projectFiles.length} files`);
    return { success: true };
  } catch (err) {
    console.error('[API] addProject error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('api:openFile', async (_, filePath) => {
  const absolutePath = makeAbsolutePath(filePath);
  shell.openPath(absolutePath);
});

ipcMain.handle('api:getThumbnail', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cachePath = path.join(CACHE_PATH, `${fileHash}.jpg`);

    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      try {
        await sharp(absolutePath)
          .resize(120, 120, { fit: 'cover', position: 'center' })
          .toFile(cachePath);
        return `file://${cachePath}`;
      } catch {
        return null;
      }
    }

    return null;
  } catch (err) {
    console.error('[THUMBNAIL] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getFileIcon', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cacheDir = path.join(CACHE_PATH, 'icons');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${fileHash}.png`);

    // Если иконка уже в кэше - возвращаем её
    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    // Получаем иконку из Windows API через Electron
    try {
      const icon = await app.getFileIcon(absolutePath, { size: 'large' });
      if (icon) {
        // Сохраняем иконку в кэш
        const iconData = icon.toPNG();
        fs.writeFileSync(cachePath, iconData);
        console.log(`[ICON] Cached: ${path.basename(absolutePath)}`);
        return `file://${cachePath}`;
      }
    } catch (err) {
      console.error(`[ICON] Error getting icon for ${absolutePath}:`, err.message);
    }

    return null;
  } catch (err) {
    console.error('[ICON] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getEmbeddedThumbnail', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cacheDir = path.join(CACHE_PATH, 'thumbnails');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${fileHash}.jpg`);

    // Если превью уже в кэше - возвращаем его
    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    const ext = path.extname(absolutePath).toLowerCase();

    // Для изображений используем sharp
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      try {
        await sharp(absolutePath)
          .resize(200, 200, { fit: 'cover', position: 'center' })
          .toFile(cachePath);
        console.log(`[THUMBNAIL] ✅ Generated image preview: ${path.basename(filePath)}`);
        return `file://${cachePath}`;
      } catch (err) {
        console.error(`[THUMBNAIL] Sharp error: ${err.message}`);
        return null;
      }
    }

    // Для SolidWorks файлов - извлекаем встроенное превью из ZIP
    if (['.sldprt', '.sldasm', '.slddrw'].includes(ext)) {
      try {
        const fileData = await fs.promises.readFile(absolutePath);
        const zip = await JSZip.loadAsync(fileData);

        // Ищем файлы превью в любой папке
        const previewFiles = Object.keys(zip.files).filter(f =>
          /preview.*\.(jpg|jpeg|png)$/i.test(f) && !zip.files[f].dir
        );

        if (previewFiles.length > 0) {
          const previewData = await zip.file(previewFiles[0]).async('nodebuffer');
          await sharp(previewData)
            .resize(200, 200, { fit: 'cover', position: 'center' })
            .toFile(cachePath);
          console.log(`[THUMBNAIL] ✅ Extracted SolidWorks preview: ${path.basename(absolutePath)}`);
          return `file://${cachePath}`;
        }
      } catch (err) {
        console.error(`[THUMBNAIL] SolidWorks extract error: ${err.message}`);
      }
    }

    // Для Rhino файлов - извлекаем превью
    if (ext === '.3dm') {
      try {
        const fileData = await fs.promises.readFile(absolutePath);
        const zip = await JSZip.loadAsync(fileData);

        const previewFile = zip.file('preview.jpg') || zip.file('thumbnail.jpg');
        if (previewFile) {
          const imageData = await previewFile.async('nodebuffer');
          await sharp(imageData)
            .resize(200, 200, { fit: 'cover', position: 'center' })
            .toFile(cachePath);
          console.log(`[THUMBNAIL] ✅ Extracted Rhino preview: ${path.basename(absolutePath)}`);
          return `file://${cachePath}`;
        }
      } catch (err) {
        console.error(`[THUMBNAIL] Rhino extract error: ${err.message}`);
      }
    }

    return null;
  } catch (err) {
    console.error('[EMBEDDED THUMBNAIL] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getViewerData', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return { type: 'error', error: 'File not found' };

    const ext = path.extname(absolutePath).toLowerCase();
    const fileName = path.basename(absolutePath);

    // PDF файлы - возвращаем информацию для встроенного viewer
    if (ext === '.pdf') {
      return { type: 'pdf', filePath: absolutePath, fileName };
    }

    // DXF/DWG файлы - возвращаем информацию для three.js viewer
    if (['.dxf', '.dwg'].includes(ext)) {
      return { type: '3d', filePath: absolutePath, ext, fileName, subtype: 'dxf' };
    }

    // 3D файлы - возвращаем информацию для three.js viewer
    if (['.stl', '.obj', '.glb', '.gltf', '.fbx', '.ply'].includes(ext)) {
      return { type: '3d', filePath: absolutePath, ext, fileName };
    }

    // STL и OBJ файлы можно просмотреть
    return { type: 'unknown', ext };
  } catch (err) {
    console.error('[VIEWER] Error:', err);
    return { type: 'error', error: err.message };
  }
});

ipcMain.handle('api:getWindowsPreview', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cacheDir = path.join(CACHE_PATH, 'windows-previews');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${fileHash}.png`);

    // Если превью уже в кэше - возвращаем его
    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    // Используем встроенный Electron API для получения превью
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(
        absolutePath,
        { width: 256, height: 256 }
      );

      if (thumbnail && !thumbnail.isEmpty()) {
        // Сохраняем в кэш
        fs.writeFileSync(cachePath, thumbnail.toPNG());
        console.log(`[WINDOWS PREVIEW] ✅ Generated: ${path.basename(absolutePath)}`);
        return `file://${cachePath}`;
      }
    } catch (err) {
      console.error(`[WINDOWS PREVIEW] nativeImage error: ${err.message}`);
    }

    return null;
  } catch (err) {
    console.error('[WINDOWS PREVIEW] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getPDFPath', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;
    return `file:///${absolutePath.replace(/\\/g, '/')}`;
  } catch (err) {
    console.error('[PDF PATH] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getImageAsDataURL', async (_, filePath) => {
  try {
    const absolutePath = makeAbsolutePath(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    const ext = path.extname(absolutePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      return null;
    }

    const fileData = fs.readFileSync(absolutePath);
    const base64 = fileData.toString('base64');

    // Определяем MIME type
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    };

    const mimeType = mimeTypes[ext] || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    console.log(`[IMAGE DATA] ✅ Loaded: ${path.basename(filePath)}`);
    return dataUrl;
  } catch (err) {
    console.error('[IMAGE DATA] Error:', err);
    return null;
  }
});

ipcMain.handle('api:showContextMenu', async (_, filePath) => {
  const absolutePath = makeAbsolutePath(filePath);
  const template = [
    { label: 'Открыть', click: () => shell.openPath(absolutePath) },
    { type: 'separator' },
    { label: 'Показать в проводнике', click: () => shell.showItemInFolder(absolutePath) },
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow });
});

ipcMain.handle('api:renameFile', async (_, { fileId, newName }) => {
  try {
    const file = db.files.find(f => f.id === fileId);
    if (!file) return { success: false, error: 'File not found' };

    // Проверяем что новое имя не пусто и не содержит недопустимых символов
    if (!newName || newName.trim().length === 0) {
      return { success: false, error: 'File name cannot be empty' };
    }
    newName = newName.trim();

    // Проверяем что файл с таким именем еще не существует в этом проекте
    if (db.files.some(f => f.project === file.project && f.name === newName && f.id !== fileId)) {
      return { success: false, error: 'File with this name already exists' };
    }

    const oldName = file.name;
    const oldRelPath = file.fullPath;
    const oldAbsPath = makeAbsolutePath(oldRelPath);
    const absDir = path.dirname(oldAbsPath);
    const newAbsPath = path.join(absDir, newName);
    const newRelPath = makeRelativePath(newAbsPath);

    // Переименовываем файл на диске
    try {
      fs.renameSync(oldAbsPath, newAbsPath);
    } catch (err) {
      return { success: false, error: `Failed to rename file: ${err.message}` };
    }

    // Обновляем в БД
    const oldId = file.id;
    const newId = `${file.project}__${newName}`;

    file.name = newName;
    file.id = newId;
    file.fullPath = newRelPath;
    file.path = file.path ? path.dirname(file.path) === '.' ? newName : path.join(path.dirname(file.path), newName) : newName;
    file.history.push({
      action: 'renamed',
      timestamp: new Date().toISOString(),
      oldName: oldName,
      newName: newName,
      oldId: oldId,
      newId: newId,
    });

    saveDatabase();
    console.log(`[RENAME] ${file.project}/${oldName} → ${newName}`);
    return { success: true, newFileId: newId };
  } catch (err) {
    console.error('[API] renameFile error:', err);
    return { success: false, error: err.message };
  }
});

// ============================================
// TELEGRAM BOT - НОВЫЕ ЗАКАЗЫ
// ============================================

ipcMain.handle('telegram:newOrder', async (_, order) => {
  try {
    console.log('[TELEGRAM] Новый заказ:', order.title);

    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const newOrder = {
      id: orderId,
      title: order.title || 'Без названия',
      description: order.description || '',
      photos: order.photos || [],
      comments: order.comments || [],
      author: order.author || 'Неизвестный',
      createdAt: new Date().toISOString(),
      category: null,
      deadline: null,
      assignee: null,
      status: 'новый',
      history: [{ action: 'created', timestamp: new Date().toISOString(), author: order.author || 'bot' }]
    };

    if (!db.orders) db.orders = [];
    db.orders.push(newOrder);
    saveDatabase();

    console.log('[TELEGRAM] Заказ сохранён:', orderId);
    if (mainWindow) mainWindow.webContents.send('new-order', newOrder);

    return { success: true, orderId };
  } catch (err) {
    console.error('[TELEGRAM] Ошибка:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('telegram:getOrders', async () => {
  try {
    return db.orders || [];
  } catch (err) {
    console.error('[TELEGRAM] getOrders error:', err);
    return [];
  }
});

// ============================================
// DATABASE SAVE (для БД редактора)
// ============================================

ipcMain.handle('saveDatabase', async () => {
  try {
    saveDatabase('api:saveDatabase');
    log('[DB] 🔄 Database saved via API');
    return { success: true };
  } catch (err) {
    log(`[DB] ❌ Save error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ============================================
// ИНДЕКСАЦИЯ ПРЕВЬЮ ВСЕХ ФАЙЛОВ
// ============================================

ipcMain.handle('api:indexAllThumbnails', async () => {
  return await indexAllThumbnails();
});
