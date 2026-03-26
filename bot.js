const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

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
const lastMessageTime = {};

const LEADS_FILE = path.join(__dirname, 'leads.json');
const SPAM_COOLDOWN_MS = 2500;

console.log('Бот запущен...');

function safeReadLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) {
      fs.writeFileSync(LEADS_FILE, '[]', 'utf8');
      return [];
    }

    const raw = fs.readFileSync(LEADS_FILE, 'utf8');
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (error) {
    console.error('Ошибка чтения leads.json:', error.message);
    return [];
  }
}

function saveLead(lead) {
  try {
    const leads = safeReadLeads();
    leads.push(lead);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
  } catch (error) {
    console.error('Ошибка сохранения заявки:', error.message);
  }
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getUserDisplayName(msg) {
  return [msg.from?.first_name, msg.from?.last_name]
    .filter(Boolean)
    .join(' ') || 'Не указано';
}

function getUserUsername(msg) {
  return msg.from?.username ? '@' + msg.from.username : 'нет';
}

function getReplyHint(chatId) {
  return `/reply ${chatId} `;
}

function isSpam(chatId) {
  const now = Date.now();
  const lastTime = lastMessageTime[chatId] || 0;

  if (now - lastTime < SPAM_COOLDOWN_MS) {
    return true;
  }

  lastMessageTime[chatId] = now;
  return false;
}

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

function getDialogKeyboard() {
  return {
    keyboard: [['🏠 В меню']],
    resize_keyboard: true,
  };
}

async function sendMainMenu(chatId, text = 'Выбери, что тебе нужно 👇') {
  userState[chatId] = { step: 'main' };

  await bot.sendMessage(chatId, text, {
    reply_markup: getMainKeyboard(),
  });
}

function buildLeadText({
  title,
  source,
  topic,
  name,
  username,
  userId,
  chatId,
  messageText,
  details = [],
}) {
  const extraDetails = details
    .filter(Boolean)
    .map((item) => item.trim())
    .join('\n');

  return `📩 <b>${escapeHtml(title)}</b>

📍 <b>Источник:</b> ${escapeHtml(source)}
📌 <b>Тема:</b> ${escapeHtml(topic)}
👤 <b>Имя:</b> ${escapeHtml(name)}
🔗 <b>Username:</b> ${escapeHtml(username)}
🆔 <b>User ID:</b> ${escapeHtml(String(userId))}
💬 <b>Chat ID:</b> ${escapeHtml(String(chatId))}
${extraDetails ? '\n' + extraDetails : ''}

<b>Сообщение:</b>
${escapeHtml(messageText)}

<b>Быстрый ответ:</b>
<code>${escapeHtml(getReplyHint(chatId))}</code>`;
}

async function sendOwnerLead({
  msg,
  topic,
  details = [],
  source = 'бот',
}) {
  const name = getUserDisplayName(msg);
  const username = getUserUsername(msg);

  const leadText = buildLeadText({
    title: 'Новая заявка',
    source,
    topic,
    name,
    username,
    userId: msg.from?.id,
    chatId: msg.chat.id,
    messageText: msg.text,
    details,
  });

  await bot.sendMessage(OWNER_CHAT_ID, leadText, {
    parse_mode: 'HTML',
  });

  saveLead({
    type: 'lead',
    createdAt: new Date().toISOString(),
    source,
    topic,
    name,
    username,
    userId: msg.from?.id,
    chatId: msg.chat.id,
    message: msg.text,
    details,
  });
}

async function forwardDialogMessageToOwner(msg) {
  const name = getUserDisplayName(msg);
  const username = getUserUsername(msg);

  const dialogText = buildLeadText({
    title: 'Новое сообщение в диалоге',
    source: 'активный диалог',
    topic: 'Продолжение переписки',
    name,
    username,
    userId: msg.from?.id,
    chatId: msg.chat.id,
    messageText: msg.text,
  });

  await bot.sendMessage(OWNER_CHAT_ID, dialogText, {
    parse_mode: 'HTML',
  });

  saveLead({
    type: 'dialog_message',
    createdAt: new Date().toISOString(),
    source: 'dialog',
    topic: 'Продолжение переписки',
    name,
    username,
    userId: msg.from?.id,
    chatId: msg.chat.id,
    message: msg.text,
  });
}

function getOnlineReplyText() {
  return `✅ Заявку получил

🟢 Алексей сейчас онлайн
💬 Ответ обычно в течение 10–30 минут

Ты можешь продолжать писать сюда — бот передаст сообщения без выбора темы заново.`;
}

function getDialogReplyText() {
  return `✅ Сообщение передал

🟢 Алексей сейчас онлайн
💬 Можешь продолжать писать сюда.

Чтобы начать заново — нажми кнопку «🏠 В меню».`;
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
      `💬 <b>Алексей на связи</b>

${escapeHtml(replyText)}`,
      {
        parse_mode: 'HTML',
        reply_markup: getDialogKeyboard(),
      }
    );

    userState[targetChatId] = {
      ...(userState[targetChatId] || {}),
      step: 'dialog',
    };

    saveLead({
      type: 'owner_reply',
      createdAt: new Date().toISOString(),
      chatId: targetChatId,
      message: replyText,
    });

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

  userState[chatId] = { step: 'main' };

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

  if (text === '🏠 В меню') {
    return sendMainMenu(chatId);
  }

  if (text === '⬅️ Назад') {
    return sendMainMenu(chatId);
  }

  if (isSpam(chatId)) {
    return bot.sendMessage(
      chatId,
      '⏳ Слишком быстро. Подожди пару секунд и отправь ещё раз.'
    );
  }

  // Если уже идёт диалог — просто пересылаем сообщение владельцу
  if (userState[chatId].step === 'dialog') {
    await forwardDialogMessageToOwner(msg);

    return bot.sendMessage(chatId, getDialogReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
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

    return bot.sendMessage(
      chatId,
      'Отлично 👍\n\nНапиши примерный бюджет:',
      {
        reply_markup: getDialogKeyboard(),
      }
    );
  }

  if (userState[chatId].step === 'wait_budget') {
    userState[chatId].budget = text;
    userState[chatId].step = 'wait_deadline';

    return bot.sendMessage(chatId, 'Хорошо 👌\n\nА какие сроки?', {
      reply_markup: getDialogKeyboard(),
    });
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
        `💰 <b>Бюджет:</b> ${escapeHtml(budget)}`,
        `⏳ <b>Сроки:</b> ${escapeHtml(deadline)}`,
      ],
      source: 'сайт/бот',
    });

    userState[chatId] = { step: 'dialog' };

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
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

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
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

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
  }

  if (text === 'Оставить заявку') {
    userState[chatId] = { step: 'wait_text' };

    return bot.sendMessage(
      chatId,
      'Опиши задачу одним сообщением, и Алексей получит её прямо в Telegram.',
      {
        reply_markup: getDialogKeyboard(),
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
      reply_markup: getDialogKeyboard(),
    });
  }

  return bot.sendMessage(chatId, 'Выбери нужный раздел кнопками ниже 👇', {
    reply_markup: getMainKeyboard(),
  });
});

bot.on('polling_error', (error) => {
  console.error('Ошибка polling:', error.message);
});
