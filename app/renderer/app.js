// Hanoff Gestão — inicialização, login, menu, busca rápida, atalhos e agendamentos em segundo plano
import { h, $, icon, toast, modal, field, input, time, dayShort, todayISO } from './ui.js';
import { get, patch, setUnauthorizedHandler, setConnectionHandler, setLockedHandler } from './api.js';
import agenda, { openAppointment, openNewAppointment, openBlock } from './views/agenda.js';
import historico from './views/historico.js';
import clientes from './views/clientes.js';
import servicos from './views/servicos.js';
import barbearia from './views/barbearia.js';
import caixa from './views/caixa.js';
import financeiro from './views/financeiro.js';
import equipe from './views/equipe.js';
import ajustes from './views/ajustes.js';
import dispositivos from './views/dispositivos.js';

const VIEWS = [agenda, historico, clientes, servicos, barbearia, caixa, financeiro, equipe, ajustes, dispositivos];
const GROUPS = ['Operação', 'Barbearia', 'Gestão', 'Sistema'];
const POLL_MS = 8000;
const STORE_POLL_MS = 60000;
const CATALOG_TTL_MS = 5 * 60 * 1000;

// Estado compartilhado com as telas
export const state = {
  user: null,
  config: null,
  day: todayISO(),     // dia aberto na agenda
  board: null,         // { day, appointments, blocks, pending }
  store: null,
  catalog: null,
  catalogAt: 0,
  current: null,
  lastSync: null,
  listeners: new Set(), // telas interessadas em atualizações da agenda
};

export const can = (permission) => state.user?.permissions.includes(permission) ?? false;
const allowedViews = () => VIEWS.filter(v => !v.permission || can(v.permission));
const pref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* sem armazenamento */ } };

// ---------- Tema ----------

function applyTheme() {
  const theme = pref('gestao-theme', 'dark');
  document.documentElement.dataset.theme = theme;
  window.gestao.setWindowTheme?.(theme);
}
export function setTheme(theme) {
  setPref('gestao-theme', theme);
  applyTheme();
}
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

// ---------- Som ----------

let audio = null;
export function ding({ force = false } = {}) {
  if (!force && !state.config?.sound) return;
  audio = audio || new AudioContext();
  audio.resume();
  const now = audio.currentTime;
  // dois acordes curtos, como a campainha de uma porta
  [[0, 659], [0.16, 880], [0.6, 659], [0.76, 988]].forEach(([offset, freq]) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.45);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.5);
  });
}

// ---------- Catálogo (serviços, barbeiros, configurações) ----------

export async function loadCatalog({ force = false } = {}) {
  if (!force && state.catalog && Date.now() - state.catalogAt < CATALOG_TTL_MS) return state.catalog;
  state.catalog = await get('/api/admin/catalog');
  state.catalogAt = Date.now();
  return state.catalog;
}
export const setCatalog = (catalog) => { state.catalog = catalog; state.catalogAt = Date.now(); };

// ---------- Agenda em segundo plano ----------

let knownPending = null;
let pollTimer = null;
let storeTimer = null;
let syncTimer = null;

// Uma consulta por vez: com a rede lenta, respostas fora de ordem poderiam trazer de volta
// uma lista antiga e fazer o mesmo agendamento "chegar" duas vezes (aviso em dobro)
let polling = null;
let pollAgain = false;

async function pollBoard() {
  if (!state.user) return;
  if (polling) {
    pollAgain = true; // alguém pediu atualização no meio: roda de novo ao terminar
    return polling;
  }
  polling = (async () => {
    try {
      const board = await get(`/api/admin/appointments?day=${state.day}`);
      if (board.day !== state.day) return; // trocaram de dia enquanto a resposta vinha
      const fresh = knownPending ? board.pending.filter(a => !knownPending.has(a.id) && a.source === 'site') : [];
      knownPending = new Set([...(knownPending || []), ...board.pending.map(a => a.id)]);
      state.board = board;
      state.lastSync = new Date();
      if (fresh.length) onNewBookings(fresh);
      updateCounters();
      state.listeners.forEach(fn => fn(board, fresh));
    } catch { /* a barra de status já mostra o problema */ }
  })();
  try {
    await polling;
  } finally {
    polling = null;
  }
  if (pollAgain) {
    pollAgain = false;
    await pollBoard();
  }
}

