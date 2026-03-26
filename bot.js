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

const DB_FILE = path.join(__dirname, 'db.json');
const userState = {};
const spamMap = {};

const SPAM_COOLDOWN_MS = 1800;
const MAX_HISTORY = 50;
const TZ = 'Europe/Helsinki';

function nowIso() {
  return new Date().toISOString();
}

function getHelsinkiHour() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    timeZone: TZ,
  });
  return Number(formatter.format(new Date()));
}

function isNightTime() {
  const hour = getHelsinkiHour();
  return hour >= 23 || hour < 8;
}

function ensureDbFile() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: {},
      leads: [],
      replies: [],
      meta: {
        leadCounter: 0,
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDb() {
  try {
    ensureDbFile();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('Ошибка чтения db.json:', error.message);
    return {
      users: {},
      leads: [],
      replies: [],
      meta: { leadCounter: 0 },
    };
  }
}

function writeDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (error) {
    console.error('Ошибка записи db.json:', error.message);
  }
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function usernameOf(msg) {
  return msg.from?.username ? '@' + msg.from.username : 'нет';
}

function displayNameOf(msg) {
  return [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Не указано';
}

function getUserRecord(db, chatId, msg = null) {
  const key = String(chatId);
  if (!db.users[key]) {
    db.users[key] = {
      chatId,
      userId: msg?.from?.id || null,
      name: msg ? displayNameOf(msg) : 'Не указано',
      username: msg ? usernameOf(msg) : 'нет',
      source: 'unknown',
      currentStatus: 'new',
      activeDialog: false,
      service: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      history: [],
      leadIds: [],
    };
  }

  if (msg) {
    db.users[key].userId = msg.from?.id || db.users[key].userId;
    db.users[key].name = displayNameOf(msg);
    db.users[key].username = usernameOf(msg);
    db.users[key].updatedAt = nowIso();
  }

  return db.users[key];
}

function pushHistory(user, item) {
  user.history.push({
    ...item,
    createdAt: nowIso(),
  });

  if (user.history.length > MAX_HISTORY) {
    user.history = user.history.slice(-MAX_HISTORY);
  }
}

function nextLeadId(db) {
  db.meta.leadCounter = (db.meta.leadCounter || 0) + 1;
  return db.meta.leadCounter;
}

function isSpam(chatId, text = '') {
  const now = Date.now();
  const last = spamMap[chatId] || { time: 0, text: '' };

  const tooFast = now - last.time < SPAM_COOLDOWN_MS;
  const sameText = last.text === text;

  spamMap[chatId] = { time: now, text };

  return tooFast && sameText;
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
      ['Проблема с ПК', 'Не работает программа'],
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

function leadStatusLabel(status) {
  const map = {
    new: 'Новая',
    in_progress: 'В работе',
    waiting: 'Ждёт ответа',
    closed: 'Закрыта',
  };
  return map[status] || status;
}

function buildAdminLeadButtons(chatId) {
  return {
    inline_keyboard: [
      [
        { text: '🟡 В работу', callback_data: `status:${chatId}:in_progress` },
        { text: '🕓 Ждёт ответа', callback_data: `status:${chatId}:waiting` },
      ],
      [
        { text: '✅ Закрыть', callback_data: `status:${chatId}:closed` },
        { text: '💬 Шаблон', callback_data: `template:${chatId}:hello` },
      ],
    ],
  };
}

async function sendMainMenu(chatId, text = 'Выбери, что тебе нужно 👇') {
  userState[chatId] = { step: 'main' };
  await bot.sendMessage(chatId, text, { reply_markup: getMainKeyboard() });
}

function quickReplyHint(chatId) {
  return `/reply ${chatId} `;
}

function saveIncomingLead({
  msg,
  source,
  topic,
  details = [],
  type = 'lead',
}) {
  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  const leadId = nextLeadId(db);

  const lead = {
    id: leadId,
    type,
    source,
    topic,
    chatId: msg.chat.id,
    userId: msg.from?.id || null,
    name: displayNameOf(msg),
    username: usernameOf(msg),
    text: msg.text || msg.caption || '[без текста]',
    details,
    status: 'new',
    createdAt: nowIso(),
  };

  db.leads.push(lead);
  user.currentStatus = 'new';
  user.activeDialog = true;
  user.service = topic;
  user.source = source;
  user.leadIds.push(leadId);

  pushHistory(user, {
    role: 'user',
    kind: type,
    text: lead.text,
    topic,
  });

  writeDb(db);
  return lead;
}

function saveDialogMessage(msg, topic = 'Продолжение переписки') {
  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);

  const leadId = nextLeadId(db);
  const lead = {
    id: leadId,
    type: 'dialog_message',
    source: user.source || 'dialog',
    topic,
    chatId: msg.chat.id,
    userId: msg.from?.id || null,
    name: displayNameOf(msg),
    username: usernameOf(msg),
    text: msg.text || msg.caption || '[медиа]',
    details: [],
    status: user.currentStatus || 'new',
    createdAt: nowIso(),
  };

  db.leads.push(lead);
  pushHistory(user, {
    role: 'user',
    kind: 'dialog_message',
    text: lead.text,
    topic,
  });

  writeDb(db);
  return lead;
}

function saveOwnerReply(chatId, text) {
  const db = readDb();
  const user = getUserRecord(db, chatId);

  db.replies.push({
    chatId,
    text,
    createdAt: nowIso(),
  });

  user.activeDialog = true;
  if (user.currentStatus === 'new') {
    user.currentStatus = 'in_progress';
  }

  pushHistory(user, {
    role: 'owner',
    kind: 'reply',
    text,
    topic: 'Ответ владельца',
  });

  writeDb(db);
}

function updateUserStatus(chatId, status) {
  const db = readDb();
  const user = getUserRecord(db, chatId);

  user.currentStatus = status;
  user.activeDialog = status !== 'closed';
  user.updatedAt = nowIso();

  pushHistory(user, {
    role: 'system',
    kind: 'status_change',
    text: status,
    topic: 'Изменение статуса',
  });

  writeDb(db);
}

function closeDialog(chatId) {
  const db = readDb();
  const user = getUserRecord(db, chatId);

  user.activeDialog = false;
  user.currentStatus = 'closed';
  user.updatedAt = nowIso();

  pushHistory(user, {
    role: 'system',
    kind: 'dialog_closed',
    text: 'Диалог закрыт',
    topic: 'Закрытие диалога',
  });

  writeDb(db);
}

function getUserSummary(chatId) {
  const db = readDb();
  const user = db.users[String(chatId)];
  if (!user) return null;
  return user;
}

async function notifyOwnerAboutLead({
  msg,
  title,
  source,
  topic,
  details = [],
}) {
  const name = displayNameOf(msg);
  const username = usernameOf(msg);

  const lead = saveIncomingLead({
    msg,
    source,
    topic,
    details,
    type: title === 'Новое сообщение в диалоге' ? 'dialog_message' : 'lead',
  });

  const extraText = details.length ? '\n' + details.join('\n') : '';

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `📩 <b>${escapeHtml(title)}</b>

#lead_${lead.id}

📍 <b>Источник:</b> ${escapeHtml(source)}
📌 <b>Тема:</b> ${escapeHtml(topic)}
📊 <b>Статус:</b> ${escapeHtml(leadStatusLabel('new'))}
👤 <b>Имя:</b> ${escapeHtml(name)}
🔗 <b>Username:</b> ${escapeHtml(username)}
🆔 <b>User ID:</b> ${escapeHtml(String(msg.from?.id || ''))}
💬 <b>Chat ID:</b> ${escapeHtml(String(msg.chat.id))}
${extraText}

<b>Сообщение:</b>
${escapeHtml(msg.text || msg.caption || '[без текста]')}

<b>Быстрый ответ:</b>
<code>${escapeHtml(quickReplyHint(msg.chat.id))}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: buildAdminLeadButtons(msg.chat.id),
    }
  );
}

async function notifyOwnerAboutDialogMessage(msg) {
  const name = displayNameOf(msg);
  const username = usernameOf(msg);

  const lead = saveDialogMessage(msg);

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `💬 <b>Новое сообщение в диалоге</b>

#lead_${lead.id}

📌 <b>Тема:</b> Продолжение переписки
📊 <b>Статус:</b> ${escapeHtml(leadStatusLabel(getUserSummary(msg.chat.id)?.currentStatus || 'new'))}
👤 <b>Имя:</b> ${escapeHtml(name)}
🔗 <b>Username:</b> ${escapeHtml(username)}
💬 <b>Chat ID:</b> ${escapeHtml(String(msg.chat.id))}

<b>Сообщение:</b>
${escapeHtml(msg.text || msg.caption || '[без текста]')}

<b>Быстрый ответ:</b>
<code>${escapeHtml(quickReplyHint(msg.chat.id))}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: buildAdminLeadButtons(msg.chat.id),
    }
  );
}

