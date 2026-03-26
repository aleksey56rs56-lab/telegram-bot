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
        admins: [],
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDb() {
  try {
    ensureDbFile();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);

    if (!db.meta) db.meta = {};
    if (!Array.isArray(db.meta.admins)) db.meta.admins = [];
    if (typeof db.meta.leadCounter !== 'number') db.meta.leadCounter = 0;
    if (!db.users) db.users = {};
    if (!Array.isArray(db.leads)) db.leads = [];
    if (!Array.isArray(db.replies)) db.replies = [];

    return db;
  } catch (error) {
    console.error('Ошибка чтения db.json:', error.message);
    return {
      users: {},
      leads: [],
      replies: [],
      meta: { leadCounter: 0, admins: [] },
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

function isOwner(chatId) {
  return Number(chatId) === OWNER_CHAT_ID;
}

function isAdmin(chatId) {
  const db = readDb();
  return isOwner(chatId) || db.meta.admins.includes(Number(chatId));
}

function addAdmin(chatId) {
  const db = readDb();
  const id = Number(chatId);

  if (!db.meta.admins.includes(id)) {
    db.meta.admins.push(id);
    writeDb(db);
  }
}

function removeAdmin(chatId) {
  const db = readDb();
  const id = Number(chatId);
  db.meta.admins = db.meta.admins.filter((x) => x !== id);
  writeDb(db);
}

function listAdmins() {
  const db = readDb();
  return db.meta.admins || [];
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

function getAdminKeyboardUser() {
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

function getAdminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Статистика', callback_data: 'admin:stats' },
        { text: '💬 Диалоги', callback_data: 'admin:dialogs' },
      ],
      [
        { text: '🧾 Последние', callback_data: 'admin:last' },
        { text: '🧩 Шаблоны', callback_data: 'admin:templates' },
      ],
      [
        { text: '👮 Админы', callback_data: 'admin:admins' },
        { text: '🏠 Главное меню', callback_data: 'admin:home' },
      ],
    ],
  };
}

function getTemplatesKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🌐 Шаблон сайт', callback_data: 'admin_template:site' },
        { text: '🛠 Шаблон техподдержка', callback_data: 'admin_template:support' },
      ],
      [
        { text: '⚙️ Шаблон админ', callback_data: 'admin_template:admin' },
      ],
      [
        { text: '⬅️ Назад', callback_data: 'admin:home' },
      ],
    ],
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
    topic: 'Ответ админа',
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
  return db.users[String(chatId)] || null;
}

async function notifyAdmins(text, options = {}) {
  const adminIds = [OWNER_CHAT_ID, ...listAdmins()];
  const unique = [...new Set(adminIds.map(Number))];

  for (const id of unique) {
    try {
      await bot.sendMessage(id, text, options);
    } catch (error) {
      console.error(`Не удалось отправить сообщение админу ${id}:`, error.message);
    }
  }
}

