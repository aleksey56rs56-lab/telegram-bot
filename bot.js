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

async function sendMainMenu(chatId, text = 'Выбери, что тебе нужно 👇') {
  userState[chatId] = { step: 'main' };

  await bot.sendMessage(chatId, text, {
    reply_markup: getMainKeyboard(),
  });
}

async function sendOwnerLead({
  msg,
  topic,
  details = [],
  source = 'бот',
}) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Не указано';

  const username = msg.from?.username ? '@' + msg.from.username : 'нет';
  const replyHint = `/reply ${msg.chat.id} `;

  const extraDetails = details
    .filter(Boolean)
    .map((item) => item.trim())
    .join('\n');

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `📩 <b>Новая заявка</b>

📍 <b>Источник:</b> ${source}
📌 <b>Тема:</b> ${topic}
👤 <b>Имя:</b> ${name}
🔗 <b>Username:</b> ${username}
🆔 <b>User ID:</b> ${msg.from?.id}
💬 <b>Chat ID:</b> ${msg.chat.id}
${extraDetails ? '\n' + extraDetails : ''}

<b>Сообщение:</b>
${msg.text}

<b>Быстрый ответ:</b>
<code>${replyHint}</code>`,
    {
      parse_mode: 'HTML',
    }
  );
}

async function forwardDialogMessageToOwner(msg) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Не указано';

  const username = msg.from?.username ? '@' + msg.from.username : 'нет';
  const replyHint = `/reply ${msg.chat.id} `;

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `💬 <b>Новое сообщение в диалоге</b>

👤 <b>Имя:</b> ${name}
🔗 <b>Username:</b> ${username}
🆔 <b>User ID:</b> ${msg.from?.id}
💬 <b>Chat ID:</b> ${msg.chat.id}

<b>Сообщение:</b>
${msg.text}

<b>Быстрый ответ:</b>
<code>${replyHint}</code>`,
    {
      parse_mode: 'HTML',
    }
  );
}

function getOnlineReplyText() {
  return `Заявку получил ✅

🟢 Алексей сейчас онлайн
💬 Ответ обычно в течение 10–30 минут`;
}

// Ответ клиенту от имени бота
bot.onText(/^\/reply\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  const ownerChatId = msg.chat.id;

  if (ownerChatId !== OWNER_CHAT_ID) {
    return bot.sendMessage(ownerChatId, '❌ У тебя нет доступа к этой команде.');
  }

  const targetChatId = Number(match[1]);
  const replyText = match[2].trim();

  if (!targetChatId || !replyText) {
    return bot.sendMessage(
      ownerChatId,
      'Использование:\n/reply CHAT_ID текст_ответа'
    );
  }

  try {
    await bot.sendMessage(
      targetChatId,
      `💬 Алексей на связи

${replyText}`
    );

    userState[targetChatId] = {
      ...(userState[targetChatId] || {}),
      step: 'dialog',
    };

    await bot.sendMessage(
      ownerChatId,
      `✅ Ответ отправлен пользователю ${targetChatId}`
    );
  } catch (error) {
    await bot.sendMessage(
      ownerChatId,
      `❌ Не удалось отправить ответ: ${error.message}`
    );
  }
});

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const source = match?.[1];

  const helloText =
    source === 'site'
      ? 'Привет 👋\nТы пришёл с сайта Алексея.\n\nЧем могу помочь?'
      : 'Привет 👋\nЯ помощник Алексея.\n\nЧем могу помочь?';

  await bot.sendMessage(chatId, helloText);

  setTimeout(async () => {
    try {
      await sendMainMenu(chatId);
    } catch (error) {
      console.error('Ошибка отправки главного меню:', error.message);
    }
  }, 800);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/start')) return;
  if (text.startsWith('/reply')) return;

  if (!userState[chatId]) {
    userState[chatId] = { step: 'main' };
  }

  if (text === '⬅️ Назад') {
    return sendMainMenu(chatId);
  }

  // Если уже идёт диалог — просто пересылаем сообщение владельцу
  if (userState[chatId].step === 'dialog') {
    await forwardDialogMessageToOwner(msg);

    return bot.sendMessage(
      chatId,
      `Сообщение передал ✅

🟢 Алексей сейчас онлайн
💬 Можешь продолжать писать сюда, не выбирая тему заново.`
    );
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

  if (
    text === 'Сайт-визитка' ||
    text === 'Лендинг' ||
    text === 'Доработка сайта' ||
    text === 'Интернет-магазин'
  ) {
    userState[chatId] = {
      step: 'wait_budget',
      topic: text,
    };

    return bot.sendMessage(chatId, 'Отлично 👍\n\nНапиши примерный бюджет:');
  }

  if (userState[chatId].step === 'wait_budget') {
    userState[chatId].budget = text;
    userState[chatId].step = 'wait_deadline';

    return bot.sendMessage(chatId, 'Хорошо 👌\n\nА какие сроки?');
  }

  if (userState[chatId].step === 'wait_deadline') {
    userState[chatId].deadline = text;

    const topic = userState[chatId].topic;
    const budget = userState[chatId].budget;
    const deadline = userState[chatId].deadline;

    await sendOwnerLead({
      msg,
      topic: `Сайт: ${topic}`,
      details: [
        `💰 <b>Бюджет:</b> ${budget}`,
        `⏳ <b>Сроки:</b> ${deadline}`,
      ],
      source: 'сайт/бот',
    });

    userState[chatId] = { step: 'dialog' };

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getMainKeyboard(),
    });
  }

  if (
    text === 'Не работает программа' ||
    text === 'Проблема с ПК' ||
    text === 'Проблема с интернетом' ||
    text === 'Нужна удалённая помощь'
  ) {
    await sendOwnerLead({
      msg,
      topic: `Техподдержка: ${text}`,
      source: 'сайт/бот',
    });

    userState[chatId] = { step: 'dialog' };

    return bot.sendMessage(chatId, getOnlineReplyText());
  }

  if (
    text === 'Настройка ПК' ||
    text === 'Настройка сети' ||
    text === 'Удалённый доступ' ||
    text === 'Пользователи и права'
  ) {
    await sendOwnerLead({
      msg,
      topic: `Администрирование: ${text}`,
      source: 'сайт/бот',
    });

    userState[chatId] = { step: 'dialog' };

    return bot.sendMessage(chatId, getOnlineReplyText());
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
    await sendOwnerLead({
      msg,
      topic: 'Связь с Алексеем',
      source: 'сайт/бот',
    });

    userState[chatId] = { step: 'dialog' };

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getMainKeyboard(),
    });
  }

  return bot.sendMessage(chatId, 'Выбери нужный раздел кнопками ниже 👇', {
    reply_markup: getMainKeyboard(),
  });
});

bot.on('polling_error', (error) => {
  console.error('Ошибка polling:', error.message);
});
