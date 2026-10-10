const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const https = require('https');

let bot = null;
let orders = [];
let onNewOrder = null;  // Callback для отправки нового заказа в main.js
let photoDir = null;    // Директория для сохранения фото
let lastUpdateId = 0;   // Отслеживаем последний update_id чтобы не получить одно сообщение дважды

// Логирование в файл
const LOG_FILE = path.join(process.env.TEMP || '/tmp', 'artel-debug.log');
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    console.error('Log write error:', e.message);
  }
}

async function downloadPhoto(botInstance, fileId, orderId) {
  try {
    if (!photoDir || !fs.existsSync(photoDir)) {
      log('[PHOTO] Директория для фото не установлена');
      return null;
    }

    log('[PHOTO] Скачивание фото (fileId=' + fileId + ')');

    // Получаем информацию о файле
    const file = await botInstance.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botInstance.token}/${file.file_path}`;

    // Формируем путь для сохранения
    const fileName = `order-${orderId}-${Date.now()}.jpg`;
    const filePath = path.join(photoDir, fileName);

    // Скачиваем файл
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https.get(fileUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          log('[PHOTO] Фото сохранено: ' + fileName);
          resolve(filePath);
        });
        file.on('error', (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  } catch (err) {
    log('[PHOTO] Ошибка скачивания: ' + err.message);
    return null;
  }
}

function startBot(botToken, photoDirectory) {
  if (!botToken) {
    log('[TELEGRAM] Токен не установлен');
    return false;
  }

  photoDir = photoDirectory;
  if (!fs.existsSync(photoDir)) {
    fs.mkdirSync(photoDir, { recursive: true });
    log('[PHOTO] Создана директория: ' + photoDir);
  }

  try {
    log('[TELEGRAM] Creating Telegraf instance...');
    bot = new Telegraf(botToken);
    log('[TELEGRAM] Telegraf instance created');

    log('[TELEGRAM] Registering handlers...');

    // Команда /start
    bot.start((ctx) => {
      log('[TELEGRAM] /start от ' + ctx.from.username);
      ctx.reply('✅ Бот готов собирать заказы!');
    });

    // Команда /help
    bot.help((ctx) => {
      ctx.reply('📋 Просто пишите заказы - бот их записывает');
    });

    // Команда /status
    bot.command('status', (ctx) => {
      ctx.reply('📊 Собрано ' + orders.length + ' заказов');
    });

    // Команда /list
    bot.command('list', (ctx) => {
      if (orders.length === 0) {
        ctx.reply('Заказов нет');
        return;
      }
      let msg = '📋 Заказы:\n';
      orders.slice(-10).forEach((o, i) => {
        msg += (i + 1) + '. ' + o.title + '\n';
      });
      ctx.reply(msg);
    });

    // ГЛАВНОЕ: Обработка обычных сообщений (в конце!)
    log('[TELEGRAM] Registering message handler...');
    bot.on('message', async (ctx) => {
      try {
        const msg = ctx.message;
        const updateId = ctx.update.update_id;

        // Отмечаем это обновление как обработанное
        lastUpdateId = Math.max(lastUpdateId, updateId);

        log('[TELEGRAM] MESSAGE HANDLER TRIGGERED: text=' + (msg.text || 'no text') + ', from=' + ctx.from.first_name);
        log('[TELEGRAM] Сообщение получено: text=' + msg.text + ', from=' + ctx.from.first_name + ', chatId=' + msg.chat.id);

        // Пропускаем команды - они обработаны выше
        if (msg.text && msg.text.startsWith('/')) {
          log('[TELEGRAM] Пропущена команда: ' + msg.text);
          return;
        }

        // Генерируем ID заказа ДО скачивания фото
        const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Собираем и СКАЧИВАЕМ фотографии (если есть)
        const photos = [];
        if (msg.photo && msg.photo.length > 0) {
          const bestPhoto = msg.photo[msg.photo.length - 1]; // Самый лучший размер
          try {
            const localPath = await downloadPhoto(bot, bestPhoto.file_id, orderId);
            if (localPath) {
              photos.push({
                file_id: bestPhoto.file_id,
                file_unique_id: bestPhoto.file_unique_id,
                width: bestPhoto.width,
                height: bestPhoto.height,
                file_size: bestPhoto.file_size,
                localPath: localPath  // Локальный путь к скачанному файлу
              });
            }
          } catch (err) {
            log('[PHOTO] Ошибка скачивания фото: ' + err.message);
          }
        }

        // Собираем заказ
        const order = {
          id: orderId,
          title: msg.text || msg.caption || 'Без названия',
          author: ctx.from.first_name || 'Неизвестный',
          authorId: ctx.from.id,
          date: new Date(msg.date * 1000).toISOString(),
          photos: photos,
          messageId: msg.message_id,
          chatId: msg.chat.id,
        };

        orders.push(order);
        log('[TELEGRAM] Заказ собран (всего: ' + orders.length + '): ' + order.title + ', фото: ' + photos.length);

        // Ответ в группу
        await ctx.reply('✅ Заказ записан!\n"' + order.title + '"\n📌 Автор: ' + order.author);
      } catch (err) {
        log('[TELEGRAM] Ошибка при обработке: ' + err.message);
      }
    });

    // Запуск
    log('[TELEGRAM] Launching bot with polling mode...');
    bot.launch({
      polling: {
        interval: 300,
        timeout: 10,
        allowed_updates: ['message'],  // Только сообщения
        offset: lastUpdateId + 1,      // Начинаем со следующего update после последнего обработанного
      },
    });

    log('[TELEGRAM] Бот запущен (polling mode).');

    return true;
  } catch (err) {
    log('[TELEGRAM] Ошибка: ' + err.message);
    return false;
  }
}

function stopBot() {
  if (bot) {
    bot.stop();
    log('[TELEGRAM] Бот остановлен');
  }
}

function getOrders() {
  // Возвращаем ВСЕ заказы (не очищаем - main.js сам проверяет дубликаты через messageId)
  return orders;
}

function clearOrdersByIds(messageIds) {
  // Удаляем только уже синхронизированные
  const before = orders.length;
  orders = orders.filter(o => !messageIds.includes(o.messageId));
  log('[TELEGRAM] Cleared ' + (before - orders.length) + ' orders from memory');
}


module.exports = {
  startBot,
  stopBot,
  getOrders,
  clearOrdersByIds,
};