function onNewBookings(fresh) {
  const today = todayISO();
  const relevant = state.config?.notifyAll === false ? fresh.filter(a => a.day === today) : fresh;
  if (!relevant.length) return;
  ding();
  const first = relevant[0];
  const when = (a) => `${a.day === today ? 'hoje' : dayShort(a.day)} às ${a.start}`;
  const title = relevant.length === 1 ? `Novo agendamento ${first.code}` : `${relevant.length} agendamentos novos pelo site`;
  const body = relevant.length === 1
    ? `${first.customerName} • ${when(first)} • ${first.services.map(s => s.name).join(' + ')} com ${first.barberName}`
    : 'Abra a agenda para confirmar';
  window.gestao.notify(title, body);
  toast(`${title}: ${relevant.length === 1 ? `${first.customerName}, ${when(first)}` : 'confira a agenda'}`, 'info');
}

export const refreshBoard = () => pollBoard();

/** Abre outro dia na agenda (a consulta seguinte já vem desse dia) */
export function setAgendaDay(day) {
  state.day = day;
  state.board = null;
  return pollBoard();
}

function updateCounters() {
  const pending = state.board?.pending.length || 0;
  const badge = $('#nav [data-view="agenda"] .nav__badge');
  if (badge) {
    badge.textContent = String(pending);
    badge.hidden = pending === 0;
    badge.title = `${pending} aguardando confirmação`;
  }
  document.title = pending ? `(${pending}) Hanoff Gestão` : 'Hanoff Gestão';
  const today = state.board?.day === todayISO() ? state.board.appointments.filter(a => !['cancelado', 'faltou'].includes(a.status)).length : null;
  $('#active-text').replaceChildren(icon('calendar'), today === null ? `${pending} a confirmar` : `${today} hoje • ${pending} a confirmar`);
  updateSync();
}

function updateSync() {
  if (!state.lastSync) return;
  const secs = Math.round((Date.now() - state.lastSync) / 1000);
  $('#sync-text').replaceChildren(icon('refresh'), secs < 15 ? 'Sincronizado agora' : `Sincronizado às ${time(state.lastSync.toISOString())}`);
}

// ---------- Agenda online (pausa) ----------

export async function refreshStore() {
  try {
    state.store = await get('/api/admin/store');
    renderStoreCard();
  } catch { /* sem conexão */ }
}

function renderStoreCard() {
  const { settings, status } = state.store;
  const kind = settings.paused ? 'warn' : status.open ? 'ok' : 'danger';
  $('#store-dot').className = `dot dot--${kind} ${status.open && !settings.paused ? 'dot--live' : ''}`;
  $('#store-title').textContent = settings.paused ? 'Agenda online pausada' : 'Agenda online ativa';
  $('#store-label').textContent = settings.paused ? (settings.pauseMessage || 'O site não aceita agendamentos') : status.label;
  const b = $('#store-pause');
  b.hidden = !can('store.pause');
  b.className = `btn btn--sm btn--block ${settings.paused ? 'btn--ok' : ''}`;
  b.title = settings.paused ? 'Voltar a aceitar agendamentos pelo site' : 'Parar de aceitar agendamentos pelo site';
  b.replaceChildren(icon(settings.paused ? 'play' : 'pause'), h('span', {}, settings.paused ? 'Retomar agenda online' : 'Pausar agenda online'));
}

export async function togglePause() {
  if (state.store?.settings.paused) {
    state.store = await patch('/api/admin/store', { paused: false, pauseMessage: '' });
    renderStoreCard();
    toast('Agenda online retomada: o site voltou a aceitar agendamentos');
    return;
  }
  const msg = input({ placeholder: 'Ex.: Voltamos a agendar amanhã', maxlength: 120 });
  modal({
    title: 'Pausar a agenda online',
    icon: 'pause',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'O site para de aceitar agendamentos até você retomar. Os horários já marcados continuam valendo, e a equipe segue agendando pelo app.'),
      field('Mensagem para o cliente (opcional)', msg)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Pausar agenda online', kind: 'primary', icon: 'pause', submit: true,
        onClick: async () => {
          state.store = await patch('/api/admin/store', { paused: true, pauseMessage: msg.value });
          renderStoreCard();
          toast('Agenda online pausada');
        },
      },
    ],
  });
}

// ---------- Navegação ----------

function buildNav() {
  const views = allowedViews();
  $('#nav').replaceChildren(...GROUPS.map(group => {
    const items = views.filter(v => v.group === group);
    if (!items.length) return null;
    return h('div', { class: 'nav-group' },
      h('div', { class: 'nav-group__label' }, group),
      items.map(v => h('button', { class: 'nav__item', dataset: { view: v.id }, title: v.label, onclick: () => go(v.id) },
        icon(v.icon, { size: 19 }), h('span', { class: 'nav__label' }, v.label),
        v.id === 'agenda' ? h('span', { class: 'nav__badge', hidden: true }, '0') : h('span', { class: 'nav__key' }, `Ctrl ${views.indexOf(v) + 1}`))));
  }).filter(Boolean));
}

