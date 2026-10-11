let appState = {
  currentProject: null,
  projects: [],
  categories: [],
  allFiles: [],
  filesSortColumn: 'name',
  filesSortOrder: 'asc',
  filesExtFilter: '',
  selectedProjectFiles: new Set(),
  viewMode: 'table',  // 'table' или 'gallery'
  iconSize: 120,      // размер иконок в пиксилях (60-300)
  orders: []          // заказы из Telegram
};

// LOGS
const logs = [];

function toggleLogsPanel() {
  const panel = document.getElementById('logs-panel');
  panel.classList.toggle('open');
}

function clearLogs() {
  logs.length = 0;
  document.getElementById('logs-content').innerHTML = '';
}

function addLog(logEntry) {
  logs.push(logEntry);
  if (logs.length > 200) logs.shift();

  const content = document.getElementById('logs-content');
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  // Определяем тип сообщения по содержимому
  if (logEntry.msg.includes('[TELEGRAM]')) entry.classList.add('telegram');
  if (logEntry.msg.includes('[SYNC]')) entry.classList.add('sync');
  if (logEntry.msg.includes('❌') || logEntry.msg.includes('error')) entry.classList.add('error');

  entry.innerHTML = `<span class="log-timestamp">${logEntry.timestamp.substring(11, 19)}</span> <span class="log-message">${logEntry.msg}</span>`;
  content.appendChild(entry);
  content.scrollTop = content.scrollHeight;
}

// Слушаем логи от main process
if (window.api && window.api.onLog) {
  window.api.onLog((logEntry) => {
    addLog(logEntry);
  });
}

// ORDERS FROM TELEGRAM
function switchTab(tabName) {
  // Скрываем все вкладки
  document.getElementById('dashboard-tab').style.display = 'none';
  document.getElementById('files-tab').style.display = 'none';
  document.getElementById('orders-tab').style.display = 'none';
  document.getElementById('database-tab').style.display = 'none';
  document.getElementById('about-tab').style.display = 'none';

  // Показываем выбранную вкладку
  if (tabName === 'dashboard') {
    document.getElementById('dashboard-tab').style.display = 'block';
    loadDashboard(); // Загружаем dashboard
  } else if (tabName === 'files') {
    document.getElementById('files-tab').style.display = 'grid';
  } else if (tabName === 'orders') {
    document.getElementById('orders-tab').style.display = 'flex';
  } else if (tabName === 'database') {
    document.getElementById('database-tab').style.display = 'flex';
    loadDatabaseEditor(); // Загружаем данные БД
  } else if (tabName === 'about') {
    document.getElementById('about-tab').style.display = 'block';
    loadAboutPage(); // Загружаем страницу о проекте
  }

  // Обновляем кнопки
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`button[onclick="switchTab('${tabName}')"]`).classList.add('active');
}