async function notifyOwnerAboutMedia(msg, mediaType) {
  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);

  const leadId = nextLeadId(db);
  db.leads.push({
    id: leadId,
    type: 'media',
    source: user.source || 'dialog',
    topic: `Медиа: ${mediaType}`,
    chatId: msg.chat.id,
    userId: msg.from?.id || null,
    name: displayNameOf(msg),
    username: usernameOf(msg),
    text: msg.caption || `[${mediaType}]`,
    details: [],
    status: user.currentStatus || 'new',
    createdAt: nowIso(),
  });

  pushHistory(user, {
    role: 'user',
    kind: 'media',
    text: msg.caption || `[${mediaType}]`,
    topic: `Медиа: ${mediaType}`,
  });

  writeDb(db);

  await bot.sendMessage(
    OWNER_CHAT_ID,
    `📎 <b>Новое медиа-сообщение</b>

#lead_${leadId}

👤 <b>Имя:</b> ${escapeHtml(displayNameOf(msg))}
🔗 <b>Username:</b> ${escapeHtml(usernameOf(msg))}
💬 <b>Chat ID:</b> ${escapeHtml(String(msg.chat.id))}
📦 <b>Тип:</b> ${escapeHtml(mediaType)}
${msg.caption ? `\n<b>Подпись:</b>\n${escapeHtml(msg.caption)}` : ''}

<b>Быстрый ответ:</b>
<code>${escapeHtml(quickReplyHint(msg.chat.id))}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: buildAdminLeadButtons(msg.chat.id),
    }
  );

  try {
    await bot.forwardMessage(OWNER_CHAT_ID, msg.chat.id, msg.message_id);
  } catch (error) {
    console.error('Не удалось переслать медиа:', error.message);
  }
}

function getOnlineReplyText() {
  if (isNightTime()) {
    return `✅ Заявку получил

🌙 Сейчас позднее время
💬 Алексей ответит, как только будет на связи.

Ты можешь продолжать писать сюда — бот всё сохранит и передаст.`;
  }

  return `✅ Заявку получил

🟢 Алексей сейчас онлайн
💬 Ответ обычно в течение 10–30 минут

Ты можешь продолжать писать сюда — бот передаст сообщения без выбора темы заново.`;
}

function getDialogReplyText() {
  if (isNightTime()) {
    return `✅ Сообщение передал

🌙 Сейчас позднее время
💬 Алексей ответит позже, но сообщение уже сохранено.

Чтобы начать заново — нажми «🏠 В меню».`;
  }

  return `✅ Сообщение передал

🟢 Алексей сейчас онлайн
💬 Можешь продолжать писать сюда.

Чтобы начать заново — нажми «🏠 В меню».`;
}

async function sendStatusToUser(chatId, status) {
  const textMap = {
    in_progress: '🟡 Алексей взял твою заявку в работу.',
    waiting: '🕓 Алексей посмотрел заявку. Сейчас ждём следующий шаг / уточнение.',
    closed: '✅ Диалог закрыт. Если понадобится что-то ещё — просто напиши снова.',
    new: '📩 Заявка создана.',
  };

  try {
    await bot.sendMessage(chatId, textMap[status] || 'Статус обновлён.');
  } catch (error) {
    console.error('Не удалось отправить статус пользователю:', error.message);
  }
}

// =========================
// АДМИН-КОМАНДЫ
// =========================

bot.onText(/^\/reply\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const targetChatId = Number(match[1]);
  const replyText = match[2].trim();

  if (!targetChatId || !replyText) {
    return bot.sendMessage(msg.chat.id, 'Использование:\n/reply CHAT_ID текст_ответа');
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

    updateUserStatus(targetChatId, 'in_progress');
    saveOwnerReply(targetChatId, replyText);

    await bot.sendMessage(msg.chat.id, `✅ Ответ отправлен пользователю ${targetChatId}`);
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `❌ Не удалось отправить ответ: ${error.message}`);
  }
});

bot.onText(/^\/close\s+(\d+)/, async (msg, match) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const targetChatId = Number(match[1]);
  if (!targetChatId) {
    return bot.sendMessage(msg.chat.id, 'Использование:\n/close CHAT_ID');
  }

  closeDialog(targetChatId);
  userState[targetChatId] = { step: 'main' };

  try {
    await bot.sendMessage(
      targetChatId,
      '✅ Диалог закрыт.\n\nЕсли понадобится что-то ещё — нажми «🏠 В меню» или просто напиши заново.',
      {
        reply_markup: getMainKeyboard(),
      }
    );
  } catch (error) {
    console.error('Не удалось уведомить пользователя о закрытии:', error.message);
  }

  return bot.sendMessage(msg.chat.id, `✅ Диалог с ${targetChatId} закрыт`);
});

bot.onText(/^\/status\s+(\d+)\s+(new|in_progress|waiting|closed)$/i, async (msg, match) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const targetChatId = Number(match[1]);
  const status = match[2];

  updateUserStatus(targetChatId, status);
  await sendStatusToUser(targetChatId, status);

  if (status === 'closed') {
    userState[targetChatId] = { step: 'main' };
  }

  return bot.sendMessage(
    msg.chat.id,
    `✅ Статус для ${targetChatId} изменён на "${leadStatusLabel(status)}"`
  );
});

bot.onText(/^\/stats$/, async (msg) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const db = readDb();
  const totalLeads = db.leads.filter((x) => x.type === 'lead').length;
  const totalDialogs = Object.values(db.users).filter((u) => u.activeDialog).length;
  const statusCounts = Object.values(db.users).reduce(
    (acc, user) => {
      acc[user.currentStatus] = (acc[user.currentStatus] || 0) + 1;
      return acc;
    },
    { new: 0, in_progress: 0, waiting: 0, closed: 0 }
  );

  return bot.sendMessage(
    msg.chat.id,
    `📊 Статистика бота

📩 Всего заявок: ${totalLeads}
💬 Активных диалогов: ${totalDialogs}

Статусы:
• Новых: ${statusCounts.new || 0}
• В работе: ${statusCounts.in_progress || 0}
• Ждут ответа: ${statusCounts.waiting || 0}
• Закрытых: ${statusCounts.closed || 0}`
  );
});

bot.onText(/^\/dialogs$/, async (msg) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const db = readDb();
  const active = Object.values(db.users).filter((u) => u.activeDialog);

  if (!active.length) {
    return bot.sendMessage(msg.chat.id, 'Сейчас активных диалогов нет.');
  }

  const lines = active.slice(-20).map((u) => {
    return `• ${u.name} | ${u.username} | ${u.chatId} | ${leadStatusLabel(u.currentStatus)}`;
  });

  return bot.sendMessage(
    msg.chat.id,
    `💬 Активные диалоги:

${lines.join('\n')}`
  );
});

bot.onText(/^\/last(?:\s+(\d+))?$/, async (msg, match) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const count = Math.min(Number(match?.[1] || 5), 20);
  const db = readDb();
  const items = db.leads.slice(-count).reverse();

  if (!items.length) {
    return bot.sendMessage(msg.chat.id, 'Заявок пока нет.');
  }

  const lines = items.map((x) => {
    return `#${x.id} | ${x.topic} | ${x.name} | ${x.chatId} | ${leadStatusLabel(x.status || 'new')}`;
  });

  return bot.sendMessage(
    msg.chat.id,
    `🧾 Последние ${items.length} записей:

${lines.join('\n')}`
  );
});

