/**
 * TEXTA — backend
 * Node.js + Express + Upstash Redis
 *
 * Данные (пользователи, сообщения) хранятся в Upstash Redis — облачном
 * хранилище, которое живёт отдельно от Render и не обнуляется при
 * перезапуске/передеплое сервиса.
 *
 * Обязательные переменные окружения (задаются в Render → Environment):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * (обе берутся со страницы базы данных на upstash.com — раздел "REST API")
 */

const express = require('express');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname))); // отдаём index.html, style.css, app.js

// ---------- Подключение к Upstash Redis ----------

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('ОШИБКА: не заданы UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
  console.error('Добавь их в Render → Settings → Environment → Add Environment Variable.');
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const USERS_INDEX_KEY = 'texta:users:index'; // множество всех username (для поиска)

function generateCode() {
  const num = Math.floor(100000 + Math.random() * 900000); // 6 цифр
  return `TC-${num}`;
}

function cleanUsername(username) {
  return String(username || '').trim().toLowerCase().replace(/^@/, '');
}

function publicUser(u) {
  return { username: u.username, displayName: u.displayName };
}

function chatIdBetween(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join('__');
}

async function getUser(username) {
  return await redis.get('texta:user:' + cleanUsername(username));
}

async function setUser(user) {
  await redis.set('texta:user:' + user.username, user);
  await redis.sadd(USERS_INDEX_KEY, user.username);
}

// ---------- API: регистрация ----------

app.post('/api/register', async (req, res) => {
  try {
    let { username, displayName } = req.body || {};

    if (!username || !displayName) {
      return res.status(400).json({ success: false, message: 'Укажите username и имя.' });
    }

    const cleanU = cleanUsername(username);
    displayName = String(displayName).trim();

    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!usernameRegex.test(cleanU)) {
      return res.status(400).json({
        success: false,
        message: 'Username должен быть 3-20 символов: латиница, цифры, "_".'
      });
    }

    if (displayName.length < 1 || displayName.length > 40) {
      return res.status(400).json({ success: false, message: 'Некорректная длина имени.' });
    }

    const existing = await getUser(cleanU);
    if (existing) {
      return res.status(409).json({ success: false, message: 'Этот @username уже занят.' });
    }

    const code = generateCode();
    const user = { username: cleanU, displayName, code, createdAt: Date.now() };
    await setUser(user);

    return res.json({ success: true, user: { username: cleanU, displayName, code } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: вход ----------

app.post('/api/login', async (req, res) => {
  try {
    const { username, code } = req.body || {};

    if (!username || !code) {
      return res.status(400).json({ success: false, message: 'Укажите username и код.' });
    }

    const user = await getUser(username);

    if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
      return res.status(401).json({ success: false, message: 'Неверный @username или код входа.' });
    }

    return res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: обновление профиля ----------

app.post('/api/profile/update', async (req, res) => {
  try {
    const { username, code, displayName } = req.body || {};

    const user = await getUser(username);
    if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
      return res.status(401).json({ success: false, message: 'Не удалось подтвердить личность.' });
    }

    const newName = String(displayName || '').trim();
    if (newName.length < 1 || newName.length > 40) {
      return res.status(400).json({ success: false, message: 'Некорректное имя.' });
    }

    user.displayName = newName;
    await setUser(user);

    return res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: поиск пользователей ----------

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
    const self = String(req.query.self || '').trim().toLowerCase();

    if (!q) return res.json({ success: true, results: [] });

    const allUsernames = await redis.smembers(USERS_INDEX_KEY);
    const candidates = allUsernames.filter(u => u !== self);
    if (!candidates.length) return res.json({ success: true, results: [] });

    const users = await redis.mget(...candidates.map(u => 'texta:user:' + u));

    const results = users
      .filter(Boolean)
      .filter(u => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
      .slice(0, 20)
      .map(publicUser);

    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: сообщения ----------

app.get('/api/messages', async (req, res) => {
  try {
    const { chatId, username, withUser } = req.query;

    let id = chatId;
    if (!id && username && withUser) {
      id = chatIdBetween(String(username), String(withUser));
    }
    if (!id) return res.status(400).json({ success: false, message: 'Не указан чат.' });

    const messages = await redis.lrange('texta:messages:' + id, 0, -1);
    res.json({ success: true, chatId: id, messages: messages || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { username, withUser, text, isFavorite } = req.body || {};

    if (!username || !text || !String(text).trim()) {
      return res.status(400).json({ success: false, message: 'Пустое сообщение.' });
    }
    if (!isFavorite && !withUser) {
      return res.status(400).json({ success: false, message: 'Не указан получатель.' });
    }

    const id = isFavorite ? `fav:${cleanUsername(username)}` : chatIdBetween(username, withUser);

    const message = {
      id: Date.now() + '-' + Math.floor(Math.random() * 1000),
      from: username,
      text: String(text).trim(),
      time: Date.now()
    };

    await redis.rpush('texta:messages:' + id, message);

    res.json({ success: true, chatId: id, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- Отдаём index.html на все остальные маршруты (SPA) ----------

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Texta server запущен: http://localhost:${PORT}`);
});
