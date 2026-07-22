/**
 * TEXTA — клиентская логика
 * Работает поверх REST API сервера (server.js)
 * Сессия хранится в localStorage: одинаковый username+code даст доступ с любого браузера/устройства.
 */

(function () {
  'use strict';

  const API = '/api';
  const SESSION_KEY = 'texta_session';
  const CHATS_KEY_PREFIX = 'texta_known_chats_'; // список собеседников, с которыми открывали диалог (локально, на устройстве)

  // ---------- Состояние ----------

  let session = loadSession();        // { username, displayName, code }
  let currentChatPartner = null;      // объект собеседника {username, displayName} либо null для избранного
  let isFavoriteChat = false;
  let messagesPollTimer = null;

  // ---------- Утилиты DOM ----------

  const $ = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function initials(name) {
    if (!name) return 'T';
    return name.trim().charAt(0).toUpperCase();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Сессия ----------

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(user) {
    session = user;
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  }

  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  // ---------- Локальный список открытых диалогов (на этом устройстве) ----------

  function knownChatsKey() {
    return CHATS_KEY_PREFIX + (session ? session.username.toLowerCase() : 'anon');
  }

  function getKnownChats() {
    try {
      const raw = localStorage.getItem(knownChatsKey());
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function addKnownChat(user) {
    const chats = getKnownChats();
    if (!chats.find(c => c.username.toLowerCase() === user.username.toLowerCase())) {
      chats.unshift(user);
      localStorage.setItem(knownChatsKey(), JSON.stringify(chats));
    }
  }

  // ---------- API-обёртки ----------

  async function apiPost(path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({ success: false, message: 'Ошибка сервера.' }));
    if (!res.ok) throw new Error(data.message || 'Ошибка запроса.');
    return data;
  }

  async function apiGet(path) {
    const res = await fetch(API + path);
    const data = await res.json().catch(() => ({ success: false, message: 'Ошибка сервера.' }));
    if (!res.ok) throw new Error(data.message || 'Ошибка запроса.');
    return data;
  }

  // ============================================================
  // АВТОРИЗАЦИЯ
  // ============================================================

  function setupAuthTabs() {
    $('tab-login').addEventListener('click', () => switchAuthTab('login'));
    $('tab-register').addEventListener('click', () => switchAuthTab('register'));
  }

  function switchAuthTab(tab) {
    $('tab-login').classList.toggle('active', tab === 'login');
    $('tab-register').classList.toggle('active', tab === 'register');
    $('form-login').classList.toggle('active', tab === 'login');
    $('form-register').classList.toggle('active', tab === 'register');
    $('login-error').textContent = '';
    $('reg-error').textContent = '';
  }

  $ready(() => {
    setupAuthTabs();

    $('form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('login-error').textContent = '';
      const username = $('login-username').value.trim();
      const code = $('login-code').value.trim();

      if (!username || !code) {
        $('login-error').textContent = 'Заполните оба поля.';
        return;
      }

      setBtnLoading('btn-login', true);
      try {
        const data = await apiPost('/login', { username, code });
        saveSession(data.user);
        enterApp();
      } catch (err) {
        $('login-error').textContent = err.message;
      } finally {
        setBtnLoading('btn-login', false);
      }
    });

    $('form-register').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('reg-error').textContent = '';
      const username = $('reg-username').value.trim();
      const displayName = $('reg-displayname').value.trim();

      if (!username || !displayName) {
        $('reg-error').textContent = 'Заполните оба поля.';
        return;
      }

      setBtnLoading('btn-register', true);
      try {
        const data = await apiPost('/register', { username, displayName });
        saveSession(data.user);
        $('issued-code').textContent = data.user.code;
        showScreen('screen-code');
      } catch (err) {
        $('reg-error').textContent = err.message;
      } finally {
        setBtnLoading('btn-register', false);
      }
    });

    $('btn-copy-code').addEventListener('click', () => {
      const code = $('issued-code').textContent;
      navigator.clipboard?.writeText(code).then(() => {
        $('btn-copy-code').textContent = 'Скопировано';
        setTimeout(() => { $('btn-copy-code').textContent = 'Скопировать код'; }, 1600);
      }).catch(() => {});
    });

    $('btn-continue').addEventListener('click', enterApp);

    // Если сессия уже есть — сразу входим
    if (session && session.username) {
      enterApp(true);
    }
  });

  function setBtnLoading(id, loading) {
    const btn = $(id);
    btn.disabled = loading;
    btn.style.opacity = loading ? '.7' : '1';
  }

  function $ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // ============================================================
  // ВХОД В ПРИЛОЖЕНИЕ
  // ============================================================

  function enterApp() {
    showScreen('screen-chats');
    renderFavPreview();
    renderChatList();
    initAppHandlers();
  }

  let handlersInitialized = false;

  function initAppHandlers() {
    if (handlersInitialized) return;
    handlersInitialized = true;

    // ---- Поиск ----
    $('btn-open-search').addEventListener('click', openSearch);
    $('btn-close-search').addEventListener('click', closeSearch);

    let searchTimer = null;
    $('search-input').addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = $('search-input').value.trim();
      searchTimer = setTimeout(() => runSearch(q), 250);
    });

    // ---- Избранное ----
    $('row-favorites').addEventListener('click', () => openChat(null, true));

    // ---- Чат ----
    $('btn-back-to-list').addEventListener('click', closeChat);
    $('form-send').addEventListener('submit', onSendMessage);

    // ---- Настройки ----
    $('btn-open-settings').addEventListener('click', openSettings);
    $('btn-back-from-settings').addEventListener('click', () => showScreen('screen-chats'));
    $('btn-save-settings').addEventListener('click', onSaveSettings);
    $('btn-logout').addEventListener('click', onLogout);
  }

  // ============================================================
  // ПОИСК ПОЛЬЗОВАТЕЛЕЙ
  // ============================================================

  function openSearch() {
    $('search-bar').classList.add('active');
    $('search-results').classList.add('active');
    $('chat-list').classList.add('hidden');
    $('search-input').value = '';
    $('search-input').focus();
    renderSearchEmpty('Начните вводить @username или имя, чтобы найти собеседника.');
  }

  function closeSearch() {
    $('search-bar').classList.remove('active');
    $('search-results').classList.remove('active');
    $('chat-list').classList.remove('hidden');
    $('search-results').innerHTML = '';
  }

  function renderSearchEmpty(text) {
    $('search-results').innerHTML = `<div class="search-empty">${escapeHtml(text)}</div>`;
  }

  async function runSearch(q) {
    if (!q) {
      renderSearchEmpty('Начните вводить @username или имя, чтобы найти собеседника.');
      return;
    }
    try {
      const data = await apiGet(`/search?q=${encodeURIComponent(q)}&self=${encodeURIComponent(session.username)}`);
      if (!data.results.length) {
        renderSearchEmpty('Никого не найдено. Проверьте написание @username.');
        return;
      }
      $('search-results').innerHTML = data.results.map(userRowHtml).join('');
      $('search-results').querySelectorAll('.chat-row').forEach(row => {
        row.addEventListener('click', () => {
          const username = row.dataset.username;
          const displayName = row.dataset.displayname;
          closeSearch();
          openChat({ username, displayName }, false);
        });
      });
    } catch (err) {
      renderSearchEmpty('Ошибка поиска: ' + err.message);
    }
  }

  function userRowHtml(u) {
    return `
      <button class="chat-row" data-username="${escapeAttr(u.username)}" data-displayname="${escapeAttr(u.displayName)}">
        <div class="chat-avatar">${escapeHtml(initials(u.displayName))}</div>
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(u.displayName)}</span></div>
          <div class="chat-row-preview">@${escapeHtml(u.username)}</div>
        </div>
      </button>`;
  }

  // ============================================================
  // СПИСОК ЧАТОВ
  // ============================================================

  function renderChatList() {
    const chats = getKnownChats();
    const empty = $('chat-list-empty');
    const container = $('dynamic-chats');

    if (!chats.length) {
      empty.classList.remove('hidden');
      container.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    container.innerHTML = chats.map(userRowHtmlChat).join('');
    container.querySelectorAll('.chat-row').forEach(row => {
      row.addEventListener('click', () => {
        const username = row.dataset.username;
        const displayName = row.dataset.displayname;
        openChat({ username, displayName }, false);
      });
    });
  }

  function userRowHtmlChat(u) {
    return `
      <button class="chat-row" data-username="${escapeAttr(u.username)}" data-displayname="${escapeAttr(u.displayName)}">
        <div class="chat-avatar">${escapeHtml(initials(u.displayName))}</div>
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(u.displayName)}</span></div>
          <div class="chat-row-preview">@${escapeHtml(u.username)}</div>
        </div>
      </button>`;
  }

  async function renderFavPreview() {
    try {
      const data = await apiGet(`/messages?chatId=${encodeURIComponent('fav:' + session.username.toLowerCase())}`);
      const last = data.messages[data.messages.length - 1];
      $('fav-preview').textContent = last ? last.text : 'Личные заметки';
    } catch (e) {
      $('fav-preview').textContent = 'Личные заметки';
    }
  }

  // ============================================================
  // ЭКРАН ЧАТА
  // ============================================================

  function openChat(user, isFavorite) {
    isFavoriteChat = isFavorite;
    currentChatPartner = isFavorite ? null : user;

    if (!isFavorite) addKnownChat(user);

    const name = isFavorite ? 'Избранное' : user.displayName;
    const sub = isFavorite ? 'Личные заметки' : '@' + user.username;

    $('chat-header-name').textContent = name;
    $('chat-header-sub').textContent = sub;
    $('chat-header-avatar').textContent = isFavorite ? '★' : initials(user.displayName);
    $('chat-header-avatar').style.background = isFavorite
      ? 'linear-gradient(135deg,#f59e0b,#ef4444)'
      : '';

    $('messages-area').innerHTML = '<div class="msg-empty">Загрузка сообщений...</div>';
    showScreen('screen-chat');
    loadMessages();

    clearInterval(messagesPollTimer);
    messagesPollTimer = setInterval(loadMessages, 3000);
  }

  function closeChat() {
    clearInterval(messagesPollTimer);
    showScreen('screen-chats');
    renderChatList();
    renderFavPreview();
  }

  function currentChatQuery() {
    if (isFavoriteChat) {
      return `chatId=${encodeURIComponent('fav:' + session.username.toLowerCase())}`;
    }
    return `username=${encodeURIComponent(session.username)}&withUser=${encodeURIComponent(currentChatPartner.username)}`;
  }

  async function loadMessages() {
    try {
      const data = await apiGet(`/messages?${currentChatQuery()}`);
      renderMessages(data.messages);
    } catch (err) {
      // тихо игнорируем сбой опроса, не мешаем вводу
    }
  }

  let lastRenderedCount = -1;

  function renderMessages(messages) {
    const area = $('messages-area');

    if (!messages.length) {
      area.innerHTML = `<div class="msg-empty">${isFavoriteChat
        ? 'Здесь появятся ваши личные заметки.'
        : 'Сообщений пока нет. Напишите первым.'}</div>`;
      lastRenderedCount = 0;
      return;
    }

    if (messages.length === lastRenderedCount) return; // не перерисовываем без нужды
    lastRenderedCount = messages.length;

    const isNearBottom = area.scrollTop + area.clientHeight >= area.scrollHeight - 60;

    area.innerHTML = messages.map(m => {
      const own = m.from.toLowerCase() === session.username.toLowerCase();
      return `
        <div class="msg-row ${own ? 'own' : 'other'}">
          <div class="msg-bubble">${escapeHtml(m.text)}<span class="msg-time">${formatTime(m.time)}</span></div>
        </div>`;
    }).join('');

    if (isNearBottom || messages.length <= 1) {
      area.scrollTop = area.scrollHeight;
    }
  }

  async function onSendMessage(e) {
    e.preventDefault();
    const input = $('message-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';

    try {
      const body = { username: session.username, text };
      if (isFavoriteChat) body.isFavorite = true;
      else body.withUser = currentChatPartner.username;

      await apiPost('/messages', body);
      lastRenderedCount = -1; // форсируем перерисовку
      await loadMessages();
      $('messages-area').scrollTop = $('messages-area').scrollHeight;
    } catch (err) {
      input.value = text; // вернуть текст при ошибке
      alert('Не удалось отправить: ' + err.message);
    }
  }

  // ============================================================
  // НАСТРОЙКИ ПРОФИЛЯ
  // ============================================================

  function openSettings() {
    $('settings-avatar').textContent = initials(session.displayName);
    $('settings-displayname').value = session.displayName;
    $('settings-username').value = '@' + session.username;
    $('settings-code').value = session.code;
    $('settings-error').textContent = '';
    $('settings-success').textContent = '';
    showScreen('screen-settings');
  }

  async function onSaveSettings() {
    $('settings-error').textContent = '';
    $('settings-success').textContent = '';
    const newName = $('settings-displayname').value.trim();

    if (!newName) {
      $('settings-error').textContent = 'Имя не может быть пустым.';
      return;
    }

    try {
      const data = await apiPost('/profile/update', {
        username: session.username,
        code: session.code,
        displayName: newName
      });
      saveSession({ ...session, displayName: data.user.displayName });
      $('settings-success').textContent = 'Изменения сохранены.';
    } catch (err) {
      $('settings-error').textContent = err.message;
    }
  }

  function onLogout() {
    clearInterval(messagesPollTimer);
    clearSession();
    handlersInitialized = false;
    $('login-username').value = '';
    $('login-code').value = '';
    switchAuthTab('login');
    showScreen('screen-auth');
  }

  // ---------- Экранирование ----------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

})();