export function go(id) {
  const view = allowedViews().find(v => v.id === id) || allowedViews()[0];
  state.current?.destroy?.();
  state.listeners.clear();
  document.querySelectorAll('.nav__item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view.id));
  $('#view-title').textContent = view.title || view.label;
  $('#view-subtitle').textContent = view.subtitle || '';
  $('#crumb').replaceChildren(view.group, icon('chevronRight', { size: 13 }), h('b', {}, view.label));
  $('#view-actions').replaceChildren();
  const container = $('#view');
  // recria o elemento para reiniciar a animação de entrada
  const fresh = container.cloneNode(false);
  container.replaceWith(fresh);
  state.current = view;
  view.render(fresh, { actions: $('#view-actions'), setSubtitle: (t) => { $('#view-subtitle').textContent = t; } });
  setPref('gestao-view', view.id);
}

function setCollapsed(collapsed) {
  $('#app').classList.toggle('is-collapsed', collapsed);
  $('#collapse').replaceChildren(icon('sidebar', { size: 16 }));
  $('#collapse').title = collapsed ? 'Expandir menu (Ctrl+B)' : 'Recolher menu (Ctrl+B)';
  setPref('gestao-collapsed', collapsed ? '1' : '0');
}
const toggleCollapsed = () => setCollapsed(!$('#app').classList.contains('is-collapsed'));

// ---------- Busca rápida (Ctrl+K) ----------

let paletteOpen = false;

function openPalette() {
  if (!state.user || paletteOpen) return;
  paletteOpen = true;
  const search = h('input', { placeholder: 'Buscar cliente, agendamento (nº, nome, telefone), tela ou ação…', spellcheck: 'false' });
  const list = h('div', { class: 'palette__list', role: 'listbox' });
  let items = [];
  let active = 0;

  const close = () => {
    paletteOpen = false;
    backdrop.remove();
  };

  function entries(q) {
    const query = q.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    const views = allowedViews();
    const groups = [];

    if (query) {
      const seen = new Set();
      const pool = [...(state.board?.appointments || []), ...(state.board?.pending || [])].filter(a => !seen.has(a.id) && seen.add(a.id));
      const found = pool.filter(a => a.customerName.toLowerCase().includes(query) || a.code.includes(query)
        || (digits.length >= 2 && (a.customerPhone.includes(digits) || String(a.id) === digits))).slice(0, 7);
      if (found.length) {
        groups.push(['Agendamentos', found.map(a => ({ icon: 'calendar', label: `${a.code} · ${a.customerName}`, hint: `${dayShort(a.day)} ${a.start} · ${a.barberName}`, run: () => openAppointment(a.id) }))]);
      }
    }
    groups.push(['Ir para', views.filter(v => !query || v.label.toLowerCase().includes(query)).map(v => ({ icon: v.icon, label: v.label, hint: `Ctrl ${views.indexOf(v) + 1}`, run: () => go(v.id) }))]);
    const actions = [
      can('agenda.book') && { icon: 'calendarPlus', label: 'Novo agendamento', hint: 'Ctrl N', run: () => openNewAppointment({}) },
      can('agenda.block') && { icon: 'ban', label: 'Bloquear horário (almoço, folga, férias)', run: () => openBlock({}) },
      can('store.pause') && { icon: state.store?.settings.paused ? 'play' : 'pause', label: state.store?.settings.paused ? 'Retomar agenda online' : 'Pausar agenda online', run: () => togglePause().catch(e => toast(e.message, 'error')) },
      { icon: 'refresh', label: 'Atualizar agenda', hint: 'F5', run: () => refreshBoard().then(() => toast('Agenda atualizada')) },
      { icon: document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun', label: 'Alternar tema claro/escuro', run: toggleTheme },
      { icon: 'sidebar', label: 'Recolher/expandir menu', hint: 'Ctrl B', run: toggleCollapsed },
      { icon: 'keyboard', label: 'Atalhos de teclado', hint: 'F1', run: showShortcuts },
      { icon: 'logout', label: 'Sair da conta', run: logout },
    ].filter(Boolean).filter(a => !query || a.label.toLowerCase().includes(query));
    groups.push(['Ações', actions]);
    return groups.filter(([, l]) => l.length);
  }

  function draw() {
    const groups = entries(search.value);
    items = groups.flatMap(([, l]) => l);
    active = Math.min(active, Math.max(0, items.length - 1));
    let i = 0;
    list.replaceChildren(...(items.length ? groups.map(([title, l]) => [
      h('div', { class: 'palette__group' }, title),
      l.map(item => {
        const idx = i++;
        return h('button', {
          class: `palette__item ${idx === active ? 'is-active' : ''}`, role: 'option',
          onmousemove: () => { if (active !== idx) { active = idx; draw(); } },
          onclick: () => { close(); item.run(); },
        }, icon(item.icon), h('span', {}, item.label), item.hint ? h('small', {}, item.hint) : null);
      }),
    ]).flat(2) : [h('div', { class: 'empty' }, 'Nada encontrado')]));
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  search.addEventListener('input', () => { active = 0; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); draw(); }
    if (e.key === 'Enter' && items[active]) { e.preventDefault(); const item = items[active]; close(); item.run(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Busca rápida' },
      h('div', { class: 'palette__input' }, icon('search', { size: 19 }), search, h('kbd', {}, 'Esc')),
      list,
      h('div', { class: 'palette__foot' }, h('span', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' navegar'), h('span', {}, h('kbd', {}, 'Enter'), ' abrir'), h('span', {}, h('kbd', {}, 'Esc'), ' fechar'))));
  document.body.append(backdrop);
  draw();
  search.focus();
}

function showShortcuts() {
  const row = (keys, text) => [h('span', {}, text), h('span', {}, keys.map(k => h('kbd', {}, k)))];
  modal({
    title: 'Atalhos de teclado',
    icon: 'keyboard',
    body: h('div', { class: 'shortcuts' },
      row(['Ctrl', 'K'], 'Busca rápida (clientes, agendamentos, telas e ações)'),
      row(['Ctrl', 'N'], 'Novo agendamento'),
      row(['Ctrl', '1…9'], 'Ir para as telas do menu'),
      row(['F5'], 'Atualizar a agenda agora'),
      row(['Ctrl', 'B'], 'Recolher/expandir o menu'),
      row(['Esc'], 'Fechar janelas'),
      row(['F1'], 'Esta lista')),
    actions: [{ label: 'Fechar', kind: 'primary' }],
  });
}

function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!state.user) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (paletteOpen || document.querySelector('.modal-backdrop')) return;
    if (ctrl && /^[1-9]$/.test(e.key)) {
      const view = allowedViews()[Number(e.key) - 1];
      if (view) { e.preventDefault(); go(view.id); }
    } else if (ctrl && e.key.toLowerCase() === 'n' && can('agenda.book')) {
      e.preventDefault();
      openNewAppointment({});
    } else if (ctrl && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleCollapsed();
    } else if (e.key === 'F5') {
      e.preventDefault();
      refreshBoard().then(() => toast('Agenda atualizada'));
    } else if (e.key === 'F1') {
      e.preventDefault();
      showShortcuts();
    }
  });
}