bot.onText(/^\/helpadmin$/, async (msg) => {
  if (msg.chat.id !== OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  return bot.sendMessage(
    msg.chat.id,
    `🛠 Админ-команды

/reply CHAT_ID текст
/close CHAT_ID
/status CHAT_ID new|in_progress|waiting|closed
/stats
/dialogs
/last 10
/helpadmin

Шаблоны:
• можно нажимать inline-кнопки в заявках
• для быстрого ответа используй /reply`
  );
});

// =========================
// CALLBACK-КНОПКИ
// =========================

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const data = query.data || '';

  if (chatId !== OWNER_CHAT_ID) {
    return bot.answerCallbackQuery(query.id, {
      text: 'Нет доступа',
      show_alert: true,
    });
  }

  try {
    if (data.startsWith('status:')) {
      const [, targetChatIdRaw, status] = data.split(':');
      const targetChatId = Number(targetChatIdRaw);

      updateUserStatus(targetChatId, status);
      await sendStatusToUser(targetChatId, status);

      if (status === 'closed') {
        userState[targetChatId] = { step: 'main' };
      }

      await bot.answerCallbackQuery(query.id, {
        text: `Статус: ${leadStatusLabel(status)}`,
      });

      return;
    }

    if (data.startsWith('template:')) {
      const [, targetChatIdRaw, templateKey] = data.split(':');
      const targetChatId = Number(targetChatIdRaw);

      let templateText = 'Привет! Увидел твою заявку. Напиши, пожалуйста, подробнее.';
      if (templateKey === 'hello') {
        templateText = 'Привет 👋 Увидел твою заявку. Я на связи, можешь написать подробнее.';
      }

      await bot.sendMessage(
        targetChatId,
        `💬 <b>Алексей на связи</b>

${escapeHtml(templateText)}`,
        {
          parse_mode: 'HTML',
          reply_markup: getDialogKeyboard(),
        }
      );

      updateUserStatus(targetChatId, 'in_progress');
      saveOwnerReply(targetChatId, templateText);

      userState[targetChatId] = {
        ...(userState[targetChatId] || {}),
        step: 'dialog',
      };

      await bot.answerCallbackQuery(query.id, {
        text: 'Шаблон отправлен',
      });

      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Ошибка callback_query:', error.message);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Ошибка действия',
        show_alert: true,
      });
    } catch (_) {}
  }
});

