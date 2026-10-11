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

// Пути
const APP_PATH = __dirname;
const DATA_PATH = path.join(APP_PATH, 'data');
const DB_FILE = path.join(DATA_PATH, 'artel.json');

// Загрузить config.local.json если существует
let CONFIG = {};
const CONFIG_FILE = path.join(APP_PATH, 'config.local.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    log('[CONFIG] Loaded config.local.json');
  } catch (e) {
    log('[CONFIG] Error loading config.local.json: ' + e.message);
  }
}

// ARTELL_PATH - корневая папка "Артель" (может быть на любом диске)
const ARTEL_PATH = CONFIG.artellPath || path.join(APP_PATH, '..', 'Артель');
const PROJECTS_PATH = path.join(ARTEL_PATH, 'Проекты');

log('[CONFIG] ARTEL_PATH: ' + ARTEL_PATH);
log('[CONFIG] PROJECTS_PATH: ' + PROJECTS_PATH);
const CACHE_PATH = path.join(APP_PATH, 'cache');

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

  log('[APP] Loading database...');
  loadDatabase();
  log('[APP] Indexing projects...');
  await indexProjects();
  log('[APP] Creating window...');
  createWindow();

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
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log('[DB] Saved');
  } catch (err) {
    console.error('[DB] Save error:', err);
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
      path: projectPath,
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
          try {
            const stat = fs.statSync(fullPath);
            const ext = path.extname(entry.name).substring(1).toUpperCase() || 'UNKNOWN';
            const fileName = entry.name;
            const fileSize = stat.size;
            const fileDate = new Date(stat.mtime).toLocaleString('ru-RU');

            // Считаем contentHash от содержимого файла (для отслеживания изменений)
            const fileContent = fs.readFileSync(fullPath);
            const contentHash = crypto.createHash('md5').update(fileContent).digest('hex');

            // КРИТИЧЕСКИЙ МОМЕНТ: ищем файл по ИМЕНИ в БД, а не по хешу!
            const newId = `${projectName}__${fileName}`;
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
                fullPath: fullPath,
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
                thumbnail: null,
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
// IPC HANDLERS
// ============================================

ipcMain.handle('api:getConfig', async () => {
  return {
    artellPath: ARTEL_PATH,
    projectsPath: PROJECTS_PATH,
  };
});

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
      path: folderPath,
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
  shell.openPath(filePath);
});

ipcMain.handle('api:getThumbnail', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cachePath = path.join(CACHE_PATH, `${fileHash}.jpg`);

    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      try {
        await sharp(filePath)
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
    if (!fs.existsSync(filePath)) return null;

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
      const icon = await app.getFileIcon(filePath, { size: 'large' });
      if (icon) {
        // Сохраняем иконку в кэш
        const iconData = icon.toPNG();
        fs.writeFileSync(cachePath, iconData);
        console.log(`[ICON] Cached: ${path.basename(filePath)}`);
        return `file://${cachePath}`;
      }
    } catch (err) {
      console.error(`[ICON] Error getting icon for ${filePath}:`, err.message);
    }

    return null;
  } catch (err) {
    console.error('[ICON] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getEmbeddedThumbnail', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
    const cacheDir = path.join(CACHE_PATH, 'thumbnails');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${fileHash}.jpg`);

    // Если превью уже в кэше - возвращаем его
    if (fs.existsSync(cachePath)) {
      return `file://${cachePath}`;
    }

    const ext = path.extname(filePath).toLowerCase();

    // Для изображений используем sharp
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      try {
        await sharp(filePath)
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
        const fileData = await fs.promises.readFile(filePath);
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
          console.log(`[THUMBNAIL] ✅ Extracted SolidWorks preview: ${path.basename(filePath)}`);
          return `file://${cachePath}`;
        }
      } catch (err) {
        console.error(`[THUMBNAIL] SolidWorks extract error: ${err.message}`);
      }
    }

    // Для Rhino файлов - извлекаем превью
    if (ext === '.3dm') {
      try {
        const fileData = await fs.promises.readFile(filePath);
        const zip = await JSZip.loadAsync(fileData);
        
        const previewFile = zip.file('preview.jpg') || zip.file('thumbnail.jpg');
        if (previewFile) {
          const imageData = await previewFile.async('nodebuffer');
          await sharp(imageData)
            .resize(200, 200, { fit: 'cover', position: 'center' })
            .toFile(cachePath);
          console.log(`[THUMBNAIL] ✅ Extracted Rhino preview: ${path.basename(filePath)}`);
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
    if (!fs.existsSync(filePath)) return { type: 'error', error: 'File not found' };

    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    // PDF файлы - возвращаем информацию для встроенного viewer
    if (ext === '.pdf') {
      return { type: 'pdf', filePath, fileName };
    }

    // DXF/DWG файлы - возвращаем информацию для three.js viewer
    if (['.dxf', '.dwg'].includes(ext)) {
      return { type: '3d', filePath, ext, fileName, subtype: 'dxf' };
    }

    // 3D файлы - возвращаем информацию для three.js viewer
    if (['.stl', '.obj', '.glb', '.gltf', '.fbx', '.ply'].includes(ext)) {
      return { type: '3d', filePath, ext, fileName };
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
    if (!fs.existsSync(filePath)) return null;

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
        filePath,
        { width: 256, height: 256 }
      );

      if (thumbnail && !thumbnail.isEmpty()) {
        // Сохраняем в кэш
        fs.writeFileSync(cachePath, thumbnail.toPNG());
        console.log(`[WINDOWS PREVIEW] ✅ Generated: ${path.basename(filePath)}`);
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
    if (!fs.existsSync(filePath)) return null;
    return `file:///${filePath.replace(/\\/g, '/')}`;
  } catch (err) {
    console.error('[PDF PATH] Error:', err);
    return null;
  }
});

ipcMain.handle('api:getImageAsDataURL', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      return null;
    }

    const fileData = fs.readFileSync(filePath);
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
  const template = [
    { label: 'Открыть', click: () => shell.openPath(filePath) },
    { type: 'separator' },
    { label: 'Показать в проводнике', click: () => shell.showItemInFolder(filePath) },
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
    const oldPath = file.fullPath;
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);

    // Переименовываем файл на диске
    try {
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      return { success: false, error: `Failed to rename file: ${err.message}` };
    }

    // Обновляем в БД
    const oldId = file.id;
    const newId = `${file.project}__${newName}`;

    file.name = newName;
    file.id = newId;
    file.fullPath = newPath;
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