function renderOrders() {
  const list = document.getElementById('orders-list');
  const count = document.getElementById('orders-count');

  if (appState.orders.length === 0) {
    list.innerHTML = '<div class="loading">Нет заказов</div>';
    count.textContent = '0';
    return;
  }

  count.textContent = appState.orders.length;
  list.innerHTML = appState.orders.map((order, idx) => `
    <div class="order-card">
      <div class="order-title">${order.title || 'Без названия'}</div>
      <div class="order-meta">
        <span>👤 ${order.author || 'Неизвестный'}</span>
        <span>🕐 ${new Date(order.createdAt).toLocaleString('ru-RU')}</span>
        ${order.photos && order.photos.length > 0 ? `<span>📷 ${order.photos.length} фото</span>` : ''}
      </div>
      ${order.description ? `<div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px;">${order.description}</div>` : ''}
      ${order.photos && order.photos.length > 0 ? `
        <div class="order-photos">
          ${order.photos.map((photo, pIdx) => {
            if (!photo.localPath) return '';  // Если нет localPath - пропускаем
            const pathForUrl = photo.localPath.replace(/\\\\/g, '/');
            return `<img src="file:///${pathForUrl}" alt="Фото ${pIdx + 1}" class="order-photo" onclick="openPhotoViewer('${photo.localPath}', '${order.title}')" style="cursor: pointer; border-radius: 4px;" />`;
          }).join('')}
        </div>
      ` : ''}
      <div class="order-actions">
        <button class="btn-action" onclick="createTaskFromOrder(${idx})">✓ Создать задачу</button>
        <button class="btn-action" onclick="deleteOrder(${idx})">✕ Удалить</button>
      </div>
    </div>
  `).join('');
}

function addOrderFromTelegram(order) {
  appState.orders.unshift(order);
  renderOrders();
}

async function syncTelegramOrders() {
  const syncBtn = document.getElementById('sync-btn');
  syncBtn.disabled = true;
  syncBtn.textContent = '⏳ Синхронизация...';

  try {
    const result = await window.api.telegramSync();
    if (result && result.success) {
      addLog({
        timestamp: new Date().toISOString(),
        msg: `[SYNC] Синхронизация завершена, добавлено: ${result.added}`
      });
    }
  } catch (err) {
    addLog({
      timestamp: new Date().toISOString(),
      msg: `[ERROR] Ошибка синхронизации: ${err.message}`
    });
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = '🔄 Синхронизировать';
  }
}

function deleteOrder(idx) {
  appState.orders.splice(idx, 1);
  renderOrders();
}

function createTaskFromOrder(idx) {
  const order = appState.orders[idx];
  alert('✓ Задача будет создана из заказа: ' + order.title + '\n\n(Функция будет добавлена позже)');
}

function openPhotoViewer(photoPath, orderTitle) {
  const viewer = document.getElementById('modal-image-viewer');
  const img = document.getElementById('image-viewer-img');
  const name = document.getElementById('image-viewer-name');

  const pathForUrl = photoPath.replace(/\\\\/g, '/');
  img.src = 'file:///' + pathForUrl;
  name.textContent = orderTitle;
  viewer.style.display = 'flex';
}

// Слушаем новые заказы из Telegram
if (window.api && window.api.onNewOrderTelegram) {
  window.api.onNewOrderTelegram((order) => {
    addOrderFromTelegram(order);
  });
}

async function init() {
  try {
    const data = await window.api.getData();
    appState.projects = data.projects || [];
    appState.categories = data.categories || [];
    appState.orders = data.orders || [];
    renderOrders();
    renderProjectDropdown();
    renderProjects();
    if (appState.projects.length > 0) {
      selectProject(appState.projects[0].name);
    }
    switchTab('dashboard');
  } catch (err) {
    console.error('Init error:', err);
  }
}

function renderProjectDropdown() {
  const select = document.getElementById('project-select');
  select.innerHTML = '<option value="">Выберите проект...</option>' +
    appState.projects.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  if (appState.currentProject) {
    select.value = appState.currentProject;
  }
}

function renderProjects() {
  const list = document.getElementById('projects-list');
  if (appState.projects.length === 0) {
    list.innerHTML = '<div class="loading">Нет проектов</div>';
    return;
  }
  list.innerHTML = appState.projects.map(p => `
    <div class="project-item ${appState.currentProject === p.name ? 'active' : ''}" onclick="selectProject('${p.name}')">
      <div>${p.name}</div>
      <div class="project-count">${p.fileCount} файлов</div>
    </div>
  `).join('');
}

function selectProjectByDropdown() {
  const select = document.getElementById('project-select');
  if (select.value) {
    selectProject(select.value);
  }
}

async function selectProject(projectName) {
  appState.currentProject = projectName;
  appState.selectedProjectFiles.clear();
  appState.filesExtFilter = '';
  renderProjectDropdown();
  renderProjects();

  // 🔄 ВСЕГДА ПЕРЕЗАГРУЖАЕМ КАТЕГОРИИ ИЗ БД (важно для новых категорий!)
  const data = await window.api.getData();
  appState.categories = data.categories || [];

  const files = await window.api.getProjectFiles(projectName);
  appState.allFiles = files || [];
  dbState.allFiles = [...appState.allFiles]; // Синхронизируем с БД редактором
  renderCategories();
  renderFiles();
  updateExtensionFilter();
}

// ✅ РЕШЕНИЕ ПРОБЛЕМЫ: Перезагрузить БД с диска
async function refreshDatabase() {
  try {
    const data = await window.api.getData();
    appState.projects = data.projects || [];
    appState.categories = data.categories || [];
    appState.allFiles = [];
    dbState.allFiles = [];

    // Перезагружаем текущий проект
    if (appState.currentProject) {
      await selectProject(appState.currentProject);
    }

    alert('✅ БД обновлена! Данные перезагружены с диска.');
  } catch (err) {
    alert('❌ Ошибка при обновлении БД: ' + err.message);
    console.error(err);
  }
}

function renderCategories() {
  const list = document.getElementById('categories-list');
  if (!appState.currentProject) {
    list.innerHTML = '<div class="loading">Выберите проект</div>';
    return;
  }
  if (appState.categories.length === 0) {
    list.innerHTML = '<div class="loading">Нет категорий</div>';
    return;
  }

  let html = '';
  appState.categories.forEach(category => {
    const categoryName = typeof category === 'string' ? category : category.name;
    const categoryObj = typeof category === 'object' ? category : { name: category, icon: '🏷️' };
    const categoryFiles = appState.allFiles.filter(f => f.category === categoryName);
    const fileCount = categoryFiles.length;
    const categoryIcon = categoryObj.icon || '🏷️';

    // ✅ ПРАВИЛО: "Рабочий файл" ВСЕГДА видна, остальные ТОЛЬКО если есть файлы
    if (categoryName !== 'Рабочий файл' && fileCount === 0) return;

    html += `<div class="category-section">
      <div class="category-title">${categoryIcon} ${categoryName} [${fileCount}]</div>`;

    if (fileCount > 0) {
      let sorted = [...categoryFiles].sort((a, b) => a.name.localeCompare(b.name));
      html += `<table class="files-table"><thead><tr>
        <th style="width: 20px;"><input type="checkbox"></th>
        <th style="width: 30px;"></th>
        <th>ИМЯ</th>
        <th>ТИП</th>
        <th>РАЗМЕР</th>
        <th>ИЗМЕНЕНО</th>
        <th style="width: 100px;">ДЕЙСТВИЯ</th>
      </tr></thead><tbody>
        ${sorted.map(file => `<tr>
          <td><input type="checkbox"></td>
          <td style="text-align: center;"><button class="btn-file" onclick="previewFileFromTable('${file.fullPath}', '${file.name}')" title="Просмотр">👁️</button></td>
          <td class="file-name" title="${file.name}">${file.name}</td>
          <td><span class="file-ext">${file.ext}</span>${file.isDuplicateOldVersion ? ' ❌' : ''}</td>
          <td>${file.sizeFormatted}</td>
          <td>${file.modified_at}</td>
          <td class="file-actions">
            <button class="btn-file" onclick="openFile('${file.fullPath}')">📂</button>
            <button class="btn-file" onclick="renameFileModal('${file.id}', '${file.name}')">✎</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;
    } else {
      html += '<div class="loading">Нет файлов в категории</div>';
    }
    html += '</div>';
  });

  list.innerHTML = html;
}

function renderFiles() {
  const list = document.getElementById('files-list');
  if (!appState.currentProject) {
    list.innerHTML = '<div class="loading">Выберите проект</div>';
    return;
  }

  // ✅ v0.8: ТОЛЬКО файлы БЕЗ категории (включая дубликаты с пометкой ❌)
  let filteredFiles = appState.allFiles.filter(f => !f.category);

  if (appState.filesExtFilter) {
    filteredFiles = filteredFiles.filter(f => f.ext === appState.filesExtFilter);
  }

  filteredFiles.sort((a, b) => {
    if (appState.filesSortOrder === 'desc') {
      return b.name.localeCompare(a.name);
    }
    return a.name.localeCompare(b.name);
  });

  const count = document.getElementById('file-count');
  count.textContent = `(${filteredFiles.length})`;

  if (filteredFiles.length === 0) {
    list.innerHTML = '<div class="loading">Все файлы распределены по категориям</div>';
    return;
  }

  // ВЫБИРАЕМ РЕЖИМ: ТАБЛИЦА ИЛИ ГАЛЕРЕЯ
  if (appState.viewMode === 'gallery') {
    renderGallery(list, filteredFiles);
  } else {
    renderTable(list, filteredFiles);
  }

  updateAssignButton();
}

function renderTable(list, filteredFiles) {
  const allChecked = filteredFiles.length > 0 && filteredFiles.every(f => appState.selectedProjectFiles.has(f.id));

  const html = `<table class="files-table"><thead><tr>
    <th style="width: 20px;"><input type="checkbox" class="select-all-checkbox" ${allChecked ? 'checked' : ''}></th>
    <th style="width: 30px;"></th>
    <th onclick="sortFiles('name')">ИМЯ</th>
    <th>ТИП</th>
    <th>РАЗМЕР</th>
    <th>ИЗМЕНЕНО</th>
    <th style="width: 100px;">ДЕЙСТВИЯ</th>
  </tr></thead><tbody>
    ${filteredFiles.map(file => `<tr>
      <td><input type="checkbox" class="file-checkbox" data-file-id="${file.id}" ${appState.selectedProjectFiles.has(file.id) ? 'checked' : ''}></td>
      <td style="text-align: center;"><button class="btn-file btn-view" data-path="${file.fullPath}" data-name="${file.name}" title="Просмотр">👁️</button></td>
      <td class="file-name" title="${file.name}">${file.name}</td>
      <td><span class="file-ext">${file.ext}</span>${file.isDuplicateOldVersion ? ' ❌' : ''}</td>
      <td>${file.sizeFormatted}</td>
      <td>${file.modified_at || 'N/A'}</td>
      <td class="file-actions">
        <button class="btn-file btn-open" data-path="${file.fullPath}">📂</button>
        <button class="btn-file btn-rename" data-file-id="${file.id}" data-file-name="${file.name}">✎</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;

  list.innerHTML = html;

  const selectAllCheckbox = list.querySelector('.select-all-checkbox');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
      appState.selectedProjectFiles.clear();
      if (e.target.checked) {
        filteredFiles.forEach(f => appState.selectedProjectFiles.add(f.id));
      }
      renderFiles();
    });
  }

  const fileCheckboxes = list.querySelectorAll('.file-checkbox');
  fileCheckboxes.forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        appState.selectedProjectFiles.add(e.target.dataset.fileId);
      } else {
        appState.selectedProjectFiles.delete(e.target.dataset.fileId);
      }
      updateAssignButton();
    });
  });

  const openButtons = list.querySelectorAll('.btn-open');
  openButtons.forEach(btn => {
    btn.addEventListener('click', () => openFile(btn.dataset.path));
  });

  const renameButtons = list.querySelectorAll('.btn-rename');
  renameButtons.forEach(btn => {
    btn.addEventListener('click', () => renameFileModal(btn.dataset.fileId, btn.dataset.fileName));
  });

  const viewButtons = list.querySelectorAll('.btn-view');
  viewButtons.forEach(btn => {
    btn.addEventListener('click', () => previewFileFromTable(btn.dataset.path, btn.dataset.name));
  });
}

function renderGallery(list, filteredFiles) {
  const galleryHtml = `
    <div class="gallery-container">
      <div class="gallery-grid" style="--icon-size: ${appState.iconSize}px">
        ${filteredFiles.map(file => `
          <div class="gallery-item" data-file-id="${file.id}">
            <div class="gallery-checkbox">
              <input type="checkbox" class="file-checkbox" data-file-id="${file.id}" ${appState.selectedProjectFiles.has(file.id) ? 'checked' : ''}>
            </div>
            <div class="gallery-thumbnail">
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect fill='%23ddd' width='100' height='100'/%3E%3Ctext x='50' y='50' text-anchor='middle' dy='.3em' fill='%23666' font-size='30'%3E🖼️%3C/text%3E%3C/svg%3E" alt="${file.name}" class="gallery-preview" data-file-path="${file.fullPath}">
            </div>
            <div class="gallery-name" title="${file.name}">${file.name}</div>
            <div class="gallery-ext">${file.ext}</div>
            <div class="gallery-actions">
              <button class="btn-file btn-preview" data-file-id="${file.id}" data-path="${file.fullPath}" data-name="${file.name}" title="Просмотр превью">👁️</button>
              <button class="btn-file btn-open" data-path="${file.fullPath}">📂</button>
              <button class="btn-file btn-rename" data-file-id="${file.id}" data-file-name="${file.name}">✎</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  list.innerHTML = galleryHtml;

  // Загружаем превью файлов (приоритет: Windows Preview → встроенные → SVG/специальные → иконка)
  const previews = list.querySelectorAll('.gallery-preview');
  previews.forEach(img => {
    const filePath = img.dataset.filePath;
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

    // Для SVG - можно открыть напрямую как изображение
    if (ext === '.svg') {
      img.src = `file:///${filePath.replace(/\\/g, '/')}`;
      console.log(`[PREVIEW] ✅ SVG direct: ${filePath}`);
      return;
    }

    // ПРИОРИТЕТ 1: Встроенные Windows превью (лучше всего!)
    window.api.getWindowsPreview(filePath).then(thumbPath => {
      if (thumbPath) {
        img.src = thumbPath;
        console.log(`[PREVIEW] ✅ Windows: ${thumbPath}`);
      } else {
        // ПРИОРИТЕТ 2: Встроенные превью (для SolidWorks, изображений и т.д.)
        window.api.getEmbeddedThumbnail(filePath).then(thumbPath2 => {
          if (thumbPath2) {
            img.src = thumbPath2;
            console.log(`[PREVIEW] ✅ Embedded: ${thumbPath2}`);
          } else {
            // ПРИОРИТЕТ 3: Получаем иконку файла (для остальных типов)
            window.api.getFileIcon(filePath).then(iconPath => {
              if (iconPath) {
                img.src = iconPath;
                console.log(`[PREVIEW] ℹ️ Icon: ${iconPath}`);
              }
            });
          }
        });
      }
    });
  });

  // Event listeners для галереи
  const fileCheckboxes = list.querySelectorAll('.file-checkbox');
  fileCheckboxes.forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        appState.selectedProjectFiles.add(e.target.dataset.fileId);
      } else {
        appState.selectedProjectFiles.delete(e.target.dataset.fileId);
      }
      updateAssignButton();
    });
  });

  const previewButtons = list.querySelectorAll('.btn-preview');
  previewButtons.forEach(btn => {
    btn.addEventListener('click', () => openImageViewer(btn.dataset.fileId, btn.dataset.path, btn.dataset.name));
  });

  const openButtons = list.querySelectorAll('.btn-open');
  openButtons.forEach(btn => {
    btn.addEventListener('click', () => openFile(btn.dataset.path));
  });

  const renameButtons = list.querySelectorAll('.btn-rename');
  renameButtons.forEach(btn => {
    btn.addEventListener('click', () => renameFileModal(btn.dataset.fileId, btn.dataset.fileName));
  });

  // Double click для открытия viewer
  const galleryItems = list.querySelectorAll('.gallery-item');
  galleryItems.forEach(item => {
    item.addEventListener('dblclick', () => {
      const fileId = item.dataset.fileId;
      const file = appState.allFiles.find(f => f.id === fileId);
      if (file) {
        openFileViewer(file.fullPath, file.name);
      }
    });
  });
}

