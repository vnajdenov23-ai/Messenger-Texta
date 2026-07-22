/**
 * TEXTA — backend
 * Node.js + Express
 * Хранит пользователей и сообщения в database.json,
 * поэтому данные видны из любого браузера/устройства, обращающегося к этому серверу.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.json');

app.use(express.json());
app.use(express.static(path.join(__dirname))); // отдаём index.html, style.css, app.js

// ---------- Работа с "базой данных" (JSON-файл) ----------

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], messages: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { users: [], messages: {} };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateCode() {
  const num = Math.floor(100000 + Math.random() * 900000); // 6 цифр
  return `TC-${num}`;
}

function findUser(db, username) {
  const clean = String(username || '').trim().toLowerCase().replace(/^@/, '');
  return db.users.find(u => u.username.toLowerCase() === clean);
}

function publicUser(u) {
  return { username: u.username, displayName: u.displayName };
}

function chatIdBetween(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join('__');
}

// ---------- API: регистрация ----------

app.post('/api/register', (req, res) => {
  const db = readDB();
  let { username, displayName } = req.body || {};

  if (!username || !displayName) {
    return res.status(400).json({ success: false, message: 'Укажите username и имя.' });
  }

  username = String(username).trim().replace(/^@/, '');
  displayName = String(displayName).trim();

  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({
      success: false,
      message: 'Username должен быть 3-20 символов: латиница, цифры, "_".'
    });
  }

  if (displayName.length < 1 || displayName.length > 40) {
    return res.status(400).json({ success: false, message: 'Некорректная длина имени.' });
  }

  if (findUser(db, username)) {
    return res.status(409).json({ success: false, message: 'Этот @username уже занят.' });
  }

  const code = generateCode();
  const user = { username, displayName, code, createdAt: Date.now() };
  db.users.push(user);
  writeDB(db);

  return res.json({ success: true, user: { username, displayName, code } });
});

// ---------- API: вход ----------

app.post('/api/login', (req, res) => {
  const db = readDB();
  const { username, code } = req.body || {};

  if (!username || !code) {
    return res.status(400).json({ success: false, message: 'Укажите username и код.' });
  }

  const user = findUser(db, username);

  if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
    return res.status(401).json({ success: false, message: 'Неверный @username или код входа.' });
  }

  return res.json({ success: true, user: publicUser(user) });
});

// ---------- API: обновление профиля ----------

app.post('/api/profile/update', (req, res) => {
  const db = readDB();
  const { username, code, displayName } = req.body || {};

  const user = findUser(db, username);
  if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
    return res.status(401).json({ success: false, message: 'Не удалось подтвердить личность.' });
  }

  const newName = String(displayName || '').trim();
  if (newName.length < 1 || newName.length > 40) {
    return res.status(400).json({ success: false, message: 'Некорректное имя.' });
  }

  user.displayName = newName;
  writeDB(db);

  return res.json({ success: true, user: publicUser(user) });
});

// ---------- API: поиск пользователей ----------

app.get('/api/search', (req, res) => {
  const db = readDB();
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  const self = String(req.query.self || '').trim().toLowerCase();

  if (!q) return res.json({ success: true, results: [] });

  const results = db.users
    .filter(u => u.username.toLowerCase() !== self)
    .filter(u =>
      u.username.toLowerCase().includes(q) ||
      u.displayName.toLowerCase().includes(q)
    )
    .slice(0, 20)
    .map(publicUser);

  res.json({ success: true, results });
});

// ---------- API: сообщения ----------

// chatId для "Избранного" передаётся как fav:<username>
// chatId для диалога вычисляется сервером через параметр "with"

app.get('/api/messages', (req, res) => {
  const db = readDB();
  const { chatId, username, withUser } = req.query;

  let id = chatId;
  if (!id && username && withUser) {
    id = chatIdBetween(String(username), String(withUser));
  }
  if (!id) return res.status(400).json({ success: false, message: 'Не указан чат.' });

  const messages = db.messages[id] || [];
  res.json({ success: true, chatId: id, messages });
});

app.post('/api/messages', (req, res) => {
  const db = readDB();
  const { username, withUser, text, isFavorite } = req.body || {};

  if (!username || !text || !String(text).trim()) {
    return res.status(400).json({ success: false, message: 'Пустое сообщение.' });
  }
  if (!isFavorite && !withUser) {
    return res.status(400).json({ success: false, message: 'Не указан получатель.' });
  }

  const id = isFavorite ? `fav:${username.toLowerCase()}` : chatIdBetween(username, withUser);

  if (!db.messages[id]) db.messages[id] = [];

  const message = {
    id: Date.now() + '-' + Math.floor(Math.random() * 1000),
    from: username,
    text: String(text).trim(),
    time: Date.now()
  };

  db.messages[id].push(message);
  writeDB(db);

  res.json({ success: true, chatId: id, message });
});

// ---------- Отдаём index.html на все остальные маршруты (SPA) ----------

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Texta server запущен: http://localhost:${PORT}`);
});
