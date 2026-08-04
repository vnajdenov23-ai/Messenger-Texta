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

  // Кастомная иконка черепа с зачёркнутыми глазами — для заблокированных/удалённых собеседников
  function skullIcon() {
    return `<svg viewBox="0 0 48 48" width="60%" height="60%">
      <path fill="#cbd5e1" d="M24 4c-9.9 0-16 7.2-16 15.6 0 5.4 2.6 9 5.4 11.4l-.9 6.3c-.2 1.5 1 2.7 2.4 2.7h3.4v-4h3v4h5.4v-4h3v4h3.4c1.5 0 2.6-1.3 2.4-2.7l-.9-6.3C37.4 28.6 40 25 40 19.6 40 11.2 33.9 4 24 4z"/>
      <path stroke="#0f172a" stroke-width="2.6" stroke-linecap="round" d="M13.5 16.5l6 6m0-6l-6 6M28.5 16.5l6 6m0-6l-6 6"/>
      <path fill="#0f172a" d="M21 27a3 2.2 0 1 0 6 0 3 2.2 0 1 0-6 0z"/>
    </svg>`;
  }

  // Возвращает {html, cls} для содержимого аватарки: фото / эмодзи / инициал / череп
  function avatarContent(u) {
    if (!u) return { html: 'T', cls: '' };
    if (u.avatarType === 'deleted' || u.avatarType === 'blocked') {
      return { html: skullIcon(), cls: 'is-skull' };
    }
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
    startPresencePing();
    initAppHandlers();
  }

  let presencePingTimer = null;

  function sendPresencePing() {
    if (!session) return;
    apiPost('/presence/ping', { username: session.username }).catch(() => {});
  }

  function startPresencePing() {
    sendPresencePing();
    clearInterval(presencePingTimer);
    presencePingTimer = setInterval(sendPresencePing, 20000);
  }

  function stopPresencePing() {
    clearInterval(presencePingTimer);
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

    // ---- Плеер голосовых и просмотр фото (делегирование, переживает перерисовку) ----
    $('messages-area').addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      const playBtn = e.target.closest('.voice-play-btn');
      if (playBtn) { toggleVoicePlayback(playBtn); return; }
      const photo = e.target.closest('.msg-photo');
      if (photo) openLightbox(photo.src);
    });
    $('photo-lightbox').addEventListener('click', closeLightbox);

    // ---- Фото и голосовые ----
    $('btn-attach-photo').addEventListener('click', () => $('photo-input').click());
    $('photo-input').addEventListener('change', onPhotoSelected);
    $('btn-record-voice').addEventListener('click', () => {
      if (mediaRecorder) stopVoiceRecording(true);
      else startVoiceRecording();
    });
    $('btn-voice-stop').addEventListener('click', () => stopVoiceRecording(true));
    $('btn-voice-cancel').addEventListener('click', () => stopVoiceRecording(false));

    // ---- Профиль собеседника ----
    $('btn-open-profile').addEventListener('click', openProfile);
    $('profile-sheet-backdrop').addEventListener('click', closeProfile);
    $('profile-sheet-close').addEventListener('click', closeProfile);

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
    $('chat-blocked-unblock').addEventListener('click', onToggleBlock);

    // ---- Настройки ----
    $('btn-open-settings').addEventListener('click', openSettings);
    $('btn-back-from-settings').addEventListener('click', () => showScreen('screen-chats'));
    $('btn-save-settings').addEventListener('click', onSaveSettings);
    $('btn-logout').addEventListener('click', onLogout);

    // ---- Копирование данных профиля ----
    $('copy-username').addEventListener('click', () => copyToClipboard('@' + session.username, $('copy-username')));
    $('copy-code').addEventListener('click', () => copyToClipboard(session.code, $('copy-code')));

    // ---- Приватность "в сети" ----
    $('privacy-options').querySelectorAll('.privacy-opt').forEach(btn => {
      btn.addEventListener('click', () => onSelectPrivacy(btn.dataset.value));
    });

    // ---- Удаление аккаунта ----
    $('btn-delete-account').addEventListener('click', openDeleteAccountSheet);
    $('delete-account-backdrop').addEventListener('click', closeDeleteAccountSheet);
    $('cancel-delete-account').addEventListener('click', closeDeleteAccountSheet);
    $('confirm-delete-account').addEventListener('click', onConfirmDeleteAccount);

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
      const data = await apiGet(`/messages?chatId=${encodeURIComponent('fav:' + session.username.toLowerCase())}&forUser=${encodeURIComponent(session.username)}`);
      const last = data.messages[data.messages.length - 1];
      $('fav-preview').textContent = last ? (last.type === 'photo' ? '📷 Фото' : last.type === 'voice' ? '🎤 Голосовое сообщение' : last.text) : 'Личные заметки';
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

    // Сброс состояния до ответа сервера — иначе на миг может мелькнуть блок предыдущего чата
    chatAvailability = 'ok';
    $('chat-blocked-bar').classList.add('hidden');
    $('form-send').classList.remove('hidden');

    $('messages-area').innerHTML = '<div class="msg-empty">Загрузка сообщений...</div>';
    showScreen('screen-chat');
    loadMessages();

    if (!isFavorite) refreshChatAvailability();

    clearInterval(messagesPollTimer);
    messagesPollTimer = setInterval(loadMessages, 3000);
  }

  let chatAvailability = 'ok'; // 'ok' | 'blocked' | 'deleted'
  let iBlockedThem = false;
  let theyBlockedMe = false;

  async function refreshChatAvailability() {
    if (!currentChatPartner) return;
    try {
      const data = await apiGet(`/presence?username=${encodeURIComponent(currentChatPartner.username)}&viewer=${encodeURIComponent(session.username)}`);

      if (data.state === 'deleted') {
        chatAvailability = 'deleted';
      } else if (data.state === 'blocked') {
        chatAvailability = 'blocked';
        iBlockedThem = !!data.iBlockedThem;
        theyBlockedMe = !!data.theyBlockedMe;
      } else {
        chatAvailability = 'ok';
        $('chat-header-sub').textContent = data.text || '';
      }
    } catch (e) {
      chatAvailability = 'ok';
    }
    updateChatAvailabilityUI();
  }

  function updateChatAvailabilityUI() {
    const blockedBar = $('chat-blocked-bar');
    const inputBar = $('form-send');
    const headerAvatar = $('chat-header-avatar');
    const optBlock = $('chat-opt-block');

    if (chatAvailability === 'ok') {
      blockedBar.classList.add('hidden');
      inputBar.classList.remove('hidden');
      optBlock.classList.remove('hidden');
      optBlock.textContent = 'Заблокировать';
      if (currentChatPartner) {
        const av = avatarContent(currentChatPartner);
        headerAvatar.innerHTML = av.html;
        headerAvatar.className = 'chat-header-avatar' + (av.cls ? ' ' + av.cls : '');
      }
      return;
    }

    inputBar.classList.add('hidden');
    $('voice-recorder').classList.add('hidden');
    blockedBar.classList.remove('hidden');
    headerAvatar.innerHTML = skullIcon();
    headerAvatar.className = 'chat-header-avatar is-skull';

    if (chatAvailability === 'deleted') {
      $('chat-header-sub').textContent = 'Аккаунт удалён';
      $('chat-blocked-icon').innerHTML = skullIcon();
      $('chat-blocked-text').textContent = 'Этот аккаунт удалён. Написать нельзя, но старая переписка сохранена.';
      $('chat-blocked-unblock').classList.add('hidden');
      optBlock.classList.add('hidden');
      return;
    }

    // blocked
    $('chat-blocked-icon').innerHTML = skullIcon();
    if (iBlockedThem) {
      $('chat-header-sub').textContent = 'Заблокирован(а) вами';
      $('chat-blocked-text').textContent = 'Вы заблокировали этого пользователя.';
      $('chat-blocked-unblock').classList.remove('hidden');
      optBlock.textContent = 'Разблокировать';
      optBlock.classList.remove('hidden');
    } else {
      $('chat-header-sub').textContent = 'Недоступен';
      $('chat-blocked-text').textContent = 'Пользователь заблокировал вас — писать нельзя.';
      $('chat-blocked-unblock').classList.add('hidden');
      optBlock.classList.add('hidden');
    }
  }

  // ---------- Профиль собеседника ----------

  async function openProfile() {
    if (isFavoriteChat || !currentChatPartner) return;
    $('profile-sheet').classList.add('active');

    try {
      const data = await apiGet(`/profile?username=${encodeURIComponent(currentChatPartner.username)}`);

      if (data.deleted) {
        $('profile-avatar').innerHTML = skullIcon();
        $('profile-avatar').className = 'profile-avatar is-skull';
        $('profile-name').textContent = 'Аккаунт удалён';
        $('profile-username').textContent = '';
        $('profile-joined').textContent = '';
        return;
      }

      const u = data.user;
      const av = avatarContent(u);
      $('profile-avatar').innerHTML = av.html;
      $('profile-avatar').className = 'profile-avatar' + (av.cls ? ' ' + av.cls : '');
      $('profile-name').textContent = u.displayName;
      $('profile-username').textContent = '@' + u.username;
      $('profile-joined').textContent = u.createdAt ? 'На Texta с ' + formatJoinDate(u.createdAt) : '';
    } catch (err) {
      $('profile-name').textContent = 'Не удалось загрузить профиль';
      $('profile-username').textContent = '';
      $('profile-joined').textContent = '';
    }
  }

  function closeProfile() {
    $('profile-sheet').classList.remove('active');
  }

  function formatJoinDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
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
    const newState = !iBlockedThem;
    try {
      await apiPost('/block', { username: session.username, target: currentChatPartner.username, block: newState });
      closeChatOptions();
      await refreshChatAvailability();
    } catch (err) {
      alert('Не удалось изменить блокировку: ' + err.message);
    }
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
      const inner = messageInnerHtml(m);
      return `
        <div class="msg-row ${own ? 'own' : 'other'}">
          <div class="msg-bubble" data-id="${escapeAttr(m.id)}" data-time="${m.time}" data-own="${own ? '1' : '0'}">${inner}<span class="msg-time">${formatTime(m.time)}</span></div>
        </div>`;
    }).join('');

    attachBubbleLongPress(area);

    if (isNearBottom || messages.length <= 1) {
      area.scrollTop = area.scrollHeight;
    }
  }

  function messageInnerHtml(m) {
    if (m.type === 'photo' && m.media) {
      return `<img class="msg-photo" src="${escapeAttr(m.media)}" alt="фото">`;
    }
    if (m.type === 'voice' && m.media) {
      const bars = (m.waveform && m.waveform.length ? m.waveform : new Array(28).fill(30));
      const barsHtml = bars.map(v => `<span style="height:${Math.max(3, Math.round(v * 0.24))}px"></span>`).join('');
      const dur = m.voiceDuration ? formatDuration(m.voiceDuration) : '0:00';
      return `
        <div class="msg-voice" data-src="${escapeAttr(m.media)}">
          <button type="button" class="voice-play-btn" aria-label="Играть">
            <svg class="icon-play" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
            <svg class="icon-pause" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
          </button>
          <div class="voice-wave">${barsHtml}</div>
          <span class="voice-duration">${dur}</span>
        </div>`;
    }
    return escapeHtml(m.text);
  }

  function formatDuration(sec) {
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- Удаление сообщений (долгое нажатие → меню) ----------

  let pressTimer = null;
  let selectedMessage = null; // { id, time, own }
  let suppressClickUntil = 0;
  let activeVoiceAudio = null;
  let activeVoiceBtn = null;
  let activeVoiceBars = null;

  function toggleVoicePlayback(btn) {
    const container = btn.closest('.msg-voice');
    const src = container.dataset.src;
    const bars = container.querySelectorAll('.voice-wave span');

    if (activeVoiceAudio && activeVoiceBtn === btn) {
      if (activeVoiceAudio.paused) {
        activeVoiceAudio.play();
        btn.classList.add('playing');
      } else {
        activeVoiceAudio.pause();
        btn.classList.remove('playing');
      }
      return;
    }

    if (activeVoiceAudio) {
      activeVoiceAudio.pause();
      if (activeVoiceBtn) activeVoiceBtn.classList.remove('playing');
      if (activeVoiceBars) activeVoiceBars.forEach(b => b.classList.remove('played'));
    }

    const audio = new Audio(src);
    activeVoiceAudio = audio;
    activeVoiceBtn = btn;
    activeVoiceBars = bars;
    btn.classList.add('playing');

    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      const activeCount = Math.round((audio.currentTime / audio.duration) * bars.length);
      bars.forEach((b, i) => b.classList.toggle('played', i < activeCount));
    });
    audio.addEventListener('ended', () => {
      btn.classList.remove('playing');
      bars.forEach(b => b.classList.remove('played'));
      activeVoiceAudio = null;
      activeVoiceBtn = null;
      activeVoiceBars = null;
    });
    audio.play().catch(() => {
      btn.classList.remove('playing');
      alert('Не удалось воспроизвести голосовое сообщение.');
    });
  }

  function openLightbox(src) {
    $('photo-lightbox-img').src = src;
    $('photo-lightbox').classList.add('active');
  }

  function closeLightbox() {
    $('photo-lightbox').classList.remove('active');
    $('photo-lightbox-img').src = '';
  }

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
    suppressClickUntil = Date.now() + 400;

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

  async function sendMediaMessage(type, media, voiceDuration, waveform) {
    try {
      const body = { username: session.username, type, media };
      if (voiceDuration) body.voiceDuration = voiceDuration;
      if (waveform) body.waveform = waveform;
      if (isFavoriteChat) body.isFavorite = true;
      else body.withUser = currentChatPartner.username;

      await apiPost('/messages', body);
      lastRenderedCount = -1;
      await loadMessages();
      $('messages-area').scrollTop = $('messages-area').scrollHeight;
    } catch (err) {
      alert('Не удалось отправить: ' + err.message);
    }
  }

  // ---------- Отправка фото ----------

  function onPhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Сжимаем фото перед отправкой, чтобы не раздувать базу
        const maxSide = 1024;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        sendMediaMessage('photo', dataUrl);
      };
      img.onerror = () => alert('Не удалось прочитать изображение.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- Запись и отправка голосового ----------

  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStartTime = 0;
  let recordTimerInterval = null;
  let waveformSamples = [];
  let waveformAudioCtx = null;
  let waveformAnalyser = null;
  let waveformSampleInterval = null;

  async function startVoiceRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Запись голоса не поддерживается этим браузером.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.start();
      recordStartTime = Date.now();

      // Замеряем громкость голоса каждые ~100мс, чтобы построить волну как в Телеграме
      waveformSamples = [];
      try {
        waveformAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = waveformAudioCtx.createMediaStreamSource(stream);
        waveformAnalyser = waveformAudioCtx.createAnalyser();
        waveformAnalyser.fftSize = 256;
        source.connect(waveformAnalyser);
        const data = new Uint8Array(waveformAnalyser.frequencyBinCount);

        waveformSampleInterval = setInterval(() => {
          waveformAnalyser.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          waveformSamples.push(Math.min(1, rms * 4.5));
        }, 100);
      } catch (waveErr) {
        // Волна — приятное дополнение, не критично, если Web Audio API недоступен
      }

      $('btn-record-voice').classList.add('recording');
      $('voice-recorder').classList.remove('hidden');
      $('voice-timer').textContent = '0:00';
      recordTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        $('voice-timer').textContent = formatDuration(elapsed);
      }, 500);
    } catch (err) {
      alert('Не удалось получить доступ к микрофону: ' + err.message);
    }
  }

  function resampleWaveform(samples, targetCount) {
    if (!samples.length) return new Array(targetCount).fill(25);
    const result = [];
    const bucket = samples.length / targetCount;
    for (let i = 0; i < targetCount; i++) {
      const start = Math.floor(i * bucket);
      const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
      let sum = 0, count = 0;
      for (let j = start; j < end && j < samples.length; j++) { sum += samples[j]; count++; }
      const avg = count ? sum / count : 0;
      result.push(Math.max(6, Math.round(avg * 100)));
    }
    return result;
  }

  function stopVoiceRecording(send) {
    if (!mediaRecorder) return;
    clearInterval(recordTimerInterval);
    clearInterval(waveformSampleInterval);
    if (waveformAudioCtx) { waveformAudioCtx.close(); waveformAudioCtx = null; }
    $('btn-record-voice').classList.remove('recording');
    $('voice-recorder').classList.add('hidden');

    const duration = (Date.now() - recordStartTime) / 1000;
    const waveform = resampleWaveform(waveformSamples, 28);

    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      if (!send || duration < 0.6) { mediaRecorder = null; return; }

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => sendMediaMessage('voice', reader.result, duration, waveform);
      reader.readAsDataURL(blob);
      mediaRecorder = null;
    };
    mediaRecorder.stop();
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

    const currentPrivacy = session.presencePrivacy || 'visible';
    $('privacy-options').querySelectorAll('.privacy-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentPrivacy);
    });

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
    stopPresencePing();
    clearSession();
    handlersInitialized = false;
    $('login-username').value = '';
    $('login-code').value = '';
    switchAuthTab('login');
    showScreen('screen-auth');
  }

  // ---------- Копирование по кнопке (вместо зажатия текста) ----------

  function copyToClipboard(text, btn) {
    navigator.clipboard?.writeText(text).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Скопировано';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
    }).catch(() => alert('Не удалось скопировать.'));
  }

  // ---------- Приватность "в сети" ----------

  async function onSelectPrivacy(value) {
    $('privacy-options').querySelectorAll('.privacy-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
    try {
      await apiPost('/profile/update', { username: session.username, code: session.code, presencePrivacy: value });
      saveSession({ ...session, presencePrivacy: value });
    } catch (err) {
      alert('Не удалось сохранить настройку: ' + err.message);
    }
  }

  // ---------- Удаление аккаунта ----------

  function openDeleteAccountSheet() {
    $('delete-account-sheet').classList.add('active');
  }

  function closeDeleteAccountSheet() {
    $('delete-account-sheet').classList.remove('active');
  }

  async function onConfirmDeleteAccount() {
    try {
      await apiPost('/account/delete', { username: session.username, code: session.code });
      closeDeleteAccountSheet();
      onLogout();
    } catch (err) {
      alert('Не удалось удалить аккаунт: ' + err.message);
    }
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