function sortFiles(column) {
  if (appState.filesSortColumn === column) {
    appState.filesSortOrder = appState.filesSortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    appState.filesSortColumn = column;
    appState.filesSortOrder = 'asc';
  }
  renderFiles();
}

function toggleView() {
  appState.viewMode = appState.viewMode === 'table' ? 'gallery' : 'table';
  const btn = document.querySelector('[onclick="toggleView()"]');
  const sliderContainer = document.getElementById('size-slider-container');

  if (appState.viewMode === 'gallery') {
    btn.textContent = '📋 Таблица';
    sliderContainer.style.display = 'flex';
  } else {
    btn.textContent = '⊞ Галерея';
    sliderContainer.style.display = 'none';
  }

  renderFiles();
}

function changeIconSize(newSize) {
  appState.iconSize = parseInt(newSize);

  // ОПТИМИЗАЦИЯ: Не перезагружаем всё! Просто обновляем размер через CSS
  const galleryGrid = document.querySelector('.gallery-grid');
  if (galleryGrid) {
    galleryGrid.style.setProperty('--icon-size', `${appState.iconSize}px`);
    console.log(`[GALLERY] Size changed to ${appState.iconSize}px (NO reload)`);
  }
  // НЕ вызываем renderFiles()! Превью уже загружены в кеш
}

