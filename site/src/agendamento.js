// Página do agendamento (/agendamento/?t=TOKEN): situação, detalhes, agenda do celular e cancelamento.
// Sem token, mostra os horários marcados neste aparelho.
import { formatBRL, whatsappLink, longDate, shortDate, buildIcs, cap } from './utils.js';
import { formatDuration } from '../../shared/schedule.js';
import { h, ic, toast, downloadFile } from './dom.js';
import { upcomingBookings, forgetBooking } from './saved.js';

const POLL_MS = 60000;
const FINAL = ['concluido', 'faltou', 'cancelado'];
const STATUS_ICON = { agendado: 'hourglass', confirmado: 'circle-check', em_atendimento: 'scissors', concluido: 'circle-check', faltou: 'calendar-x', cancelado: 'calendar-x' };

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
let booking = null;
let timer = null;

function show(id) {
  for (const s of ['t-loading', 't-list', 't-error', 't-booking']) $(s).hidden = s !== id;
}

function showError(message) {
  show('t-error');
  if (message) $('t-error-msg').textContent = message;
}

function render(b) {
  booking = b;
  show('t-booking');
  document.title = `${b.code} • Meu agendamento | Barbearia Hanoff`;
  $('t-code').textContent = b.code;
  $('t-title').textContent = b.status === 'cancelado' ? 'Horário cancelado' : `Olá, ${b.firstName}!`;
  const status = $('t-status');
  status.className = `t-status t-status--${b.status}`;
  status.replaceChildren(ic(STATUS_ICON[b.status] || 'info'), b.statusLabel);

  const services = b.services.map(s => s.name).join(' + ');
  $('t-recap').replaceChildren(
    h('div', { class: 'b-recap__row' }, ic('calendar-check'), h('span', {}, h('b', {}, cap(longDate(b.day))), ` às ${b.time}`)),
    h('div', { class: 'b-recap__row' }, ic('user-round'), h('span', {}, 'com ', h('b', {}, b.barberName))),
    h('div', { class: 'b-recap__row' }, ic('scissors'), h('span', {}, services)),
    h('div', { class: 'b-recap__row' }, ic('hourglass'), h('span', {}, `${formatDuration(b.duration)} · até ${b.endTime}`)),
    b.store.address ? h('div', { class: 'b-recap__row' }, ic('map-pin'), h('span', {}, [b.store.address, b.store.city].filter(Boolean).join(', '))) : null,
    h('div', { class: 'b-recap__total' }, h('span', {}, b.priceFrom ? 'Total (a partir de)' : 'Total'), h('strong', {}, formatBRL(b.price))));

  const active = !FINAL.includes(b.status);
  const link = location.href;
  const wa = whatsappLink(b.store.whatsappPhone, `Olá! Sobre o meu agendamento ${b.code} (${shortDate(b.day)} às ${b.time} com ${b.barberName}):`);
  const maps = b.store.mapsUrl || (b.store.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([b.store.name, b.store.address, b.store.city].filter(Boolean).join(', '))}` : '');
  $('t-actions').replaceChildren(...[
    active ? h('button', {
      class: 'btn btn--primary btn--block', type: 'button',
      onclick: () => downloadFile(`hanoff-${b.day}-${b.time.replace(':', 'h')}.ics`, buildIcs({
        uid: token, title: `${services} • ${b.store.name}`, day: b.day, time: b.time, duration: b.duration,
        location: [b.store.address, b.store.city].filter(Boolean).join(', '), description: `Agendamento ${b.code} com ${b.barberName}.\n${link}`,
      }), 'text/calendar;charset=utf-8'),
    }, ic('calendar-plus'), 'Adicionar à agenda do celular') : null,
    maps && active ? h('a', { class: 'btn btn--ghost btn--block', href: maps, target: '_blank', rel: 'noopener' }, ic('navigation'), 'Como chegar') : null,
    wa ? h('a', { class: 'btn btn--ghost btn--block', href: wa, target: '_blank', rel: 'noopener' }, ic('whatsapp'), 'Falar com a barbearia') : null,
    !active ? h('a', { class: 'btn btn--primary btn--block', href: '/#servicos' }, ic('calendar-plus'), 'Agendar outro horário') : null,
  ].filter(Boolean));

  $('t-cancel').hidden = !b.canCancel;
  $('t-confirm').hidden = true;
  $('t-note').textContent = active && !b.canCancel && ['agendado', 'confirmado'].includes(b.status)
    ? `Faltam menos de ${b.cancelHours}h para o horário. Para desmarcar, fale com a barbearia.`
    : b.status === 'agendado' ? 'A barbearia confirma o horário em breve. Esta página se atualiza sozinha.' : '';

  if (FINAL.includes(b.status)) {
    clearInterval(timer);
    if (b.status === 'cancelado') forgetBooking(token);
  }
}

async function load() {
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return showError();
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    if (!booking) showError('Não conseguimos carregar agora. Confira a internet e tente de novo em instantes.');
  }
}

async function cancel() {
  const yes = $('t-confirm-yes');
  yes.disabled = true;
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(token)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Não foi possível cancelar agora.');
    render(data);
    toast('Agendamento cancelado. O horário ficou livre.');
  } catch (error) {
    toast(error.message, 'error');
    $('t-confirm').hidden = true;
  } finally {
    yes.disabled = false;
  }
}

function renderList() {
  const list = upcomingBookings();
  show('t-list');
  $('t-list-hint').textContent = list.length ? 'Horários marcados neste aparelho.' : 'Nenhum horário marcado neste aparelho. Use o link que aparece ao agendar.';
  $('t-list-items').replaceChildren(...list.map(b => h('a', { class: 'my-item', href: `?t=${encodeURIComponent(b.token)}` },
    ic('calendar-check'), h('div', {}, h('b', {}, `${cap(shortDate(b.day))} às ${b.time}`), h('span', {}, [b.services, b.barberName && `com ${b.barberName}`].filter(Boolean).join(' · '))), ic('chevron-right'))));
}

$('t-cancel').addEventListener('click', () => { $('t-confirm').hidden = false; $('t-cancel').hidden = true; });
$('t-confirm-no').addEventListener('click', () => { $('t-confirm').hidden = true; $('t-cancel').hidden = !booking?.canCancel; });
$('t-confirm-yes').addEventListener('click', cancel);

if (!token) {
  renderList();
} else if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) {
  showError();
} else {
  load();
  timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !FINAL.includes(booking?.status)) load(); });
}