async function notifyAdminsAboutLead({
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

  await notifyAdmins(
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

async function notifyAdminsAboutDialogMessage(msg) {
  const name = displayNameOf(msg);
  const username = usernameOf(msg);

  const lead = saveDialogMessage(msg);

  await notifyAdmins(
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

async function notifyAdminsAboutMedia(msg, mediaType) {
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

  await notifyAdmins(
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

  const adminIds = [OWNER_CHAT_ID, ...listAdmins()];
  const unique = [...new Set(adminIds.map(Number))];

  for (const id of unique) {
    try {
      await bot.forwardMessage(id, msg.chat.id, msg.message_id);
    } catch (error) {
      console.error(`Не удалось переслать медиа админу ${id}:`, error.message);
    }
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

function buildStatsText() {
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

  return `📊 <b>Статистика бота</b>

📩 Всего заявок: ${totalLeads}
💬 Активных диалогов: ${totalDialogs}

<b>Статусы:</b>
• Новых: ${statusCounts.new || 0}
• В работе: ${statusCounts.in_progress || 0}
• Ждут ответа: ${statusCounts.waiting || 0}
• Закрытых: ${statusCounts.closed || 0}`;
}

function buildDialogsText() {
  const db = readDb();
  const active = Object.values(db.users).filter((u) => u.activeDialog);

  if (!active.length) {
    return 'Сейчас активных диалогов нет.';
  }

  const lines = active.slice(-20).map((u) => {
    return `• ${u.name} | ${u.username} | ${u.chatId} | ${leadStatusLabel(u.currentStatus)}`;
  });

  return `💬 <b>Активные диалоги</b>

${escapeHtml(lines.join('\n'))}`;
}

function buildLastText(count = 8) {
  const db = readDb();
  const items = db.leads.slice(-count).reverse();

  if (!items.length) {
    return 'Заявок пока нет.';
  }

  const lines = items.map((x) => {
    return `#${x.id} | ${x.topic} | ${x.name} | ${x.chatId} | ${leadStatusLabel(x.status || 'new')}`;
  });

  return `🧾 <b>Последние записи</b>

${escapeHtml(lines.join('\n'))}`;
}

function buildAdminsText() {
  const admins = listAdmins();

  if (!admins.length) {
    return `👮 <b>Дополнительных админов пока нет</b>

Команды:
<code>/addadmin CHAT_ID</code>
<code>/deladmin CHAT_ID</code>
<code>/admins</code>`;
  }

  const lines = admins.map((id) => `• ${id}`);

  return `👮 <b>Список админов</b>

${escapeHtml(lines.join('\n'))}

Команды:
<code>/addadmin CHAT_ID</code>
<code>/deladmin CHAT_ID</code>
<code>/admins</code>`;
}

async function sendAdminPanel(chatId) {
  return bot.sendMessage(
    chatId,
    `🛠 <b>Мини админка</b>

Выбери действие ниже.`,
    {
      parse_mode: 'HTML',
      reply_markup: getAdminPanelKeyboard(),
    }
  );
}

// =========================
// АДМИН-КОМАНДЫ
// =========================

bot.onText(/^\/admin$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  return sendAdminPanel(msg.chat.id);
});

bot.onText(/^\/addadmin\s+(\d+)$/, async (msg, match) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ Назначать админов может только владелец.');
  }

  const targetChatId = Number(match[1]);

  if (!targetChatId) {
    return bot.sendMessage(msg.chat.id, 'Использование:\n/addadmin CHAT_ID');
  }

  if (targetChatId === OWNER_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, 'Этот chat id уже владелец.');
  }

  addAdmin(targetChatId);

  try {
    await bot.sendMessage(
      targetChatId,
      '✅ Тебе выдали права администратора.\n\nТеперь тебе доступны /admin, /stats, /dialogs, /reply и другие админ-команды.'
    );
  } catch (error) {
    console.error('Не удалось уведомить нового админа:', error.message);
  }

  return bot.sendMessage(msg.chat.id, `✅ Админ ${targetChatId} добавлен`);
});

bot.onText(/^\/deladmin\s+(\d+)$/, async (msg, match) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ Удалять админов может только владелец.');
  }

  const targetChatId = Number(match[1]);

  if (!targetChatId) {
    return bot.sendMessage(msg.chat.id, 'Использование:\n/deladmin CHAT_ID');
  }

  removeAdmin(targetChatId);

  try {
    await bot.sendMessage(
      targetChatId,
      'ℹ️ Права администратора у тебя сняты.'
    );
  } catch (error) {
    console.error('Не удалось уведомить удалённого админа:', error.message);
  }

  return bot.sendMessage(msg.chat.id, `✅ Админ ${targetChatId} удалён`);
});

bot.onText(/^\/admins$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  return bot.sendMessage(msg.chat.id, buildAdminsText(), {
    parse_mode: 'HTML',
  });
});

bot.onText(/^\/reply\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) {
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
  if (!isAdmin(msg.chat.id)) {
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
  if (!isAdmin(msg.chat.id)) {
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
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  return bot.sendMessage(msg.chat.id, buildStatsText(), {
    parse_mode: 'HTML',
  });
});

bot.onText(/^\/dialogs$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  return bot.sendMessage(msg.chat.id, buildDialogsText(), {
    parse_mode: 'HTML',
  });
});

bot.onText(/^\/last(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const count = Math.min(Number(match?.[1] || 8), 20);

  return bot.sendMessage(msg.chat.id, buildLastText(count), {
    parse_mode: 'HTML',
  });
});

bot.onText(/^\/helpadmin$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У тебя нет доступа к этой команде.');
  }

  const addAdminBlock = isOwner(msg.chat.id)
    ? `\n<code>/addadmin CHAT_ID</code> — выдать права\n<code>/deladmin CHAT_ID</code> — снять права\n<code>/admins</code> — список админов`
    : `\n<code>/admins</code> — список админов`;

  return bot.sendMessage(
    msg.chat.id,
    `🛠 <b>Админ-команды</b>

<code>/admin</code> — открыть мини админку
<code>/reply CHAT_ID текст</code> — ответить клиенту
<code>/close CHAT_ID</code> — закрыть диалог
<code>/status CHAT_ID new|in_progress|waiting|closed</code>
<code>/stats</code> — статистика
<code>/dialogs</code> — активные диалоги
<code>/last 10</code> — последние заявки
<code>/helpadmin</code> — список команд${addAdminBlock}`,
    { parse_mode: 'HTML' }
  );
});

