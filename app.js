/**
 * TEXTA — клиентская логика
 * Работает поверх REST API сервера (server.js)
 * Сессия хранится в localStorage: одинаковый username+code даст доступ с любого браузера/устройства.
 */

(function () {
  'use strict';

  const API = '/api';
  const SESSION_KEY = 'texta_session';

  // ---------- Состояние ----------

  let session = loadSession();        // { username, displayName, code }
  let currentChatPartner = null;      // объект собеседника {username, displayName} либо null для избранного
  let isFavoriteChat = false;
  let messagesPollTimer = null;
  let chatListPollTimer = null;       // опрос списка чатов на главном экране (чтобы входящие сообщения появлялись сами)

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

  // Кеш известных пользователей (из поиска и списка чатов) — чтобы при открытии
  // диалога у нас были под рукой avatarType/avatarValue, не только username/displayName.
  const userCache = {};

  function cacheUser(u) {
    userCache[u.username.toLowerCase()] = u;
    return u;
  }

  const EMOJI_OPTIONS = ['😀','😎','🐱','🐶','🦊','🐼','🚀','🔥','⭐','🌙','💎','🎨','🍀','🌊','⚡','🎧','🍕','🎮','🌵','🦄'];

  // Возвращает {html, cls} для содержимого аватарки: фото / эмодзи / инициал
  function avatarContent(u) {
    if (!u) return { html: 'T', cls: '' };
    if (u.avatarType === 'photo' && u.avatarValue) {
      return { html: `<img src="${escapeAttr(u.avatarValue)}" alt="">`, cls: '' };
    }
    if (u.avatarType === 'emoji' && u.avatarValue) {
      return { html: escapeHtml(u.avatarValue), cls: 'is-emoji' };
    }
    return { html: escapeHtml(initials(u.displayName)), cls: '' };
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

  // ---------- Список диалогов ----------
  // Раньше список чатов хранился только в localStorage этого устройства и пополнялся
  // только когда пользователь сам открывал диалог через поиск — из-за этого входящие
  // сообщения не появлялись на главном экране, пока не найдёшь собеседника вручную.
  // Теперь список общий, серверный (см. /api/chats) — обновляется само по себе.

  async function fetchChatsFromServer() {
    try {
      const data = await apiGet(`/chats?username=${encodeURIComponent(session.username)}`);
      return data.chats || [];
    } catch (e) {
      return [];
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
    startChatListPolling();
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

    // ---- Удаление сообщений ----
    $('action-delete-me').addEventListener('click', () => deleteSelectedMessage('me'));
    $('action-delete-everyone').addEventListener('click', () => deleteSelectedMessage('everyone'));
    $('action-cancel').addEventListener('click', closeMessageActions);
    $('msg-action-backdrop').addEventListener('click', closeMessageActions);

    // ---- Опции чата ----
    $('btn-chat-options').addEventListener('click', openChatOptions);
    $('chat-options-backdrop').addEventListener('click', closeChatOptions);
    $('chat-opt-cancel').addEventListener('click', closeChatOptions);
    $('chat-opt-delete-chat').addEventListener('click', onDeleteChat);
    $('chat-opt-clear-me').addEventListener('click', () => onClearConversation('me'));
    $('chat-opt-clear-everyone').addEventListener('click', () => onClearConversation('everyone'));
    $('chat-opt-block').addEventListener('click', onToggleBlock);

    // ---- Настройки ----
    $('btn-open-settings').addEventListener('click', openSettings);
    $('btn-back-from-settings').addEventListener('click', () => showScreen('screen-chats'));
    $('btn-save-settings').addEventListener('click', onSaveSettings);
    $('btn-logout').addEventListener('click', onLogout);

    // ---- Аватарка ----
    $('settings-avatar').addEventListener('click', openAvatarSheet);
    $('avatar-sheet-backdrop').addEventListener('click', closeAvatarSheet);
    $('avatar-sheet-cancel').addEventListener('click', closeAvatarSheet);
    $('btn-upload-photo').addEventListener('click', () => $('avatar-file-input').click());
    $('avatar-file-input').addEventListener('change', onAvatarFileSelected);
    renderEmojiGrid();
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
          closeSearch();
          openChat(userCache[username.toLowerCase()] || { username, displayName: row.dataset.displayname }, false);
        });
      });
    } catch (err) {
      renderSearchEmpty('Ошибка поиска: ' + err.message);
    }
  }

  function userRowHtml(u) {
    cacheUser(u);
    const av = avatarContent(u);
    return `
      <button class="chat-row" data-username="${escapeAttr(u.username)}" data-displayname="${escapeAttr(u.displayName)}">
        <div class="chat-avatar ${av.cls}">${av.html}</div>
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(u.displayName)}</span></div>
          <div class="chat-row-preview">@${escapeHtml(u.username)}</div>
        </div>
      </button>`;
  }

  // ============================================================
  // СПИСОК ЧАТОВ
  // ============================================================

  let lastChatsSignature = '';

  async function renderChatList() {
    const chats = await fetchChatsFromServer();
    const empty = $('chat-list-empty');
    const container = $('dynamic-chats');

    // Не перерисовываем DOM, если список не изменился — избегаем "мигания" при опросе
    const signature = JSON.stringify(chats.map(c => [c.username, c.lastMessage, c.lastTime]));
    if (signature === lastChatsSignature) return;
    lastChatsSignature = signature;

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
        openChat(userCache[username.toLowerCase()] || { username, displayName: row.dataset.displayname }, false);
      });
    });
  }

  function userRowHtmlChat(u) {
    cacheUser(u);
    const av = avatarContent(u);
    const preview = u.lastMessage ? escapeHtml(u.lastMessage) : '@' + escapeHtml(u.username);
    return `
      <button class="chat-row" data-username="${escapeAttr(u.username)}" data-displayname="${escapeAttr(u.displayName)}">
        <div class="chat-avatar ${av.cls}">${av.html}</div>
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(u.displayName)}</span></div>
          <div class="chat-row-preview">${preview}</div>
        </div>
      </button>`;
  }

  function startChatListPolling() {
    clearInterval(chatListPollTimer);
    chatListPollTimer = setInterval(renderChatList, 3000);
  }

  function stopChatListPolling() {
    clearInterval(chatListPollTimer);
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

  let chatIsBlockedByMe = false;

  function openChat(user, isFavorite) {
    isFavoriteChat = isFavorite;
    currentChatPartner = isFavorite ? null : user;
    stopChatListPolling();

    const name = isFavorite ? 'Избранное' : user.displayName;
    const sub = isFavorite ? 'Личные заметки' : '@' + user.username;

    $('chat-header-name').textContent = name;
    $('chat-header-sub').textContent = sub;

    const headerAvatar = $('chat-header-avatar');
    if (isFavorite) {
      headerAvatar.innerHTML = '★';
      headerAvatar.className = 'chat-header-avatar';
      headerAvatar.style.background = 'linear-gradient(135deg,#f59e0b,#ef4444)';
    } else {
      const av = avatarContent(user);
      headerAvatar.innerHTML = av.html;
      headerAvatar.className = 'chat-header-avatar' + (av.cls ? ' ' + av.cls : '');
      headerAvatar.style.background = '';
    }

    $('btn-chat-options').classList.toggle('hidden', isFavorite);

    $('messages-area').innerHTML = '<div class="msg-empty">Загрузка сообщений...</div>';
    showScreen('screen-chat');
    loadMessages();

    if (!isFavorite) refreshBlockState();

    clearInterval(messagesPollTimer);
    messagesPollTimer = setInterval(loadMessages, 3000);
  }

  async function refreshBlockState() {
    try {
      const data = await apiGet(`/block/status?username=${encodeURIComponent(session.username)}&target=${encodeURIComponent(currentChatPartner.username)}`);
      chatIsBlockedByMe = !!data.blocked;
      $('chat-opt-block').textContent = chatIsBlockedByMe ? 'Разблокировать' : 'Заблокировать';
    } catch (e) {
      // не критично, оставим как есть
    }
  }

  function closeChat() {
    clearInterval(messagesPollTimer);
    showScreen('screen-chats');
    renderChatList();
    renderFavPreview();
    startChatListPolling();
  }

  // ---------- Опции чата: удалить чат / очистить переписку / блокировка ----------

  function openChatOptions() {
    $('chat-options-sheet').classList.add('active');
  }

  function closeChatOptions() {
    $('chat-options-sheet').classList.remove('active');
  }

  async function onDeleteChat() {
    if (!confirm('Удалить чат из списка? Сообщения не удаляются — если вам напишут снова, чат появится опять.')) return;
    try {
      await apiPost('/chats/delete', { username: session.username, withUser: currentChatPartner.username });
      closeChatOptions();
      closeChat();
    } catch (err) {
      alert('Не удалось удалить чат: ' + err.message);
    }
  }

  async function onClearConversation(mode) {
    const label = mode === 'everyone' ? 'у всех участников' : 'только у себя';
    if (!confirm(`Удалить всю переписку ${label}? Это действие нельзя отменить.`)) return;
    try {
      await apiPost('/conversation/delete', { username: session.username, withUser: currentChatPartner.username, mode });
      closeChatOptions();
      lastRenderedCount = -1;
      await loadMessages();
    } catch (err) {
      alert('Не удалось удалить переписку: ' + err.message);
    }
  }

  async function onToggleBlock() {
    const newState = !chatIsBlockedByMe;
    try {
      await apiPost('/block', { username: session.username, target: currentChatPartner.username, block: newState });
      chatIsBlockedByMe = newState;
      $('chat-opt-block').textContent = chatIsBlockedByMe ? 'Разблокировать' : 'Заблокировать';
    } catch (err) {
      alert('Не удалось изменить блокировку: ' + err.message);
    }
    closeChatOptions();
  }

  function currentChatQuery() {
    if (isFavoriteChat) {
      return `chatId=${encodeURIComponent('fav:' + session.username.toLowerCase())}&forUser=${encodeURIComponent(session.username)}`;
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
          <div class="msg-bubble" data-id="${escapeAttr(m.id)}" data-time="${m.time}" data-own="${own ? '1' : '0'}">${escapeHtml(m.text)}<span class="msg-time">${formatTime(m.time)}</span></div>
        </div>`;
    }).join('');

    attachBubbleLongPress(area);

    if (isNearBottom || messages.length <= 1) {
      area.scrollTop = area.scrollHeight;
    }
  }

  // ---------- Удаление сообщений (долгое нажатие → меню) ----------

  let pressTimer = null;
  let selectedMessage = null; // { id, time, own }

  function attachBubbleLongPress(area) {
    area.querySelectorAll('.msg-bubble').forEach(bubble => {
      const start = (e) => {
        pressTimer = setTimeout(() => {
          bubble.classList.add('pressing');
          if (navigator.vibrate) navigator.vibrate(15);
          openMessageActions(bubble);
        }, 420);
      };
      const cancel = () => {
        clearTimeout(pressTimer);
        bubble.classList.remove('pressing');
      };
      bubble.addEventListener('touchstart', start, { passive: true });
      bubble.addEventListener('touchend', cancel);
      bubble.addEventListener('touchmove', cancel);
      bubble.addEventListener('mousedown', start);
      bubble.addEventListener('mouseup', cancel);
      bubble.addEventListener('mouseleave', cancel);
    });
  }

  function openMessageActions(bubble) {
    selectedMessage = {
      id: bubble.dataset.id,
      time: Number(bubble.dataset.time),
      own: bubble.dataset.own === '1'
    };

    const withinHour = Date.now() - selectedMessage.time <= 3600000;
    $('action-delete-everyone').classList.toggle('hidden', !(selectedMessage.own && withinHour));

    $('msg-action-sheet').classList.add('active');
  }

  function closeMessageActions() {
    $('msg-action-sheet').classList.remove('active');
    document.querySelectorAll('.msg-bubble.pressing').forEach(b => b.classList.remove('pressing'));
    selectedMessage = null;
  }

  async function deleteSelectedMessage(mode) {
    if (!selectedMessage) return;
    const chatId = isFavoriteChat
      ? 'fav:' + session.username.toLowerCase()
      : [session.username.toLowerCase(), currentChatPartner.username.toLowerCase()].sort().join('__');

    try {
      await apiPost('/messages/delete', {
        username: session.username,
        chatId,
        messageId: selectedMessage.id,
        mode
      });
      lastRenderedCount = -1;
      await loadMessages();
    } catch (err) {
      alert('Не удалось удалить: ' + err.message);
    } finally {
      closeMessageActions();
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
    const av = avatarContent(session);
    $('settings-avatar').innerHTML = av.html;
    $('settings-avatar').className = 'settings-avatar' + (av.cls ? ' ' + av.cls : '');
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
    stopChatListPolling();
    clearSession();
    handlersInitialized = false;
    $('login-username').value = '';
    $('login-code').value = '';
    switchAuthTab('login');
    showScreen('screen-auth');
  }

  // ---------- Аватарка: панель выбора (фото / эмодзи) ----------

  function openAvatarSheet() {
    $('avatar-sheet').classList.add('active');
  }

  function closeAvatarSheet() {
    $('avatar-sheet').classList.remove('active');
  }

  function renderEmojiGrid() {
    $('emoji-grid').innerHTML = EMOJI_OPTIONS.map(e =>
      `<button type="button" class="emoji-option" data-emoji="${escapeAttr(e)}">${e}</button>`
    ).join('');
    $('emoji-grid').querySelectorAll('.emoji-option').forEach(btn => {
      btn.addEventListener('click', () => saveAvatar('emoji', btn.dataset.emoji));
    });
  }

  function onAvatarFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // сброс, чтобы повторный выбор того же файла тоже сработал
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Уменьшаем и сжимаем фото до разумного размера перед отправкой на сервер
        const size = 200;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        saveAvatar('photo', dataUrl);
      };
      img.onerror = () => alert('Не удалось прочитать изображение.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  async function saveAvatar(avatarType, avatarValue) {
    try {
      const data = await apiPost('/profile/update', {
        username: session.username,
        code: session.code,
        avatarType,
        avatarValue
      });
      saveSession({ ...session, avatarType: data.user.avatarType, avatarValue: data.user.avatarValue });
      const av = avatarContent(session);
      $('settings-avatar').innerHTML = av.html;
      $('settings-avatar').className = 'settings-avatar' + (av.cls ? ' ' + av.cls : '');
      closeAvatarSheet();
    } catch (err) {
      alert('Не удалось сохранить аватарку: ' + err.message);
    }
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