// ---------- Login ----------

function showShell(visible) {
  $('#body').hidden = !visible;
  $('#search-trigger').hidden = !visible;
  $('#crumb').hidden = !visible;
  $('#login-screen').hidden = visible;
}

async function showLogin(message) {
  stopPolling();
  state.user = null;
  showShell(false);
  state.config = await window.gestao.getConfig();
  $('#login-server').textContent = state.config.serverUrl.replace(/^https?:\/\//, '');
  const err = $('#login-error');
  err.hidden = !message;
  err.replaceChildren(icon('alert', { size: 16 }), h('span', {}, message || ''));
  $('#login-pass').value = '';
  $('#login-user').focus();
  setConnection(true);
}

async function enterApp(user) {
  state.user = user;
  state.config = await window.gestao.getConfig();
  state.day = todayISO();
  showShell(true);
  $('#user-name').textContent = user.displayName;
  $('#user-role').textContent = user.roleLabel;
  $('#user-avatar').textContent = user.displayName.slice(0, 1).toUpperCase();
  $('#server-text').replaceChildren(icon('server'), state.config.serverUrl.replace(/^https?:\/\//, ''));
  buildNav();
  setCollapsed(pref('gestao-collapsed', '0') === '1');
  knownPending = null;
  await Promise.all([pollBoard(), refreshStore(), loadCatalog({ force: true }).catch(() => null)]);
  go(pref('gestao-view', 'agenda'));
  pollTimer = setInterval(pollBoard, POLL_MS);
  storeTimer = setInterval(refreshStore, STORE_POLL_MS);
  syncTimer = setInterval(updateSync, 5000);
}

function stopPolling() {
  clearInterval(pollTimer);
  clearInterval(storeTimer);
  clearInterval(syncTimer);
  state.current?.destroy?.();
  state.current = null;
}

export async function logout() {
  await window.gestao.logout();
  showLogin();
}

export async function reloadConfig() {
  state.config = await window.gestao.getConfig();
  return state.config;
}

function changeServer() {
  const url = input({ value: state.config.serverUrl, placeholder: 'https://barbearia-hanoff.vercel.app' });
  modal({
    title: 'Endereço do servidor',
    icon: 'server',
    body: field('Endereço do site', url, 'O app usa a API do site. Para testes locais: http://localhost:3000'),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', submit: true,
        onClick: async () => {
          const res = await window.gestao.setConfig({ serverUrl: url.value });
          if (!res.ok) throw new Error(res.error);
          state.config = res.config;
          $('#login-server').textContent = res.config.serverUrl.replace(/^https?:\/\//, '');
        },
      },
    ],
  });
}

function setupLogin() {
  $('#login-features').replaceChildren(
    ...[['calendar', 'Agenda ao vivo'], ['bell', 'Aviso de agendamento'], ['wallet', 'Caixa e financeiro']].map(([i, t]) => h('span', {}, icon(i), t)));
  $('#login-server-icon').replaceChildren(icon('server'));
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#login-submit');
    b.disabled = true;
    b.textContent = 'Entrando…';
    try {
      const res = await window.gestao.login($('#login-user').value.trim(), $('#login-pass').value, $('#login-remember').checked);
      if (!res.ok) throw new Error(res.data?.error || 'Não foi possível entrar');
      await enterApp(res.data.user);
    } catch (error) {
      $('#login-error').replaceChildren(icon('alert', { size: 16 }), h('span', {}, error.message));
      $('#login-error').hidden = false;
    } finally {
      b.disabled = false;
      b.textContent = 'Entrar';
    }
  });
  $('#login-change-server').addEventListener('click', changeServer);
}