// =========================
// CALLBACK-КНОПКИ
// =========================

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const data = query.data || '';

  if (!isAdmin(chatId)) {
    return bot.answerCallbackQuery(query.id, {
      text: 'Нет доступа',
      show_alert: true,
    });
  }

  try {
    if (data === 'admin:stats') {
      await bot.sendMessage(chatId, buildStatsText(), {
        parse_mode: 'HTML',
      });
      return bot.answerCallbackQuery(query.id, { text: 'Готово' });
    }

    if (data === 'admin:dialogs') {
      await bot.sendMessage(chatId, buildDialogsText(), {
        parse_mode: 'HTML',
      });
      return bot.answerCallbackQuery(query.id, { text: 'Готово' });
    }

    if (data === 'admin:last') {
      await bot.sendMessage(chatId, buildLastText(8), {
        parse_mode: 'HTML',
      });
      return bot.answerCallbackQuery(query.id, { text: 'Готово' });
    }

    if (data === 'admin:templates') {
      await bot.sendMessage(
        chatId,
        '🧩 <b>Шаблоны быстрых ответов</b>',
        {
          parse_mode: 'HTML',
          reply_markup: getTemplatesKeyboard(),
        }
      );
      return bot.answerCallbackQuery(query.id, { text: 'Открыто' });
    }

    if (data === 'admin:admins') {
      await bot.sendMessage(chatId, buildAdminsText(), {
        parse_mode: 'HTML',
      });
      return bot.answerCallbackQuery(query.id, { text: 'Готово' });
    }

    if (data === 'admin:home') {
      await sendAdminPanel(chatId);
      return bot.answerCallbackQuery(query.id, { text: 'Назад' });
    }

    if (data.startsWith('admin_template:')) {
      const key = data.split(':')[1];
      let text = 'Привет! Увидел заявку. Напиши, пожалуйста, подробнее.';
      if (key === 'site') {
        text = 'Шаблон для сайта:\n/reply CHAT_ID Привет 👋 Увидел заявку по сайту. Напиши, пожалуйста, подробнее, какой результат хочешь получить.';
      } else if (key === 'support') {
        text = 'Шаблон для техподдержки:\n/reply CHAT_ID Привет 👋 Увидел твою заявку. Опиши, пожалуйста, что именно не работает и какая сейчас ошибка.';
      } else if (key === 'admin') {
        text = 'Шаблон для администрирования:\n/reply CHAT_ID Привет 👋 Увидел заявку. Напиши, пожалуйста, что именно нужно настроить и в каком формате это удобнее сделать.';
      }

      await bot.sendMessage(chatId, text);
      return bot.answerCallbackQuery(query.id, { text: 'Шаблон отправлен' });
    }

    if (data.startsWith('status:')) {
      const [, targetChatIdRaw, status] = data.split(':');
      const targetChatId = Number(targetChatIdRaw);

      updateUserStatus(targetChatId, status);
      await sendStatusToUser(targetChatId, status);

      if (status === 'closed') {
        userState[targetChatId] = { step: 'main' };
      }

      return bot.answerCallbackQuery(query.id, {
        text: `Статус: ${leadStatusLabel(status)}`,
      });
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

      return bot.answerCallbackQuery(query.id, {
        text: 'Шаблон отправлен',
      });
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
  if (isAdmin(msg.chat.id)) return;
  if (isSpam(msg.chat.id, 'photo:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyAdminsAboutMedia(msg, 'фото');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('document', async (msg) => {
  if (isAdmin(msg.chat.id)) return;
  if (isSpam(msg.chat.id, 'document:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyAdminsAboutMedia(msg, 'документ');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('voice', async (msg) => {
  if (isAdmin(msg.chat.id)) return;
  if (isSpam(msg.chat.id, 'voice')) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyAdminsAboutMedia(msg, 'голосовое');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('video', async (msg) => {
  if (isAdmin(msg.chat.id)) return;
  if (isSpam(msg.chat.id, 'video:' + (msg.caption || ''))) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyAdminsAboutMedia(msg, 'видео');
  await bot.sendMessage(msg.chat.id, getDialogReplyText(), {
    reply_markup: getDialogKeyboard(),
  });
});

bot.on('sticker', async (msg) => {
  if (isAdmin(msg.chat.id)) return;
  if (isSpam(msg.chat.id, 'sticker')) return;

  const db = readDb();
  const user = getUserRecord(db, msg.chat.id, msg);
  user.activeDialog = true;
  if (user.currentStatus === 'new') user.currentStatus = 'in_progress';
  writeDb(db);

  userState[msg.chat.id] = { step: 'dialog' };

  await notifyAdminsAboutMedia(msg, 'стикер');
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
  if (text.startsWith('/admin')) return;
  if (text.startsWith('/addadmin')) return;
  if (text.startsWith('/deladmin')) return;
  if (text.startsWith('/admins')) return;

  if (isAdmin(chatId)) {
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

  if (userState[chatId].step === 'dialog') {
    await notifyAdminsAboutDialogMessage(msg);

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
      reply_markup: getAdminKeyboardUser(),
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

    await notifyAdminsAboutLead({
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

    await notifyAdminsAboutLead({
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

    await notifyAdminsAboutLead({
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
    await notifyAdminsAboutLead({
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