function updateAssignButton() {
  const btn = document.getElementById('assign-btn');
  if (appState.selectedProjectFiles.size > 0) {
    btn.style.display = 'block';
    btn.disabled = false;
  } else {
    btn.style.display = 'none';
  }
}

function updateExtensionFilter() {
  const select = document.getElementById('extension-filter');
  const extensions = [...new Set(appState.allFiles.filter(f => !f.category).map(f => f.ext))].sort();
  select.innerHTML = '<option value="">Все расширения</option>' +
    extensions.map(ext => `<option value="${ext}">${ext}</option>`).join('');
  select.onchange = () => {
    appState.filesExtFilter = select.value;
    renderFiles();
  };
}

function openFile(filePath) {
  window.api.openFile(filePath);
}

function renameFileModal(fileId, currentName) {
  const newName = prompt(`Переименовать файл:\n\nТекущее имя: ${currentName}\n\nНовое имя:`, currentName);
  if (!newName || newName === currentName) return;

  window.api.renameFile({ fileId, newName }).then(result => {
    if (result.success) {
      alert(`Файл переименован успешно!`);
      selectProject(appState.currentProject); // Перезагружаем список
    } else {
      alert(`Ошибка переименования: ${result.error}`);
    }
  });
}

function assignCategoryToSelected() {
  if (appState.selectedProjectFiles.size === 0) return;
  const modal = document.getElementById('modal-file-category');
  modal.classList.add('active');

  // ✅ v0.8: Показываем КОНКРЕТНЫЕ файлы которые выбраны
  const fileNames = Array.from(appState.selectedProjectFiles).map(fileId => {
    const file = appState.allFiles.find(f => f.id === fileId);
    return file ? file.name : fileId;
  }).join(', ');

  document.getElementById('modal-file-name').innerHTML = `<strong>Файлы:</strong> ${fileNames}`;

  const categoryList = document.getElementById('modal-categories');
  categoryList.innerHTML = appState.categories.map(cat => {
    const catName = typeof cat === 'string' ? cat : cat.name;
    return `<div class="modal-category-item" onclick="selectCategory('${catName}')">${catName}</div>`;
  }).join('');
  window.selectedCategory = null;
}

