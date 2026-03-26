const TelegramBot = require('node-telegram-bot-api');

const token =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TOKEN;

const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID);

if (!token) {
  throw new Error('Токен бота не найден в переменных окружения');
}

if (!OWNER_CHAT_ID) {
  console.warn('OWNER_CHAT_ID не задан');
}

const bot = new TelegramBot(token, { polling: true });
const userState = {};
console.log('Бот запущен...');

function getMainKeyboard() {
  return {
    keyboard: [
      ['🌐 Сайт', '🛠 Техподдержка'],
      ['⚙️ Администрирование', '💬 Связаться с Алексеем'],
    ],
    resize_keyboard: true,
  };
}

function getSiteKeyboard() {
  return {
    keyboard: [
      ['Сайт-визитка', 'Лендинг'],
      ['Доработка сайта', 'Интернет-магазин'],
      ['⬅️ Назад'],
    ],
    resize_keyboard: true,
  };
}

function getSupportKeyboard() {
  return {
    keyboard: [
      ['Не работает программа', 'Проблема с ПК'],
      ['Проблема с интернетом', 'Нужна удалённая помощь'],
      ['⬅️ Назад'],
    ],
    resize_keyboard: true,
  };
}

function getAdminKeyboard() {
  return {
    keyboard: [
      ['Настройка ПК', 'Настройка сети'],
      ['Удалённый доступ', 'Пользователи и права'],
      ['⬅️ Назад'],
    ],
    resize_keyboard: true,
  };
}

function getContactKeyboard() {
  return {
    keyboard: [
      ['Оставить заявку', 'Написать в Telegram'],
      ['⬅️ Назад'],
    ],
    resize_keyboard: true,
  };
}

async function sendMainMenu(chatId, text = 'Привет 👋\nЯ помощник Алексея.\n\nВыбери, что тебе нужно:') {
  userState[chatId] = { step: 'main' };

  await bot.sendMessage(chatId, text, {
    reply_markup: getMainKeyboard(),
  });
}

async function forwardLeadToOwner(msg, topic) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Не указано';

  const username = msg.from?.username ? '@' + msg.from.username : 'нет';

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `📩 Новая заявка в боте

📌 Тема: ${topic}
👤 Имя: ${name}
🆔 Username: ${username}
🧾 User ID: ${msg.from?.id}
💬 Chat ID: ${msg.chat.id}

Сообщение:
${msg.text}`
  );
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const source = match?.[1];
  const helloText =
    source === 'site'
      ? 'Привет 👋\nТы пришёл с сайта Алексея.\n\nВыбери, что тебе нужно:'
      : 'Привет 👋\nЯ помощник Алексея.\n\nВыбери, что тебе нужно:';

  await sendMainMenu(msg.chat.id, helloText);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/start')) return;

  if (!userState[chatId]) {
    userState[chatId] = { step: 'main' };
  }

  if (text === '⬅️ Назад') {
    return sendMainMenu(chatId);
  }

  if (text === '🌐 Сайт') {
    userState[chatId] = { step: 'site_menu' };

    return bot.sendMessage(chatId, 'Выбери, какой сайт нужен:', {
      reply_markup: getSiteKeyboard(),
    });
  }

  if (text === '🛠 Техподдержка') {
    userState[chatId] = { step: 'support_menu' };

    return bot.sendMessage(chatId, 'Выбери, с чем нужна помощь:', {
      reply_markup: getSupportKeyboard(),
    });
  }

  if (text === '⚙️ Администрирование') {
    userState[chatId] = { step: 'admin_menu' };

    return bot.sendMessage(chatId, 'Выбери, что нужно настроить:', {
      reply_markup: getAdminKeyboard(),
    });
  }

  if (text === '💬 Связаться с Алексеем') {
    userState[chatId] = { step: 'contact_menu' };

    return bot.sendMessage(chatId, 'Выбери удобный вариант:', {
      reply_markup: getContactKeyboard(),
    });
  }

  if (text === 'Сайт-визитка' || text === 'Лендинг' || text === 'Доработка сайта' || text === 'Интернет-магазин') {
    await forwardLeadToOwner(msg, `Сайт: ${text}`);

    return bot.sendMessage(
      chatId,
      `Отлично, выбрано: ${text} ✅\n\nАлексей получил заявку и свяжется с тобой.`
    );
  }

  if (
    text === 'Не работает программа' ||
    text === 'Проблема с ПК' ||
    text === 'Проблема с интернетом' ||
    text === 'Нужна удалённая помощь'
  ) {
    await forwardLeadToOwner(msg, `Техподдержка: ${text}`);

    return bot.sendMessage(
      chatId,
      `Принял: ${text} ✅\n\nАлексей получил заявку и ответит как можно скорее.`
    );
  }

  if (
    text === 'Настройка ПК' ||
    text === 'Настройка сети' ||
    text === 'Удалённый доступ' ||
    text === 'Пользователи и права'
  ) {
    await forwardLeadToOwner(msg, `Администрирование: ${text}`);

    return bot.sendMessage(
      chatId,
      `Принял: ${text} ✅\n\nАлексей получил заявку и свяжется с тобой.`
    );
  }

  if (text === 'Оставить заявку') {
    userState[chatId] = { step: 'wait_text' };

    return bot.sendMessage(
      chatId,
      'Опиши задачу одним сообщением, и Алексей получит её прямо в Telegram.',
      {
        reply_markup: {
          keyboard: [['⬅️ Назад']],
          resize_keyboard: true,
        },
      }
    );
  }

  if (text === 'Написать в Telegram') {
    return bot.sendMessage(chatId, 'Вот ссылка для связи: https://t.me/teikerrr');
  }

  if (userState[chatId].step === 'wait_text') {
    await forwardLeadToOwner(msg, 'Связь с Алексеем');

    userState[chatId] = { step: 'main' };

    return bot.sendMessage(
      chatId,
      'Сообщение получил ✅\nАлексей увидит его и ответит тебе.',
      {
        reply_markup: getMainKeyboard(),
      }
    );
  }

  return bot.sendMessage(
    chatId,
    'Выбери нужный раздел кнопками ниже 👇',
    {
      reply_markup: getMainKeyboard(),
    }
  );
});

bot.on('polling_error', (error) => {
  console.error('Ошибка polling:', error.message);
});

console.log('Бот запущен...');
