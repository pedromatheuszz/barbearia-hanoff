// Página principal: serviços, barbeiros, horários e contatos vindos do catálogo (app de gestão),
// vitrine com os próximos horários livres e a janela de agendamento.
import { SERVICES, BARBERS, BARBERS_BY_ID, SETTINGS, loadLiveCatalog, currentStoreStatus } from './catalog.js';
import { CATEGORIES, priceFor } from '../../shared/services.js';
import { formatDuration, doesAll } from '../../shared/schedule.js';
import { WEEKDAYS, describeDay, saoPauloParts } from '../../shared/store-hours.js';
import { formatBRL, maskPhone, whatsappLink, dayLabel, shortDate, cap } from './utils.js';
import { h, ic, avatar } from './dom.js';
import { CATEGORY_ICONS } from './icons.js';
import { initBooking, openBooking } from './booking.js';
import { upcomingBookings } from './saved.js';
import { initAnimations, refreshAnimations } from './animations.js';

const $ = (id) => document.getElementById(id);
const HERO_SERVICE = 'corte';
let category = 'all';

// ---------- Tema, cabeçalho e menu ----------

function initChrome() {
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('hanoff-theme', next); } catch { /* sem armazenamento */ }
  });

  const header = $('header');
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('load', onScroll); // o navegador pode restaurar a rolagem depois de abrir
  onScroll();

  const nav = $('nav');
  const toggle = $('menu-toggle');
  const setMenu = (open) => {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  };
  toggle.addEventListener('click', () => setMenu(!nav.classList.contains('is-open')));
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  // qualquer botão "Agendar" abre a janela (com serviço ou barbeiro já escolhido, se houver)
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-book]');
    if (!trigger) return;
    e.preventDefault();
    openBooking({
      services: trigger.dataset.service ? [trigger.dataset.service] : [],
      barberId: trigger.dataset.barber || null,
    });
  });
  $('footer-year').textContent = String(new Date().getFullYear());
}

// ---------- Situação agora ----------

function renderStatus() {
  const status = currentStoreStatus();
  const pill = $('store-status');
  pill.classList.toggle('is-open', status.open);
  pill.classList.toggle('is-paused', Boolean(status.paused));
  $('store-status-text').textContent = status.label;
}

// ---------- Serviços ----------

function servicePrice(s) {
  const prices = BARBERS.filter(b => doesAll(b, [s.id])).map(b => priceFor(s, b));
  const min = prices.length ? Math.min(...prices) : s.price;
  return { min, from: s.priceFrom };
}

/** "Com Renan: R$ 55,00" para quem cobra diferente neste serviço */
function specialPrices(s) {
  return BARBERS.filter(b => doesAll(b, [s.id]) && Number.isFinite(b.prices?.[s.id]) && b.prices[s.id] !== s.price)
    .map(b => `com ${b.name}: ${formatBRL(b.prices[s.id])}`);
}

function renderServices() {
  const cats = CATEGORIES.filter(c => SERVICES.some(s => s.category === c.id));
  $('services-tabs').replaceChildren(...[['all', 'Todos', 'sparkles'], ...cats.map(c => [c.id, c.label, CATEGORY_ICONS[c.id] || 'scissors'])].map(([id, label, iconName]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(category === id), onclick: () => { category = id; renderServices(); refreshAnimations(); } },
      ic(iconName), label)));

  const groups = (category === 'all' ? cats : cats.filter(c => c.id === category))
    .map(c => ({ ...c, items: SERVICES.filter(s => s.category === c.id) }));
  $('services-list').replaceChildren(...groups.flatMap(g => [
    h('h3', { class: 'service-group' }, ic(CATEGORY_ICONS[g.id] || 'scissors'), g.label),
    ...g.items.map(s => {
      const price = servicePrice(s);
      const special = specialPrices(s);
      return h('article', { class: 'service' },
        h('h4', { class: 'service__name' }, s.name),
        h('p', { class: 'service__price' }, price.from ? h('small', {}, 'a partir de') : null, formatBRL(price.min)),
        h('p', { class: 'service__meta' },
          h('span', { class: 'dur' }, ic('clock'), formatDuration(s.duration)),
          s.badge ? h('span', { class: 'pill pill--brass' }, s.badge) : null,
          s.desc ? h('span', {}, s.desc) : null),
        special.length ? h('p', { class: 'service__extra' }, special.join(' · ')) : null,
        h('button', { class: 'service__book', type: 'button', dataset: { book: '', service: s.id }, 'aria-label': `Agendar ${s.name}` }, 'Agendar', ic('arrow-right')));
    }),
  ]));
  const hasPlan = SERVICES.some(s => /plano/i.test(s.badge || ''));
  $('services-note').hidden = !hasPlan;
  $('services-note').replaceChildren(ic('info'), h('span', {}, 'Corte, barba e combos com selo "Plano mensal" também podem ser contratados como assinatura. Pergunte na barbearia.'));
}

// ---------- Barbeiros ----------

function renderBarbers() {
  $('barbers-list').replaceChildren(...BARBERS.map(b => h('article', { class: 'barber', 'data-reveal': '' },
    avatar(b, 'lg'),
    h('h3', {}, b.name),
    h('p', {}, b.title || 'Barbeiro'),
    b.bio ? h('p', {}, b.bio) : null,
    h('button', { class: 'btn btn--ghost btn--sm', type: 'button', dataset: { book: '', barber: b.id } }, ic('calendar-plus'), `Agendar com ${b.name}`))));
  $('proof-barbers').textContent = String(BARBERS.length);
  $('proof-services').textContent = String(SERVICES.length);
}