function selectCategory(categoryName) {
  window.selectedCategory = categoryName;
  const items = document.querySelectorAll('.modal-category-item');
  items.forEach(item => item.classList.remove('selected'));
  event.target.classList.add('selected');
  document.getElementById('confirm-category-btn').disabled = false;
}

async function confirmCategory() {
  if (!window.selectedCategory || appState.selectedProjectFiles.size === 0) return;
  for (const fileId of appState.selectedProjectFiles) {
    await window.api.linkFile({ fileId, categoryName: window.selectedCategory });
  }
  appState.selectedProjectFiles.clear();
  closeModal();
  const files = await window.api.getProjectFiles(appState.currentProject);
  appState.allFiles = files || [];
  renderCategories();
  renderFiles();
}

function addCategory() {
  document.getElementById('modal-new-category').classList.add('active');
}

async function createNewCategory() {
  const input = document.getElementById('category-input');
  const name = input.value.trim();
  if (!name) {
    alert('Введите имя категории');
    return;
  }
  await window.api.addCategory(name);
  const data = await window.api.getData();
  appState.categories = data.categories || [];
  closeModal();
  renderCategories();
  input.value = '';
}

function addCategoryInline() {
  const input = document.getElementById('new-category-inline');
  const name = input.value.trim();
  if (!name) {
    alert('Введите имя категории');
    return;
  }
  window.api.addCategory(name).then(async () => {
    const data = await window.api.getData();
    appState.categories = data.categories || [];
    renderCategories();
    input.value = '';
  });
}

function addProject() {
  document.getElementById('modal-new-project').classList.add('active');
}

async function createNewProject() {
  const nameInput = document.getElementById('project-name-input');
  const pathInput = document.getElementById('project-path-input');
  const name = nameInput.value.trim();
  const folderPath = pathInput.value.trim();
  if (!name || !folderPath) {
    alert('Заполните все поля');
    return;
  }
  const result = await window.api.addProject({ name, folderPath });
  if (result.success) {
    closeModal();
    const data = await window.api.getData();
    appState.projects = data.projects || [];
    renderProjectDropdown();
    renderProjects();
    selectProject(name);
    nameInput.value = '';
    pathInput.value = '';
  } else {
    alert(`Ошибка: ${result.error}`);
  }
}

function closeModal() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

async function refreshProjects() {
  const btn = document.querySelector('.btn-refresh');
  btn.disabled = true;
  btn.textContent = '⟳ Обновление...';
  await window.api.refreshProjects();
  const data = await window.api.getData();
  appState.projects = data.projects || [];
  appState.categories = data.categories || [];
  renderProjectDropdown();
  renderProjects();
  if (appState.currentProject) {
    selectProject(appState.currentProject);
  }
  btn.disabled = false;
  btn.textContent = '⟳ Обновить';
}

// ============================================
// VIEWERS: PDF, 3D, IMAGE и т.д.
// ============================================

let three3DViewer = null;

function openImageViewer(fileId, filePath, fileName) {
  const modal = document.getElementById('modal-image-viewer');
  const img = document.getElementById('image-viewer-img');
  const nameEl = document.getElementById('image-viewer-name');

  try {
    // ОПТИМИЗАЦИЯ: Берем превью ИЗ галереи, которое уже загружено!
    const galleryItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (!galleryItem) {
      alert('Ошибка: Файл не найден в галерее');
      return;
    }

    const galleryImg = galleryItem.querySelector('.gallery-preview');
    if (!galleryImg || !galleryImg.src) {
      alert('Ошибка: Превью не загружено');
      return;
    }

    // Берем src из существующего превью в галерее
    img.src = galleryImg.src;
    nameEl.textContent = fileName;
    modal.classList.add('active');

    console.log(`[IMAGE VIEWER] ✅ Opened from gallery: ${fileName}`);
  } catch (err) {
    console.error('[IMAGE VIEWER] Error:', err);
    alert('Ошибка при открытии превью');
  }
}

async function previewFileFromTable(filePath, fileName) {
  const modal = document.getElementById('modal-image-viewer');
  const img = document.getElementById('image-viewer-img');
  const nameEl = document.getElementById('image-viewer-name');

  try {
    // Получаем превью через API (Windows Preview или встроенный thumbnail)
    const dataUrl = await window.api.getWindowsPreview(filePath);

    if (!dataUrl) {
      alert('Не удалось загрузить превью файла');
      return;
    }

    // Обновляем содержимое
    img.src = dataUrl;
    nameEl.textContent = fileName;

    // Открываем модал ТОЛЬКО если ещё не открыт
    // Модал останется открытым для быстрого просмотра других файлов
    if (!modal.classList.contains('active')) {
      modal.classList.add('active');
    }

    console.log(`[PREVIEW] ✅ Updated from table: ${fileName}`);
  } catch (err) {
    console.error('[PREVIEW] Error:', err);
    alert('Ошибка при открытии превью');
  }
}

