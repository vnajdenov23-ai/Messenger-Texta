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
 */

const express = require('express');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname)));

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('ОШИБКА: не заданы UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
  console.error('Добавь их в Render → Settings → Environment → Add Environment Variable.');
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const USERS_INDEX_KEY = 'texta:users:index';
const DELETE_FOR_EVERYONE_WINDOW_MS = 60 * 60 * 1000; // 1 час
const MAX_AVATAR_LENGTH = 400000;
const MAX_PHOTO_LENGTH = 3000000;
const MAX_VOICE_LENGTH = 2500000;
const ONLINE_THRESHOLD_MS = 45000; // считаем "в сети", если пинг был < 45 сек назад

function generateCode() {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `TC-${num}`;
}

function cleanUsername(username) {
  return String(username || '').trim().toLowerCase().replace(/^@/, '');
}

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    avatarType: u.avatarType || 'initial',
    avatarValue: u.avatarValue || ''
  };
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

async function isBlocked(blockerUsername, targetUsername) {
  const blocked = await redis.smembers('texta:blocked:' + cleanUsername(blockerUsername));
  return blocked.includes(cleanUsername(targetUsername));
}

function formatLastSeen(ts) {
  if (!ts) return 'давно';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `был(а) сегодня в ${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `был(а) вчера в ${hh}:${mm}`;
  return `был(а) ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function computePresenceText(target) {
  const mode = target.presencePrivacy || 'visible';
  const online = Date.now() - (target.lastActiveAt || 0) < ONLINE_THRESHOLD_MS;

  if (mode === 'hidden') return 'был(а) недавно';
  if (mode === 'partial') return online ? 'в сети' : 'был(а) недавно';
  return online ? 'в сети' : formatLastSeen(target.lastActiveAt);
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
    const user = {
      username: cleanU,
      displayName,
      code,
      createdAt: Date.now(),
      avatarType: 'initial',
      avatarValue: '',
      presencePrivacy: 'visible',
      lastActiveAt: Date.now()
    };
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

    user.lastActiveAt = Date.now();
    await setUser(user);

    return res.json({
      success: true,
      user: { ...publicUser(user), code: user.code, presencePrivacy: user.presencePrivacy || 'visible' }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: обновление профиля (имя + аватарка + приватность) ----------

app.post('/api/profile/update', async (req, res) => {
  try {
    const { username, code, displayName, avatarType, avatarValue, presencePrivacy } = req.body || {};

    const user = await getUser(username);
    if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
      return res.status(401).json({ success: false, message: 'Не удалось подтвердить личность.' });
    }

    if (displayName !== undefined) {
      const newName = String(displayName).trim();
      if (newName.length < 1 || newName.length > 40) {
        return res.status(400).json({ success: false, message: 'Некорректное имя.' });
      }
      user.displayName = newName;
    }

    if (avatarType !== undefined) {
      if (!['initial', 'emoji', 'photo'].includes(avatarType)) {
        return res.status(400).json({ success: false, message: 'Некорректный тип аватарки.' });
      }
      if (avatarType === 'photo' && String(avatarValue || '').length > MAX_AVATAR_LENGTH) {
        return res.status(400).json({ success: false, message: 'Фото слишком большое, выбери другое.' });
      }
      user.avatarType = avatarType;
      user.avatarValue = avatarType === 'initial' ? '' : String(avatarValue || '');
    }

    if (presencePrivacy !== undefined) {
      if (!['visible', 'partial', 'hidden'].includes(presencePrivacy)) {
        return res.status(400).json({ success: false, message: 'Некорректная настройка приватности.' });
      }
      user.presencePrivacy = presencePrivacy;
    }

    await setUser(user);

    return res.json({
      success: true,
      user: { ...publicUser(user), code: user.code, presencePrivacy: user.presencePrivacy || 'visible' }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: удаление аккаунта (сам аккаунт уходит, переписки остаются) ----------

app.post('/api/account/delete', async (req, res) => {
  try {
    const { username, code } = req.body || {};
    const user = await getUser(username);
    if (!user || user.code.toUpperCase() !== String(code).trim().toUpperCase()) {
      return res.status(401).json({ success: false, message: 'Не удалось подтвердить личность.' });
    }

    const cleanU = user.username;
    await redis.del('texta:user:' + cleanU);
    await redis.srem(USERS_INDEX_KEY, cleanU);
    // Сообщения, чаты и списки собеседников намеренно не трогаем —
    // у других участников переписка должна остаться, просто с пометкой "аккаунт удалён".

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: присутствие (heartbeat + чтение статуса) ----------

app.post('/api/presence/ping', async (req, res) => {
  try {
    const user = await getUser(req.body && req.body.username);
    if (!user) return res.status(404).json({ success: false });
    user.lastActiveAt = Date.now();
    await setUser(user);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.get('/api/presence', async (req, res) => {
  try {
    const viewer = cleanUsername(req.query.viewer);
    const target = cleanUsername(req.query.username);
    if (!viewer || !target) return res.status(400).json({ success: false });

    const targetUser = await getUser(target);
    if (!targetUser) return res.json({ success: true, state: 'deleted' });

    const [iBlockedThem, theyBlockedMe] = await Promise.all([
      isBlocked(viewer, target),
      isBlocked(target, viewer)
    ]);
    if (iBlockedThem || theyBlockedMe) {
      return res.json({ success: true, state: 'blocked', iBlockedThem, theyBlockedMe });
    }

    res.json({ success: true, state: 'ok', text: computePresenceText(targetUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- API: публичный профиль пользователя ----------

app.get('/api/profile', async (req, res) => {
  try {
    const username = cleanUsername(req.query.username);
    if (!username) return res.status(400).json({ success: false, message: 'Не указан username.' });

    const user = await getUser(username);
    if (!user) return res.json({ success: true, deleted: true });

    res.json({ success: true, user: { ...publicUser(user), createdAt: user.createdAt || 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
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
    const { chatId, username, withUser, forUser } = req.query;

    let id = chatId;
    if (!id && username && withUser) {
      id = chatIdBetween(String(username), String(withUser));
    }
    if (!id) return res.status(400).json({ success: false, message: 'Не указан чат.' });

    let messages = await redis.lrange('texta:messages:' + id, 0, -1);
    messages = messages || [];

    const requester = cleanUsername(forUser || username);
    if (requester) {
      const [deletedIds, clearedAt] = await Promise.all([
        redis.smembers('texta:deleted:' + requester + ':' + id),
        redis.get('texta:cleared:' + requester + ':' + id)
      ]);

      if (deletedIds.length) {
        const deletedSet = new Set(deletedIds);
        messages = messages.filter(m => !deletedSet.has(m.id));
      }
      if (clearedAt) {
        messages = messages.filter(m => m.time > clearedAt);
      }
    }

    res.json({ success: true, chatId: id, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { username, withUser, text, isFavorite, type, media, voiceDuration, waveform } = req.body || {};
    const msgType = type === 'photo' || type === 'voice' ? type : 'text';

    if (msgType === 'text') {
      if (!username || !text || !String(text).trim()) {
        return res.status(400).json({ success: false, message: 'Пустое сообщение.' });
      }
    } else {
      if (!username || !media) {
        return res.status(400).json({ success: false, message: 'Не хватает данных сообщения.' });
      }
      const limit = msgType === 'photo' ? MAX_PHOTO_LENGTH : MAX_VOICE_LENGTH;
      if (String(media).length > limit) {
        return res.status(400).json({ success: false, message: 'Файл слишком большой.' });
      }
    }
    if (!isFavorite && !withUser) {
      return res.status(400).json({ success: false, message: 'Не указан получатель.' });
    }

    if (!isFavorite) {
      const recipientExists = await getUser(withUser);
      if (!recipientExists) {
        return res.status(410).json({ success: false, message: 'Этот аккаунт удалён.' });
      }
      const [recipientBlockedMe, iBlockedRecipient] = await Promise.all([
        isBlocked(withUser, username),
        isBlocked(username, withUser)
      ]);
      if (recipientBlockedMe) {
        return res.status(403).json({ success: false, message: 'Пользователь заблокировал вас.' });
      }
      if (iBlockedRecipient) {
        return res.status(403).json({ success: false, message: 'Вы заблокировали этого пользователя. Разблокируйте, чтобы писать.' });
      }
    }

    const id = isFavorite ? `fav:${cleanUsername(username)}` : chatIdBetween(username, withUser);

    const message = {
      id: Date.now() + '-' + Math.floor(Math.random() * 1000),
      from: username,
      type: msgType,
      text: msgType === 'text' ? String(text).trim() : '',
      media: msgType === 'text' ? '' : String(media),
      voiceDuration: msgType === 'voice' ? Number(voiceDuration) || 0 : 0,
      waveform: msgType === 'voice' && Array.isArray(waveform)
        ? waveform.slice(0, 64).map(n => Math.max(0, Math.min(100, Math.round(Number(n) || 0))))
        : [],
      time: Date.now()
    };

    await redis.rpush('texta:messages:' + id, message);

    if (!isFavorite) {
      const a = cleanUsername(username);
      const b = cleanUsername(withUser);
      await redis.sadd('texta:chats:' + a, b);
      await redis.sadd('texta:chats:' + b, a);
      await redis.srem('texta:hidden_chats:' + a, b);
      await redis.srem('texta:hidden_chats:' + b, a);
    }

    res.json({ success: true, chatId: id, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: удаление отдельных сообщений ----------

app.post('/api/messages/delete', async (req, res) => {
  try {
    const { username, chatId, messageId, mode } = req.body || {};

    if (!username || !chatId || !messageId || !mode) {
      return res.status(400).json({ success: false, message: 'Не хватает параметров.' });
    }

    const cleanU = cleanUsername(username);
    const key = 'texta:messages:' + chatId;

    if (mode === 'me') {
      await redis.sadd('texta:deleted:' + cleanU + ':' + chatId, messageId);
      return res.json({ success: true });
    }

    if (mode === 'everyone') {
      const messages = await redis.lrange(key, 0, -1);
      const target = messages.find(m => m.id === messageId);

      if (!target) {
        return res.status(404).json({ success: false, message: 'Сообщение не найдено.' });
      }
      if (cleanUsername(target.from) !== cleanU) {
        return res.status(403).json({ success: false, message: 'Можно удалять у всех только свои сообщения.' });
      }
      if (Date.now() - target.time > DELETE_FOR_EVERYONE_WINDOW_MS) {
        return res.status(403).json({ success: false, message: 'Прошёл час — удалить у всех уже нельзя.' });
      }

      const remaining = messages.filter(m => m.id !== messageId);
      await redis.del(key);
      if (remaining.length) await redis.rpush(key, ...remaining);

      return res.json({ success: true });
    }

    return res.status(400).json({ success: false, message: 'Неизвестный режим удаления.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: удаление всей переписки целиком ----------

app.post('/api/conversation/delete', async (req, res) => {
  try {
    const { username, withUser, mode } = req.body || {};
    if (!username || !withUser || !mode) {
      return res.status(400).json({ success: false, message: 'Не хватает параметров.' });
    }

    const chatId = chatIdBetween(username, withUser);
    const cleanU = cleanUsername(username);

    if (mode === 'me') {
      await redis.set('texta:cleared:' + cleanU + ':' + chatId, Date.now());
      return res.json({ success: true });
    }

    if (mode === 'everyone') {
      await redis.del('texta:messages:' + chatId);
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false, message: 'Неизвестный режим удаления.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: удалить чат из списка ----------

app.post('/api/chats/delete', async (req, res) => {
  try {
    const { username, withUser } = req.body || {};
    if (!username || !withUser) {
      return res.status(400).json({ success: false, message: 'Не хватает параметров.' });
    }
    await redis.sadd('texta:hidden_chats:' + cleanUsername(username), cleanUsername(withUser));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: список чатов пользователя ----------

app.get('/api/chats', async (req, res) => {
  try {
    const username = cleanUsername(req.query.username);
    if (!username) return res.status(400).json({ success: false, message: 'Не указан username.' });

    const [partners, hidden] = await Promise.all([
      redis.smembers('texta:chats:' + username),
      redis.smembers('texta:hidden_chats:' + username)
    ]);

    const hiddenSet = new Set(hidden);
    const visiblePartners = partners.filter(p => !hiddenSet.has(p));
    if (!visiblePartners.length) return res.json({ success: true, chats: [] });

    const users = await redis.mget(...visiblePartners.map(u => 'texta:user:' + u));

    const chats = await Promise.all(
      visiblePartners.map(async (partnerUsername, idx) => {
        const u = users[idx];
        const chatId = chatIdBetween(username, partnerUsername);
        const [tail, clearedAt, deletedIds] = await Promise.all([
          redis.lrange('texta:messages:' + chatId, -30, -1),
          redis.get('texta:cleared:' + username + ':' + chatId),
          redis.smembers('texta:deleted:' + username + ':' + chatId)
        ]);

        const deletedSet = new Set(deletedIds);
        const visible = (tail || []).filter(m =>
          !deletedSet.has(m.id) && (!clearedAt || m.time > clearedAt)
        );
        const lastMsg = visible.length ? visible[visible.length - 1] : null;
        const previewText = lastMsg
          ? (lastMsg.type === 'photo' ? '📷 Фото' : lastMsg.type === 'voice' ? '🎤 Голосовое сообщение' : lastMsg.text)
          : '';

        if (!u) {
          // Аккаунт собеседника удалён — переписка остаётся, но помечаем как недоступную
          return {
            username: partnerUsername,
            displayName: 'Удалённый аккаунт',
            avatarType: 'deleted',
            avatarValue: '',
            deleted: true,
            lastMessage: previewText,
            lastTime: lastMsg ? lastMsg.time : 0
          };
        }

        const [iBlockedThem, theyBlockedMe] = await Promise.all([
          isBlocked(username, partnerUsername),
          isBlocked(partnerUsername, username)
        ]);

        if (iBlockedThem || theyBlockedMe) {
          return {
            ...publicUser(u),
            avatarType: 'blocked',
            avatarValue: '',
            blocked: true,
            lastMessage: previewText,
            lastTime: lastMsg ? lastMsg.time : 0
          };
        }

        return {
          ...publicUser(u),
          lastMessage: previewText,
          lastTime: lastMsg ? lastMsg.time : 0
        };
      })
    );

    chats.sort((a, b) => b.lastTime - a.lastTime);

    res.json({ success: true, chats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

// ---------- API: блокировка пользователей ----------

app.post('/api/block', async (req, res) => {
  try {
    const { username, target, block } = req.body || {};
    if (!username || !target) {
      return res.status(400).json({ success: false, message: 'Не хватает параметров.' });
    }
    const a = cleanUsername(username);
    const b = cleanUsername(target);

    if (block) {
      await redis.sadd('texta:blocked:' + a, b);
    } else {
      await redis.srem('texta:blocked:' + a, b);
    }

    res.json({ success: true, blocked: !!block });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Ошибка сервера.' });
  }
});

app.get('/api/block/status', async (req, res) => {
  try {
    const username = cleanUsername(req.query.username);
    const target = cleanUsername(req.query.target);
    if (!username || !target) {
      return res.status(400).json({ success: false, message: 'Не хватает параметров.' });
    }
    const blocked = await isBlocked(username, target);
    res.json({ success: true, blocked });
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
