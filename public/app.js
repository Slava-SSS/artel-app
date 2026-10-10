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
  document.getElementById('files-tab').style.display = 'none';
  document.getElementById('orders-tab').style.display = 'none';

  // Показываем выбранную вкладку
  if (tabName === 'files') {
    document.getElementById('files-tab').style.display = 'grid';
  } else if (tabName === 'orders') {
    document.getElementById('orders-tab').style.display = 'flex';
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
  const files = await window.api.getProjectFiles(projectName);
  appState.allFiles = files || [];
  renderCategories();
  renderFiles();
  updateExtensionFilter();
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
          <td><span class="file-ext">${file.ext}</span></td>
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

  // ТОЛЬКО файлы БЕЗ категории!
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
      <td><span class="file-ext">${file.ext}</span></td>
      <td>${file.sizeFormatted}</td>
      <td>${file.modified_at}</td>
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


document.addEventListener('DOMContentLoaded', init);