async function openFileViewer(filePath, fileName) {
  try {
    const viewerData = await window.api.getViewerData(filePath);

    if (viewerData.type === 'pdf') {
      openPDFViewer(filePath, fileName);
    } else if (viewerData.type === '3d') {
      // Для DXF/DWG - открываем Windows Preview как изображение
      if (viewerData.subtype === 'dxf') {
        openImageViewerFromPreview(filePath, fileName);
      } else {
        // Для остальных 3D - открываем 3D canvas
        open3DViewer(filePath, fileName, viewerData.ext);
      }
    } else {
      alert('Этот формат файла не поддерживается для просмотра');
    }
  } catch (err) {
    console.error('[VIEWER] Error:', err);
    alert('Ошибка открытия файла');
  }
}

function openImageViewerFromPreview(filePath, fileName) {
  const modal = document.getElementById('modal-image-viewer');
  const img = document.getElementById('image-viewer-img');
  const nameEl = document.getElementById('image-viewer-name');

  try {
    // Получаем Windows Preview превью
    window.api.getWindowsPreview(filePath).then(previewPath => {
      if (previewPath) {
        img.src = previewPath;
        nameEl.textContent = fileName;
        modal.classList.add('active');
        console.log(`[PREVIEW VIEWER] ✅ Opened: ${fileName}`);
      } else {
        alert('Ошибка: Превью не найдено');
      }
    });
  } catch (err) {
    console.error('[PREVIEW VIEWER] Error:', err);
    alert('Ошибка при открытии превью');
  }
}

function openPDFViewer(filePath, fileName) {
  const pdfPath = `file:///${filePath.replace(/\\/g, '/')}`;
  const modal = document.getElementById('modal-pdf-viewer');
  const embed = document.getElementById('pdf-embed');
  const title = document.getElementById('pdf-title');

  title.textContent = `📄 ${fileName}`;
  embed.src = pdfPath;
  modal.classList.add('active');
}

function open3DViewer(filePath, fileName, ext) {
  const modal = document.getElementById('modal-3d-viewer');
  const canvas = document.getElementById('three-canvas');
  const title = document.getElementById('3d-title');

  title.textContent = `🎯 ${fileName}`;
  modal.classList.add('active');

  // Инициализируем three.js scene
  setTimeout(() => {
    initThreeJSViewer(canvas, filePath, ext);
  }, 100);
}

function initThreeJSViewer(canvas, filePath, ext) {
  if (!window.THREE) {
    alert('Three.js не загружен');
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050809);

  const camera = new THREE.PerspectiveCamera(
    75,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    1000
  );
  camera.position.z = 50;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // Освещение
  const light = new THREE.DirectionalLight(0xffffff, 0.8);
  light.position.set(5, 10, 5);
  scene.add(light);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  // Загружаем модель в зависимости от формата
  if (ext === '.stl') {
    loadSTLModel(filePath, scene);
  } else if (ext === '.obj') {
    loadOBJModel(filePath, scene);
  } else if (['.glb', '.gltf'].includes(ext)) {
    loadGLTFModel(filePath, scene);
  } else {
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    const material = new THREE.MeshPhongMaterial({ color: 0x1688ff });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
  }

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);

    // Rotate objects
    scene.children.forEach(child => {
      if (child.isMesh && child !== light && child !== ambientLight) {
        child.rotation.x += 0.005;
        child.rotation.y += 0.005;
      }
    });

    renderer.render(scene, camera);
  }
  animate();

  // Handle window resize
  window.addEventListener('resize', () => {
    if (canvas.parentElement && canvas.parentElement.offsetParent !== null) {
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    }
  });
}

function loadSTLModel(filePath, scene) {
  // Простой loader для STL через fetch
  fetch(`file:///${filePath.replace(/\\/g, '/')}`)
    .then(res => res.arrayBuffer())
    .then(arrayBuffer => {
      const geometry = parseSTL(arrayBuffer);
      const material = new THREE.MeshPhongMaterial({
        color: 0x1688ff,
        emissive: 0x111111,
        shininess: 30
      });
      const mesh = new THREE.Mesh(geometry, material);

      // Center the geometry
      geometry.center();
      geometry.computeBoundingBox();

      // Scale to fit
      const bbox = geometry.boundingBox;
      const maxDim = Math.max(
        bbox.max.x - bbox.min.x,
        bbox.max.y - bbox.min.y,
        bbox.max.z - bbox.min.z
      );
      const scale = 30 / maxDim;
      geometry.scale(scale, scale, scale);

      scene.add(mesh);
    })
    .catch(err => console.error('[STL LOADER]', err));
}

function parseSTL(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const faces = view.getUint32(80, true);
  const geometry = new THREE.BufferGeometry();
  const vertices = [];
  const normals = [];

  let offset = 84;
  for (let i = 0; i < faces; i++) {
    const nx = view.getFloat32(offset, true); offset += 4;
    const ny = view.getFloat32(offset, true); offset += 4;
    const nz = view.getFloat32(offset, true); offset += 4;

    for (let j = 0; j < 3; j++) {
      vertices.push(view.getFloat32(offset, true)); offset += 4;
      vertices.push(view.getFloat32(offset, true)); offset += 4;
      vertices.push(view.getFloat32(offset, true)); offset += 4;
      normals.push(nx, ny, nz);
    }

    offset += 2; // attribute byte count
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));

  return geometry;
}

function loadOBJModel(filePath, scene) {
  alert('OBJ viewer требует доп. зависимостей - используйте STL или GLTF');
}

function loadGLTFModel(filePath, scene) {
  alert('GLTF viewer требует доп. зависимостей - используйте STL или GLTF');
}

// ═══════════════════════════════════════════════
// БД РЕДАКТОР ФУНКЦИИ
// ═══════════════════════════════════════════════

let dbState = {
  allFiles: [],
  selectedFileIndex: -1,
  filteredFiles: [],
  selectedFile: null
};