// ---------- Contato e horários ----------

function renderContact() {
  const s = SETTINGS;
  const wa = whatsappLink(s.whatsappPhone, 'Olá! Vim pelo site da Barbearia Hanoff.');
  for (const id of ['hero-whatsapp', 'contact-whatsapp']) {
    const a = $(id);
    a.hidden = !wa;
    if (wa) a.href = wa;
  }
  $('contact-phone').hidden = !s.whatsappPhone;
  $('contact-phone').textContent = s.whatsappPhone ? `WhatsApp ${maskPhone(s.whatsappPhone)}` : '';
  const ig = $('contact-instagram');
  ig.hidden = !s.instagram;
  if (s.instagram) {
    ig.href = `https://www.instagram.com/${encodeURIComponent(s.instagram)}/`;
    ig.querySelector('span').textContent = `@${s.instagram}`;
  }
  const maps = $('contact-maps');
  maps.hidden = !s.mapsUrl && !s.address;
  maps.href = s.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.storeName, s.address, s.city].filter(Boolean).join(', '))}`;
  if (s.address) {
    $('contact-address').querySelector('span').replaceChildren(s.address, h('br'), s.city || '');
    $('footer-address').textContent = [s.address, s.city].filter(Boolean).join(' · ');
  }

  const today = saoPauloParts().weekday;
  $('hours-list').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].flatMap(d => {
    const cls = [d === today ? 'is-today' : '', s.hours?.[d] ? '' : 'is-closed'].join(' ').trim();
    return [h('dt', { class: cls }, d === today ? `${cap(WEEKDAYS[d])} (hoje)` : cap(WEEKDAYS[d])), h('dd', { class: cls }, describeDay(s.hours?.[d]))];
  }));
}

// ---------- Vitrine: próximos horários livres ----------

async function renderHeroSlots() {
  const list = $('hero-slots');
  const service = SERVICES.find(x => x.id === HERO_SERVICE) || SERVICES[0];
  if (!service) return;
  const price = servicePrice(service);
  $('ticket-service').textContent = `${service.name} · ${formatDuration(service.duration)} · a partir de ${formatBRL(price.min)}`;

  const empty = (text) => list.replaceChildren(h('li', { class: 'ticket__empty' }, h('span', {}, text),
    h('button', { class: 'btn btn--primary btn--sm', type: 'button', dataset: { book: '' } }, ic('calendar-plus'), 'Escolher horário')));

  if (currentStoreStatus().paused) return empty('A agenda online está pausada no momento.');
  try {
    const params = new URLSearchParams({ services: service.id, barber: 'any', limit: '5' });
    const res = await fetch(`/api/availability?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(String(res.status));
    const { slots = [] } = await res.json();
    if (!slots.length) return empty('Nenhum horário livre nos próximos dias. Fale com a gente pelo WhatsApp.');
    const today = saoPauloParts().day;
    list.replaceChildren(...slots.map(slot => {
      const who = BARBERS_BY_ID.get(slot.barbers[0]);
      const label = dayLabel(slot.day, today);
      const when = ['Hoje', 'Amanhã'].includes(label.top) ? label.top : shortDate(slot.day);
      return h('li', {}, h('button', {
        class: 'ticket__slot', type: 'button', 'aria-label': `${when} às ${slot.time} com ${who?.name || 'barbeiro'}: agendar`,
        onclick: () => openBooking({ services: [service.id], barberId: slot.barbers[0], day: slot.day, time: slot.time }),
      },
      h('time', { datetime: `${slot.day}T${slot.time}` }, slot.time),
      h('span', {}, h('b', {}, cap(when)), who ? `com ${who.name}` : ''),
      ic('arrow-right')));
    }));
  } catch {
    empty('Veja os horários livres e agende em poucos toques.');
  }
}

// ---------- Horário já marcado neste aparelho ----------

function renderNextBooking() {
  const next = upcomingBookings()[0];
  const chip = $('next-booking');
  chip.hidden = !next;
  if (!next) return;
  chip.href = `/agendamento/?t=${encodeURIComponent(next.token)}`;
  chip.replaceChildren(h('span', { class: 'badge' }, ic('calendar-check')),
    h('div', {}, h('b', {}, 'Seu horário'), h('span', {}, `${cap(shortDate(next.day))} às ${next.time}${next.barberName ? ` · ${next.barberName}` : ''}`)));
}

// ---------- Início ----------

function renderAll() {
  renderStatus();
  renderServices();
  renderBarbers();
  renderContact();
  refreshAnimations();
}

document.addEventListener('DOMContentLoaded', async () => {
  initChrome();
  initBooking();
  renderAll();
  renderNextBooking();
  initAnimations();

  // Catálogo atualizado pelo app de gestão. Espera no máximo 2,5 s; se a API estiver lenta,
  // abre com a cópia do build e atualiza quando a resposta chegar.
  const live = loadLiveCatalog();
  const first = await Promise.race([live, new Promise(resolve => setTimeout(() => resolve(null), 2500))]);
  if (first?.changed) renderAll();
  else if (!first) live.then(({ changed }) => { if (changed) renderAll(); });
  renderHeroSlots();

  // confere mudanças (preço, horário, pausa) a cada 2 minutos com a página aberta
  setInterval(() => {
    if (document.hidden) return;
    loadLiveCatalog().then(({ live: ok, changed }) => {
      if (changed) renderAll();
      if (ok) renderHeroSlots();
    });
  }, 2 * 60 * 1000);
  setInterval(renderStatus, 60 * 1000);
  document.addEventListener('booking:done', () => { renderNextBooking(); renderHeroSlots(); });
});