// ---------- Início ----------

// Sem conexão por mais de 1 minuto: avisa (agendamentos novos não estão chegando)
const OFFLINE_ALERT_MS = 60000;
let offlineSince = null;
let offlineAlerted = false;

function setConnection(online, error) {
  $('#conn-dot').className = `dot dot--${online ? 'ok' : 'danger'}`;
  $('#conn-text').textContent = online ? 'Conectado' : 'Sem conexão com o servidor';
  $('#conn-text').title = online ? '' : error || '';
  if (online) {
    if (offlineAlerted && state.user) toast('Conexão restabelecida. Os agendamentos voltaram a chegar.');
    offlineSince = null;
    offlineAlerted = false;
    return;
  }
  offlineSince ??= Date.now();
  if (state.user && !offlineAlerted && Date.now() - offlineSince >= OFFLINE_ALERT_MS) {
    offlineAlerted = true;
    window.gestao.notify('Sem conexão com o servidor', 'Os agendamentos novos do site não estão chegando. Confira a internet deste computador.');
    toast('Sem conexão há mais de 1 minuto: os agendamentos novos não estão chegando.', 'error');
  }
}

async function start() {
  applyTheme();
  setupLogin();
  setupShortcuts();
  setUnauthorizedHandler((msg) => { if (state.user) showLogin(msg || 'Sua sessão expirou. Entre novamente.'); });
  setConnectionHandler(setConnection);
  setLockedHandler((msg) => { if (state.user) showLogin(msg); });
  $('#search-icon').replaceChildren(icon('search', { size: 15 }));
  $('#search-trigger').addEventListener('click', openPalette);
  $('#logout').replaceChildren(icon('logout', { size: 16 }));
  $('#logout').addEventListener('click', logout);
  $('#collapse').addEventListener('click', toggleCollapsed);
  $('#store-pause').addEventListener('click', () => togglePause().catch(err => toast(err.message, 'error')));
  $('#shortcuts-btn').replaceChildren(icon('keyboard', { size: 14 }), 'Atalhos');
  $('#shortcuts-btn').addEventListener('click', showShortcuts);

  const started = Date.now();
  state.config = await window.gestao.getConfig();
  $('#version-text').textContent = `v${state.config.version}`;
  const user = await window.gestao.restoreSession();
  if (user && !user.offline) await enterApp(user);
  else if (user?.locked) await showLogin(user.error);
  else await showLogin(user?.offline ? `${user.error}. Confira a internet e tente de novo.` : '');
  // abertura visível por um instante, sem piscar
  setTimeout(() => $('#splash').classList.add('is-done'), Math.max(0, 700 - (Date.now() - started)));
}

start();