function loadDatabaseEditor() {
  dbState.allFiles = [...appState.allFiles];
  dbState.filteredFiles = [...dbState.allFiles];

  // Заполняем фильтр категории
  const categoryFilter = document.getElementById('db-filter-category');
  categoryFilter.innerHTML = '<option value="">Все категории</option>';
  appState.categories.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat.name;
    option.textContent = `${cat.icon} ${cat.name}`;
    categoryFilter.appendChild(option);
  });

  // Заполняем фильтр типа файла
  const types = new Set(dbState.allFiles.map(f => f.ext));
  const typeFilter = document.getElementById('db-filter-type');
  typeFilter.innerHTML = '<option value="">Все типы</option>';
  Array.from(types).sort().forEach(ext => {
    const option = document.createElement('option');
    option.value = ext;
    option.textContent = ext;
    typeFilter.appendChild(option);
  });

  renderDatabaseTable();
}

function renderDatabaseTable() {
  const tbody = document.getElementById('db-full-tbody');
  tbody.innerHTML = '';

  if (dbState.filteredFiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="loading">Файлов не найдено</td></tr>';
    document.getElementById('db-file-count').textContent = '0 файлов';
    return;
  }

  document.getElementById('db-file-count').textContent = `${dbState.filteredFiles.length} файлов`;

  dbState.filteredFiles.forEach((file, idx) => {
    const row = document.createElement('tr');
    const historyText = (file.history || [])
      .map(h => `[${h.action}] ${new Date(h.timestamp).toLocaleString()}`)
      .join('; ');

    // Определяем статус дубликата
    let statusCell = '—';
    let rowStyle = '';
    if (file.isDuplicate && file.isDuplicateOldVersion) {
      statusCell = '❌ СТАРАЯ';
      rowStyle = ' style="opacity: 0.6; background: rgba(255, 0, 0, 0.1);"';
    } else if (file.isDuplicate && !file.isDuplicateOldVersion) {
      statusCell = '✓ СВЕЖАЯ';
      rowStyle = ' style="background: rgba(0, 255, 0, 0.05);"';
    }

    // Простая иконка вместо превью
    const iconCell = file.isDuplicate ? '📋' : (file.ext && ['JPG', 'PNG', 'GIF'].includes(file.ext) ? '🖼️' : '📄');

    row.innerHTML = `
      <td>${idx + 1}</td>
      <td style="text-align: center; font-size: 18px;">${iconCell}</td>
      <td>${statusCell}</td>
      <td title="${file.id}">${file.id}</td>
      <td title="${file.name}">${file.name}</td>
      <td title="${file.fullPath}">${file.fullPath}</td>
      <td>${file.ext}</td>
      <td>${file.sizeFormatted || '0 Б'}</td>
      <td>${file.modified_at ? new Date(file.modified_at).toLocaleString() : 'N/A'}</td>
      <td>${file.category || '—'}</td>
      <td title="${file.description || ''}">${file.description || '—'}</td>
      <td>${file.tags ? file.tags.join(', ') : '—'}</td>
      <td title="${historyText}">${historyText || '—'}</td>
    `;
    if (rowStyle) row.setAttribute('style', rowStyle.slice(7, -2)); // Убрать style="..."
    tbody.appendChild(row);
  });
}

function dbSearchFiles() {
  const query = document.getElementById('db-search').value.toLowerCase();
  dbApplyFilters();
}

function dbApplyFilters() {
  const searchQuery = document.getElementById('db-search').value.toLowerCase();
  const categoryFilter = document.getElementById('db-filter-category').value;
  const typeFilter = document.getElementById('db-filter-type').value;
  const sizeFilter = document.getElementById('db-filter-size').value;

  dbState.filteredFiles = dbState.allFiles.filter(file => {
    // Поиск по имени/ID/пути
    const matchSearch = searchQuery === '' ||
      file.name.toLowerCase().includes(searchQuery) ||
      file.id.toLowerCase().includes(searchQuery) ||
      file.fullPath.toLowerCase().includes(searchQuery);

    // Фильтр по категории
    const matchCategory = categoryFilter === '' || file.category === categoryFilter;

    // Фильтр по типу файла
    const matchType = typeFilter === '' || file.ext === typeFilter;

    // Фильтр по размеру
    let matchSize = true;
    if (sizeFilter === 'small') {
      matchSize = file.size < 1024 * 1024;
    } else if (sizeFilter === 'medium') {
      matchSize = file.size >= 1024 * 1024 && file.size < 10 * 1024 * 1024;
    } else if (sizeFilter === 'large') {
      matchSize = file.size >= 10 * 1024 * 1024;
    }

    return matchSearch && matchCategory && matchType && matchSize;
  });

  renderDatabaseTable();
}

function dbResetFilters() {
  document.getElementById('db-search').value = '';
  document.getElementById('db-filter-category').value = '';
  document.getElementById('db-filter-type').value = '';
  document.getElementById('db-filter-size').value = '';

  dbState.filteredFiles = [...dbState.allFiles];
  renderDatabaseTable();
}

// ✅ ПОЛНАЯ ПЕРЕЗАГРУЗКА ПРИЛОЖЕНИЯ (БД + страница)
async function reloadAppProperly() {
  try {
    console.log('🔄 Перезагружаю БД...');
    // Шаг 1: Перезагружаем БД с диска
    const data = await window.api.getData();
    appState.projects = data.projects || [];
    appState.categories = data.categories || [];
    appState.allFiles = [];
    dbState.allFiles = [];

    console.log('✅ БД обновлена. Перезагружаю проект...');
    // Шаг 2: Перезагружаем текущий проект
    if (appState.currentProject) {
      await selectProject(appState.currentProject);
    }

    console.log('✨ Перезагружаю страницу...');
    // Шаг 3: Перезагружаем страницу (очищаем кэши браузера)
    setTimeout(() => {
      location.reload();
    }, 300);
  } catch (err) {
    console.error('❌ Ошибка при перезагрузке:', err);
    location.reload(); // На крайний случай просто перезагружаем
  }
}