// =========================
// START
// =========================

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const source = match?.[1] || 'direct';

  const db = readDb();
  const user = getUserRecord(db, chatId, msg);
  user.source = source;
  user.updatedAt = nowIso();
  writeDb(db);

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
  }, 700);
});

// =========================
// МЕДИА
// =========================

bot.on('photo', async (msg) => {
  if (msg.chat.id === OWNER_CHAT_ID) return;
  if (isSpam(msg.chat.id, 'photo:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyOwnerAboutMedia(msg, 'фото');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('document', async (msg) => {
  if (msg.chat.id === OWNER_CHAT_ID) return;
  if (isSpam(msg.chat.id, 'document:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyOwnerAboutMedia(msg, 'документ');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('voice', async (msg) => {
  if (msg.chat.id === OWNER_CHAT_ID) return;
  if (isSpam(msg.chat.id, 'voice')) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyOwnerAboutMedia(msg, 'голосовое');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('video', async (msg) => {
  if (msg.chat.id === OWNER_CHAT_ID) return;
  if (isSpam(msg.chat.id, 'video:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyOwnerAboutMedia(msg, 'видео');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('sticker', async (msg) => {
  if (msg.chat.id === OWNER_CHAT_ID) return;
  if (isSpam(msg.chat.id, 'sticker')) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyOwnerAboutMedia(msg, 'стикер');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

// =========================
// ОСНОВНОЙ ТЕКСТОВЫЙ ОБРАБОТЧИК
// =========================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/start')) return;
  if (text.startsWith('/reply')) return;
  if (text.startsWith('/close')) return;
  if (text.startsWith('/status')) return;
  if (text.startsWith('/stats')) return;
  if (text.startsWith('/dialogs')) return;
  if (text.startsWith('/last')) return;
  if (text.startsWith('/helpadmin')) return;

  if (chatId === OWNER_CHAT_ID) {
    return;
  }

  if (!userState[chatId]) {
    userState[chatId] = { step: 'main' };
  }

  if (text === '🏠 В меню' || text === '⬅️ Назад') {
    return sendMainMenu(chatId);
  }

  if (isSpam(chatId, text)) {
    return bot.sendMessage(
      chatId,
      '⏳ Слишком быстро. Подожди пару секунд и отправь ещё раз.'
    );
  }

  // Если уже диалог активен — просто шлём дальше
  if (userState[chatId].step === 'dialog') {
    await notifyOwnerAboutDialogMessage(msg);

    const db = readDb();
    const user = getUserRecord(db, chatId, msg);
    user.activeDialog = true;
    if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
    writeDb(db);

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

  // ===== САЙТЫ =====
  if (
    text === 'Сайт-визитка' ||
    text === 'Лендинг' ||
    text === 'Доработка сайта' ||
    text === 'Интернет-магазин'
  ) {
    userState[chatId] = {
      step: 'wait_site_budget',
      topic: text,
    };

    return bot.sendMessage(chatId, 'Отлично 👍\n\nНапиши примерный бюджет:', {
      reply_markup: getDialogKeyboard(),
    });
  }

  if (userState[chatId].step === 'wait_site_budget') {
    userState[chatId].budget = text;
    userState[chatId].step = 'wait_site_deadline';

    return bot.sendMessage(chatId, 'Хорошо 👌\n\nА какие сроки?', {
      reply_markup: getDialogKeyboard(),
    });
  }

  if (userState[chatId].step === 'wait_site_deadline') {
    userState[chatId].deadline = text;

    await notifyOwnerAboutLead({
      msg,
      title: 'Новая заявка',
      source: 'сайт/бот',
      topic: `Сайт: ${userState[chatId].topic}`,
      details: [
        `💰 <b>Бюджет:</b> ${escapeHtml(userState[chatId].budget)}`,
        `⏳ <b>Сроки:</b> ${escapeHtml(userState[chatId].deadline)}`,
      ],
    });

    userState[chatId] = { step: 'dialog' };
    updateUserStatus(chatId, 'new');

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
  }

  // ===== ТЕХПОДДЕРЖКА =====
  if (
    text === 'Проблема с ПК' ||
    text === 'Не работает программа' ||
    text === 'Проблема с интернетом' ||
    text === 'Нужна удалённая помощь'
  ) {
    userState[chatId] = {
      step: 'wait_support_problem',
      topic: text,
    };

    return bot.sendMessage(
      chatId,
      'Опиши коротко, что случилось и что именно не работает:',
      {
        reply_markup: getDialogKeyboard(),
      }
    );
  }

  if (userState[chatId].step === 'wait_support_problem') {
    userState[chatId].problem = text;
    userState[chatId].step = 'wait_support_urgency';

    return bot.sendMessage(
      chatId,
      'Понял. Насколько это срочно?\n\nНапример: срочно / сегодня / не горит',
      {
        reply_markup: getDialogKeyboard(),
      }
    );
  }

  if (userState[chatId].step === 'wait_support_urgency') {
    userState[chatId].urgency = text;

    await notifyOwnerAboutLead({
      msg,
      title: 'Новая заявка',
      source: 'сайт/бот',
      topic: `Техподдержка: ${userState[chatId].topic}`,
      details: [
        `🛠 <b>Проблема:</b> ${escapeHtml(userState[chatId].problem)}`,
        `⏱ <b>Срочность:</b> ${escapeHtml(userState[chatId].urgency)}`,
      ],
    });

    userState[chatId] = { step: 'dialog' };
    updateUserStatus(chatId, 'new');

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
  }

  // ===== АДМИНИСТРИРОВАНИЕ =====
  if (
    text === 'Настройка ПК' ||
    text === 'Настройка сети' ||
    text === 'Удалённый доступ' ||
    text === 'Пользователи и права'
  ) {
    userState[chatId] = {
      step: 'wait_admin_scope',
      topic: text,
    };

    return bot.sendMessage(
      chatId,
      'Напиши, пожалуйста, что именно нужно настроить:',
      {
        reply_markup: getDialogKeyboard(),
      }
    );
  }

  if (userState[chatId].step === 'wait_admin_scope') {
    userState[chatId].scope = text;
    userState[chatId].step = 'wait_admin_format';

    return bot.sendMessage(
      chatId,
      'Это нужно удалённо или на месте?\n\nНапример: удалённо / на месте / не важно',
      {
        reply_markup: getDialogKeyboard(),
      }
    );
  }

  if (userState[chatId].step === 'wait_admin_format') {
    userState[chatId].format = text;

    await notifyOwnerAboutLead({
      msg,
      title: 'Новая заявка',
      source: 'сайт/бот',
      topic: `Администрирование: ${userState[chatId].topic}`,
      details: [
        `⚙️ <b>Что нужно:</b> ${escapeHtml(userState[chatId].scope)}`,
        `📍 <b>Формат:</b> ${escapeHtml(userState[chatId].format)}`,
      ],
    });

    userState[chatId] = { step: 'dialog' };
    updateUserStatus(chatId, 'new');

    return bot.sendMessage(chatId, getOnlineReplyText(), {
      reply_markup: getDialogKeyboard(),
    });
  }

  // ===== СВЯЗЬ =====
  if (text === 'Оставить заявку') {
    userState[chatId] = { step: 'wait_contact_text' };

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

  if (userState[chatId].step === 'wait_contact_text') {
    await notifyOwnerAboutLead({
      msg,
      title: 'Новая заявка',
      source: 'сайт/бот',
      topic: 'Связь с Алексеем',
      details: [],
    });

    userState[chatId] = { step: 'dialog' };
    updateUserStatus(chatId, 'new');

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