// ============================================
// ИНДЕКСАЦИЯ ПРЕВЬЮ ВСЕХ ФАЙЛОВ (v0.8)
// ============================================

async function startIndexingAllThumbnails() {
  console.log('🎬 СТАРТ: Индексация превью всех файлов');

  // Показываем модаль с прогрессом
  showThumbnailIndexingModal();

  try {
    console.log('📡 Вызываю API: indexAllThumbnails()');
    const result = await window.api.indexAllThumbnails();
    console.log('📊 Результат API:', result);

    if (result && result.success) {
      console.log(`✅ Индексация завершена: ${result.thumbnails} превью`);
      alert(`✅ Индексация завершена!\n${result.thumbnails} превью + ${result.totalFiles - result.thumbnails} иконок\nВремя: ${result.duration}s`);

      // Перезагружаем БД
      setTimeout(() => {
        reloadAppProperly();
      }, 500);
    } else {
      console.error('❌ Ошибка индексации:', result);
      alert(`❌ Ошибка: ${result?.error || 'Неизвестная ошибка'}`);
    }
  } catch (err) {
    console.error('❌ Критическая ошибка:', err);
    alert(`❌ Критическая ошибка: ${err.message}`);
  } finally {
    closeThumbnailIndexingModal();
  }
}

function showThumbnailIndexingModal() {
  let modal = document.getElementById('modal-thumbnail-indexing');
  if (!modal) {
    // Создаем модаль если её нет
    modal = document.createElement('div');
    modal.id = 'modal-thumbnail-indexing';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="min-width: 400px; text-align: center;">
        <h3>🎬 Индексация превью</h3>
        <div id="thumbnail-progress-bar" style="margin: 20px 0; background: var(--bg-card); border-radius: 4px; height: 20px; overflow: hidden;">
          <div id="thumbnail-progress-fill" style="height: 100%; background: var(--accent); width: 0%; transition: width 0.2s;"></div>
        </div>
        <p id="thumbnail-status" style="color: var(--text-secondary); font-size: 12px;">Подготовка...</p>
        <p id="thumbnail-current" style="margin: 10px 0; font-size: 14px;">0 / 0</p>
      </div>
    `;
    document.body.appendChild(modal);

    // 📡 Регистрируем слушатель ОДИН РАЗ (при создании модали)
    if (window.api && window.api.onThumbnailProgress) {
      console.log('📡 Регистрирую слушатель onThumbnailProgress');
      window.api.onThumbnailProgress((data) => {
        console.log('📊 Прогресс:', data);
        const fillBar = document.getElementById('thumbnail-progress-fill');
        const currentText = document.getElementById('thumbnail-current');
        const statusText = document.getElementById('thumbnail-status');

        if (fillBar && currentText && statusText) {
          const percent = (data.current / data.total) * 100;
          fillBar.style.width = percent + '%';
          currentText.textContent = `${data.current} / ${data.total}`;
          statusText.textContent = data.fileName || 'Обработка...';
        }
      });
    }
  }

  modal.style.display = 'flex';
  console.log('✅ Модаль индексации показана');
}

function closeThumbnailIndexingModal() {
  const modal = document.getElementById('modal-thumbnail-indexing');
  if (modal) {
    modal.style.display = 'none';
  }
}

// DASHBOARD - загруженить главную страницу
function loadDashboard() {
  const dashboardContent = document.getElementById('dashboard-content');

  // Встраиваем dashboard.html контент
  dashboardContent.innerHTML = `
    <div class="dashboard-container">
      <div class="dashboard-header">
        <div class="header-top">
          <h1>📊 АРТЕЛЬ Dashboard</h1>
          <div class="header-info">
            <span class="version">v0.7.1</span>
            <span class="sync-status">🟢 Синхронизировано</span>
          </div>
        </div>
      </div>

      <div class="dashboard-content" style="padding: 20px;">
        <div style="text-align: center; padding: 40px;">
          <h2>📂 Проекты</h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0;">
            ${appState.projects && appState.projects.length > 0 ? appState.projects.map(p => `
              <div style="padding: 20px; background: var(--bg-card); border-radius: 8px; border: 1px solid var(--border); cursor: pointer; transition: all 0.2s;" onclick="selectProject('${p.name}')">
                <strong>${p.name}</strong>
                <br><small style="color: var(--text-secondary);">${(p.fileCount || 0)} файлов</small>
              </div>
            `).join('') : '<p>Нет проектов</p>'}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ABOUT PAGE - Load project documentation
function loadAboutPage() {
  const container = document.getElementById('about-content-container');
  fetch('../docs/СТРУКТУРА-АРТЕЛЬ.md')
    .then(r => r.text())
    .then(markdown => {
      const html = markdownToHtml(markdown);
      container.innerHTML = html;
    })
    .catch(err => {
      console.error('Load about page error:', err);
      container.innerHTML = '<p>Error loading documentation</p>';
    });
}

function markdownToHtml(markdown) {
  return markdown
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '<br><br>');
}

function toggleEditMode() {
  alert('Функция редактирования будет реализована');
}

function exportStructure() {
  alert('Экспорт будет реализован');
}

function showHistory() {
  alert('История будет реализована');
}

document.addEventListener('DOMContentLoaded', init);
