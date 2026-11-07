// Janela de agendamento em 4 passos: serviços → barbeiro → dia e horário → seus dados.
// Os horários vêm de /api/availability e o servidor confere tudo de novo ao gravar
// (POST /api/bookings), então o que o navegador mostra nunca vale como garantia.
import { SERVICES, SERVICES_BY_ID, BARBERS, BARBERS_BY_ID, SETTINGS, currentStoreStatus } from './catalog.js';
import { CATEGORIES, MAX_SERVICES, summarize, priceFor } from '../../shared/services.js';
import { doesAll, isWorkingDay, addDays, formatDuration } from '../../shared/schedule.js';
import { saoPauloParts } from '../../shared/store-hours.js';
import { formatBRL, maskPhone, whatsappLink, dayLabel, longDate, shortDate, groupSlots, buildIcs, newClientRef, cap } from './utils.js';
import { h, ic, toast, avatar, downloadFile } from './dom.js';
import { CATEGORY_ICONS } from './icons.js';
import { saveBooking } from './saved.js';

const STEPS = [
  { id: 'services', title: 'Escolha os serviços' },
  { id: 'barber', title: 'Escolha o barbeiro' },
  { id: 'time', title: 'Dia e horário' },
  { id: 'details', title: 'Seus dados' },
];
const CUSTOMER_KEY = 'hanoff-customer';

const $ = (id) => document.getElementById(id);
const els = {};
let state = null;
let lastFocus = null;
let slotsRequest = 0;

const fresh = () => ({
  step: 0,
  services: new Set(),
  category: 'all',
  barberId: 'any',
  day: null,
  time: null,
  assigned: null,      // barbeiro que vai atender (no "sem preferência", o primeiro livre no horário)
  slots: null,
  prices: {},
  loading: false,
  error: '',
  paused: false,
  clientRef: null,
  sending: false,
  result: null,
});

const pref = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const setPref = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento */ } };

const chosen = () => SERVICES.filter(s => state.services.has(s.id));
const serviceIds = () => chosen().map(s => s.id);
const candidates = () => BARBERS.filter(b => doesAll(b, serviceIds()));
const barber = () => (state.barberId === 'any' ? null : BARBERS_BY_ID.get(state.barberId));
const today = () => saoPauloParts().day;

/** Preço para mostrar antes de saber o barbeiro: o menor entre os possíveis ("a partir de" se varia) */
function priceRange(services = chosen()) {
  const list = barber() ? [barber()] : candidates();
  const prices = (list.length ? list : [null]).map(b => summarize(services, b).price);
  const min = Math.min(...prices);
  return { min, varies: Math.max(...prices) !== min || summarize(services).priceFrom };
}

function finalPrice() {
  const who = state.assigned ? BARBERS_BY_ID.get(state.assigned) : barber();
  return who ? summarize(chosen(), who).price : priceRange().min;
}

// ---------- Abrir e fechar ----------

export function initBooking() {
  Object.assign(els, {
    root: $('booking'), body: $('booking-body'), title: $('booking-title'), step: $('booking-step'),
    progress: $('booking-progress'), summary: $('booking-summary'), next: $('booking-next'), back: $('booking-back'), foot: $('booking-foot'),
  });
  els.root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeBooking(); });
  els.back.addEventListener('click', () => (state.step === 0 || state.result ? closeBooking() : go(state.step - 1)));
  els.next.addEventListener('click', onNext);
  document.addEventListener('keydown', (e) => {
    if (els.root.hidden) return;
    if (e.key === 'Escape') closeBooking();
    if (e.key === 'Tab') trapFocus(e);
  });
  // o botão "voltar" do celular fecha a janela em vez de sair do site
  window.addEventListener('popstate', () => { if (!els.root.hidden) closeBooking({ fromHistory: true }); });
}

/**
 * Abre o agendamento. Com serviço, barbeiro, dia e horário já escolhidos (vitrine de horários
 * livres), vai direto para "Seus dados".
 */
export function openBooking({ services = [], barberId = null, day = null, time = null } = {}) {
  state = fresh();
  services.filter(id => SERVICES_BY_ID.has(id)).slice(0, MAX_SERVICES).forEach(id => state.services.add(id));
  if (barberId && BARBERS_BY_ID.has(barberId)) state.barberId = barberId;
  lastFocus = document.activeElement;
  els.root.hidden = false;
  document.body.classList.add('is-locked');
  if (!history.state?.booking) history.pushState({ booking: true }, '');

  if (state.services.size && day && time) {
    state.day = day;
    state.time = time;
    state.assigned = barberId;
    go(3);
  } else {
    go(state.services.size ? 1 : 0);
  }
}

function closeBooking({ fromHistory = false } = {}) {
  if (els.root.hidden) return;
  els.root.hidden = true;
  document.body.classList.remove('is-locked');
  if (!fromHistory && history.state?.booking) history.back();
  lastFocus?.focus?.();
}

function trapFocus(e) {
  const items = [...els.root.querySelectorAll('button:not(:disabled), a[href], input, textarea, [tabindex="0"]')].filter(el => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------- Navegação ----------

function go(step) {
  state.step = step;
  state.error = '';
  const s = STEPS[step];
  els.title.textContent = s.title;
  els.step.textContent = `Passo ${step + 1} de ${STEPS.length}`;
  els.progress.style.width = `${((step + 1) / STEPS.length) * 100}%`;
  els.foot.hidden = false;
  els.back.setAttribute('aria-label', step === 0 ? 'Fechar' : 'Voltar');
  render();
  els.body.scrollTop = 0;
  if (s.id === 'time' && state.day && !state.slots) loadSlots();
  if (s.id === 'time' && !state.day) pickFirstDay();
  setTimeout(() => (els.body.querySelector('[aria-checked="true"], [aria-pressed="true"], input') || els.next).focus({ preventScroll: true }), 60);
}

function onNext() {
  const id = STEPS[state.step].id;
  if (id === 'details') return submit();
  if (id === 'services' && !state.services.size) return toast('Escolha pelo menos um serviço', 'error');
  if (id === 'time' && !state.time) return toast('Escolha um horário', 'error');
  go(state.step + 1);
}

function render() {
  const id = STEPS[state.step].id;
  const view = { services: renderServices, barber: renderBarber, time: renderTime, details: renderDetails }[id];
  els.body.replaceChildren(view());
  renderFoot();
}

function renderFoot() {
  const id = STEPS[state.step].id;
  const services = chosen();
  const sum = summarize(services);
  let line = h('span', {}, 'Escolha um ou mais serviços');
  if (services.length) {
    const { min, varies } = priceRange();
    const price = state.time ? formatBRL(finalPrice()) : `${varies ? 'a partir de ' : ''}${formatBRL(min)}`;
    line = [h('b', {}, price), h('span', {}, `${services.length === 1 ? services[0].name : `${services.length} serviços`} · ${formatDuration(sum.duration)}`)];
  }
  if (id === 'time' && state.time) {
    const who = BARBERS_BY_ID.get(state.assigned);
    line = [h('b', {}, `${cap(shortDate(state.day))} às ${state.time}`), h('span', {}, `${who ? `com ${who.name} · ` : ''}${formatBRL(finalPrice())}`)];
  }
  els.summary.replaceChildren(...[line].flat());
  els.next.textContent = id === 'details' ? (state.sending ? 'Confirmando…' : 'Confirmar agendamento') : 'Continuar';
  els.next.disabled = state.sending || (id === 'services' && !services.length) || (id === 'time' && !state.time);
}

// ---------- Passo 1: serviços ----------

function renderServices() {
  const cats = CATEGORIES.filter(c => SERVICES.some(s => s.category === c.id));
  const chips = h('div', { class: 'b-chips', role: 'tablist', 'aria-label': 'Categorias' },
    [['all', 'Todos', 'sparkles'], ...cats.map(c => [c.id, c.label, CATEGORY_ICONS[c.id] || 'scissors'])].map(([cid, label, iconName]) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.category === cid), onclick: () => { state.category = cid; render(); } },
        ic(iconName), label)));
  const list = SERVICES.filter(s => state.category === 'all' || s.category === state.category);
  return h('div', {},
    h('p', { class: 'b-hint' }, `Pode escolher até ${MAX_SERVICES} serviços para fazer em sequência.`),
    chips,
    barber() ? h('p', { class: 'b-hint' }, `Valores com ${barber().name}.`) : null,
    h('div', { class: 'b-list' }, list.map(s => {
      const checked = state.services.has(s.id);
      // com um barbeiro escolhido, o preço é o dele; sem preferência, o menor entre os que fazem
      const who = barber();
      const prices = (who ? [who] : BARBERS).filter(b => doesAll(b, [s.id])).map(b => priceFor(s, b));
      const unavailable = Boolean(who) && !prices.length;
      const min = prices.length ? Math.min(...prices) : s.price;
      const varies = s.priceFrom || (prices.length && Math.max(...prices) !== min);
      return h('button', {
        class: 'b-option', type: 'button', role: 'checkbox', 'aria-checked': String(checked), disabled: unavailable && !checked,
        onclick: () => toggleService(s.id),
      },
      h('span', { class: 'b-check' }, ic('check')),
      h('span', { class: 'b-option__main' }, h('b', {}, s.name),
        h('span', {}, unavailable ? `${who.name} não faz este serviço` : [formatDuration(s.duration), s.desc].filter(Boolean).join(' · '))),
      h('span', { class: 'b-option__price' }, varies ? h('small', {}, 'a partir de') : null, formatBRL(min)));
    })));
}

function toggleService(id) {
  if (state.services.has(id)) state.services.delete(id);
  else if (state.services.size >= MAX_SERVICES) return toast(`Escolha no máximo ${MAX_SERVICES} serviços por horário`, 'error');
  else state.services.add(id);
  // a escolha mudou: o barbeiro pode não fazer o serviço novo e o horário precisa ser refeito
  if (state.barberId !== 'any' && !doesAll(barber(), serviceIds())) state.barberId = 'any';
  resetTime();
  render();
}

function resetTime() {
  state.time = null;
  state.assigned = null;
  state.slots = null;
  state.clientRef = null;
}

// ---------- Passo 2: barbeiro ----------

function renderBarber() {
  const services = chosen();
  const able = candidates();
  const anyPrice = (() => {
    const prices = able.map(b => summarize(services, b).price);
    return prices.length ? Math.min(...prices) : 0;
  })();
  const option = (id, content, { disabled = false } = {}) => h('button', {
    class: 'b-option', type: 'button', role: 'radio', 'aria-checked': String(state.barberId === id), disabled,
    onclick: () => { if (state.barberId !== id) { state.barberId = id; resetTime(); } render(); },
  }, content);

  return h('div', {},
    h('div', { class: 'b-list', role: 'radiogroup', 'aria-label': 'Barbeiro' },
      option('any', [
        h('span', { class: 'b-check b-radio' }, ic('check')),
        h('span', { class: 'b-option__main' }, h('b', {}, 'Sem preferência'), h('span', {}, 'Fico com o primeiro horário livre')),
        h('span', { class: 'b-option__price' }, h('small', {}, 'a partir de'), formatBRL(anyPrice)),
      ]),
      BARBERS.map(b => {
        const does = doesAll(b, services.map(s => s.id));
        const missing = services.filter(s => (b.skipServices || []).includes(s.id)).map(s => s.name);
        return option(b.id, [
          avatar(b, 'sm'),
          h('span', { class: 'b-option__main' }, h('b', {}, b.name), h('span', {}, does ? b.title || 'Barbeiro' : `Não faz: ${missing.join(', ')}`)),
          h('span', { class: 'b-option__price' }, does ? formatBRL(summarize(services, b).price) : '—'),
        ], { disabled: !does });
      })));
}

// ---------- Passo 3: dia e horário ----------

function workingDays() {
  const list = barber() ? [barber()] : candidates();
  const first = today();
  const max = Math.max(1, Number(SETTINGS.maxDaysAhead) || 30);
  return Array.from({ length: max + 1 }, (_, i) => addDays(first, i)).map(day => ({ day, open: isWorkingDay(day, list, SETTINGS.hours) }));
}

function pickFirstDay() {
  const first = workingDays().find(d => d.open);
  if (first) selectDay(first.day);
}

function selectDay(day) {
  state.day = day;
  state.time = null;
  state.assigned = null;
  state.slots = null;
  render();
  loadSlots();
  setTimeout(() => els.body.querySelector('.b-day[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), 30);
}

async function loadSlots() {
  const request = ++slotsRequest;
  state.loading = true;
  state.error = '';
  render();
  try {
    const params = new URLSearchParams({ day: state.day, services: serviceIds().join(','), barber: state.barberId });
    const res = await fetch(`/api/availability?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (request !== slotsRequest) return; // o cliente já trocou de dia
    if (!res.ok) throw new Error(data.error || 'Não foi possível carregar os horários');
    state.slots = data.slots || [];
    state.prices = data.prices || {};
    state.paused = Boolean(data.paused);
  } catch (error) {
    if (request !== slotsRequest) return;
    state.slots = null;
    state.error = error.name === 'TimeoutError' || error instanceof TypeError ? 'Sem conexão com a agenda agora.' : error.message;
  } finally {
    if (request === slotsRequest) {
      state.loading = false;
      if (STEPS[state.step].id === 'time') render();
    }
  }
}

async function jumpToNextFree() {
  try {
    const params = new URLSearchParams({ services: serviceIds().join(','), barber: state.barberId, limit: '1' });
    const res = await fetch(`/api/availability?${params}`, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const next = data.slots?.[0];
    if (next) selectDay(next.day);
    else toast('Nenhum horário livre nos próximos dias. Fale com a gente no WhatsApp.', 'error');
  } catch {
    toast('Sem conexão com a agenda agora.', 'error');
  }
}

function renderTime() {
  const t = today();
  const strip = h('div', { class: 'b-days', role: 'group', 'aria-label': 'Dia' }, workingDays().map(({ day, open }) => {
    const label = dayLabel(day, t);
    return h('button', {
      class: 'b-day', type: 'button', 'aria-pressed': String(state.day === day), disabled: !open,
      'aria-label': `${longDate(day)}${open ? '' : ' (fechado)'}`, onclick: () => selectDay(day),
    }, h('small', {}, label.top), h('b', {}, label.num), h('span', {}, label.month));
  }));

  let content;
  const wa = whatsappLink(SETTINGS.whatsappPhone, 'Olá! Quero agendar um horário na Hanoff.');
  if (state.paused || currentStoreStatus().paused) {
    content = h('div', { class: 'b-empty' }, ic('calendar-x'), h('b', {}, 'Agenda online pausada'), h('span', {}, currentStoreStatus().label.replace(/^[^•]+• /, '')),
      wa ? h('a', { class: 'btn btn--ghost btn--sm', href: wa, target: '_blank', rel: 'noopener' }, ic('whatsapp'), 'Chamar no WhatsApp') : null);
  } else if (!state.day) {
    content = h('div', { class: 'b-empty' }, ic('calendar-x'), h('span', {}, 'Nenhum dia disponível para essa escolha.'));
  } else if (state.loading) {
    content = h('div', { class: 'b-loading' }, Array.from({ length: 12 }, () => h('div', { class: 'skeleton' })));
  } else if (state.error) {
    content = h('div', { class: 'b-empty' }, ic('circle-alert'), h('b', {}, state.error), h('span', {}, 'Tente de novo em instantes ou marque pelo WhatsApp.'),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: loadSlots }, ic('clock'), 'Tentar de novo'),
      wa ? h('a', { class: 'btn btn--ghost btn--sm', href: wa, target: '_blank', rel: 'noopener' }, ic('whatsapp'), 'WhatsApp') : null);
  } else if (state.slots && !state.slots.length) {
    content = h('div', { class: 'b-empty' }, ic('calendar-x'), h('b', {}, `Sem horários livres ${state.day === t ? 'hoje' : 'neste dia'}`),
      h('span', {}, barber() ? `Tente outro dia ou escolha "sem preferência".` : 'Tente outro dia.'),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: jumpToNextFree }, ic('arrow-right'), 'Próximo dia com horário'));
  } else if (state.slots) {
    content = h('div', {}, groupSlots(state.slots).map(g => h('div', { class: 'b-slot-group' },
      h('h4', {}, ic(g.icon), g.label),
      h('div', { class: 'b-slots' }, g.slots.map(s => h('button', {
        class: 'b-slot', type: 'button', 'aria-pressed': String(state.time === s.time),
        'aria-label': `${s.time}${state.barberId === 'any' ? ` com ${BARBERS_BY_ID.get(s.barbers[0])?.name || ''}` : ''}`,
        onclick: () => {
          state.time = s.time;
          state.assigned = state.barberId === 'any' ? s.barbers[0] : state.barberId;
          state.clientRef = null;
          render();
        },
      }, s.time))))));
  }

  return h('div', {},
    h('p', { class: 'b-hint' }, `${barber() ? `Agenda de ${barber().name}` : 'Horários de todos os barbeiros'} · ${formatDuration(summarize(chosen()).duration)} de atendimento`),
    strip,
    state.day ? h('p', { class: 'b-hint', style: { margin: '0.4rem 0 0' } }, cap(longDate(state.day))) : null,
    content);
}

// ---------- Passo 4: seus dados ----------

function recap() {
  const services = chosen();
  const who = BARBERS_BY_ID.get(state.assigned) || barber();
  return h('div', { class: 'b-recap' },
    h('div', { class: 'b-recap__row' }, ic('calendar-check'), h('span', {}, h('b', {}, cap(longDate(state.day))), ` às ${state.time}`)),
    who ? h('div', { class: 'b-recap__row' }, avatar(who, 'sm'), h('span', {}, 'com ', h('b', {}, who.name))) : null,
    h('div', { class: 'b-recap__row' }, ic('scissors'), h('span', {}, services.map(s => s.name).join(' + '))),
    h('div', { class: 'b-recap__row' }, ic('hourglass'), h('span', {}, `${formatDuration(summarize(services).duration)} de atendimento`)),
    h('div', { class: 'b-recap__total' }, h('span', {}, summarize(services).priceFrom ? 'Total (a partir de)' : 'Total'), h('strong', {}, formatBRL(finalPrice()))));
}

function renderDetails() {
  const saved = pref(CUSTOMER_KEY) || {};
  const name = h('input', { class: 'input', id: 'b-name', name: 'name', autocomplete: 'name', maxlength: 80, required: true, value: state.name ?? saved.name ?? '' });
  const phone = h('input', { class: 'input', id: 'b-phone', name: 'tel', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', placeholder: '(47) 99999-9999', required: true, value: maskPhone(state.phone ?? saved.phone ?? '') });
  const notes = h('textarea', { class: 'input', id: 'b-notes', maxlength: 300, placeholder: 'Ex.: degradê baixo, primeira vez na barbearia…' }, state.notes || '');
  name.addEventListener('input', () => { state.name = name.value; name.removeAttribute('aria-invalid'); });
  phone.addEventListener('input', () => {
    phone.value = maskPhone(phone.value);
    state.phone = phone.value;
    phone.removeAttribute('aria-invalid');
  });
  notes.addEventListener('input', () => { state.notes = notes.value; });
  state.name = name.value;
  state.phone = phone.value;
  state.notes = notes.value;
  const form = h('form', { class: 'b-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('label', { class: 'field' }, h('span', {}, 'Seu nome'), name),
    h('label', { class: 'field' }, h('span', {}, 'WhatsApp'), phone, h('small', {}, 'Para a barbearia falar com você sobre este horário, se precisar.')),
    h('label', { class: 'field' }, h('span', {}, 'Observações (opcional)'), notes),
    state.error ? h('p', { class: 'field__error', role: 'alert' }, state.error) : null,
    h('p', { class: 'b-privacy' }, ic('info'), 'Seus dados ficam só com a barbearia e servem apenas para este agendamento.'),
    h('button', { type: 'submit', hidden: true }));
  return h('div', {}, recap(), form);
}

async function postBooking(body) {
  const res = await fetch('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function submit() {
  if (state.sending) return;
  const name = state.name.trim();
  const phone = state.phone.replace(/\D/g, '');
  const nameInput = $('b-name');
  const phoneInput = $('b-phone');
  if (name.length < 2) {
    nameInput?.setAttribute('aria-invalid', 'true');
    nameInput?.focus();
    return toast('Informe seu nome', 'error');
  }
  if (phone.length < 10) {
    phoneInput?.setAttribute('aria-invalid', 'true');
    phoneInput?.focus();
    return toast('Informe seu WhatsApp com DDD', 'error');
  }
  setPref(CUSTOMER_KEY, { name, phone });
  state.clientRef ||= newClientRef();
  const body = {
    customer: { name, phone },
    services: serviceIds(),
    barberId: state.assigned || state.barberId,
    day: state.day,
    time: state.time,
    notes: state.notes,
    clientRef: state.clientRef,
  };
  state.sending = true;
  state.error = '';
  renderFoot();
  let result;
  try {
    try {
      result = await postBooking(body);
    } catch {
      // rede instável: tenta mais uma vez com o mesmo identificador (não duplica o horário)
      await new Promise(r => setTimeout(r, 1500));
      result = await postBooking(body);
    }
  } catch {
    result = { ok: false, status: 0, data: { error: 'Sem conexão. Confira a internet e tente de novo.' } };
  } finally {
    state.sending = false;
  }

  if (result.ok) return done(result.data);
  const message = result.data.error || 'Não foi possível agendar. Tente de novo.';
  if (result.status === 409 && result.data.details?.field === 'time') {
    toast(message, 'error');
    state.time = null;
    state.assigned = null;
    state.slots = null;
    state.clientRef = null;
    go(2);
    return;
  }
  state.error = message;
  render();
  toast(message, 'error');
}

// ---------- Concluído ----------

function done(data) {
  const b = data.booking;
  state.result = data;
  saveBooking({ token: data.token, code: data.code, day: b.day, time: b.time, barberName: b.barberName, services: b.services.map(s => s.name).join(' + ') });
  els.title.textContent = 'Horário marcado!';
  els.step.textContent = 'Tudo certo';
  els.progress.style.width = '100%';
  els.back.setAttribute('aria-label', 'Fechar');

  const link = `${location.origin}/agendamento/?t=${encodeURIComponent(data.token)}`;
  const services = b.services.map(s => s.name).join(' + ');
  const place = [SETTINGS.address, SETTINGS.city].filter(Boolean).join(', ');
  const wa = whatsappLink(SETTINGS.whatsappPhone,
    `Olá! Agendei pelo site: ${data.code}\n${services} com ${b.barberName}\n${shortDate(b.day)} às ${b.time}\nNome: ${state.name.trim()}\n${link}`);
  const ics = () => downloadFile(`hanoff-${b.day}-${b.time.replace(':', 'h')}.ics`, buildIcs({
    uid: data.token, title: `${services} • ${SETTINGS.storeName || 'Barbearia Hanoff'}`, day: b.day, time: b.time, duration: b.duration,
    location: place, description: `Agendamento ${data.code} com ${b.barberName}.\nPara ver ou cancelar: ${link}`,
  }), 'text/calendar;charset=utf-8');

  els.body.replaceChildren(h('div', { class: 'b-done' },
    h('div', { class: 'b-done__seal' }, ic('check')),
    h('h3', {}, `Até lá, ${b.firstName}!`),
    h('p', { class: 'b-done__code' }, 'Agendamento ', h('b', {}, data.code), b.status === 'agendado' ? ' · a barbearia confirma em breve' : ''),
    h('div', { class: 'b-recap' },
      h('div', { class: 'b-recap__row' }, ic('calendar-check'), h('span', {}, h('b', {}, cap(longDate(b.day))), ` às ${b.time}`)),
      h('div', { class: 'b-recap__row' }, ic('user-round'), h('span', {}, 'com ', h('b', {}, b.barberName))),
      h('div', { class: 'b-recap__row' }, ic('scissors'), h('span', {}, services)),
      h('div', { class: 'b-recap__total' }, h('span', {}, b.priceFrom ? 'Total (a partir de)' : 'Total'), h('strong', {}, formatBRL(b.price)))),
    h('div', { class: 'b-done__actions' },
      h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: ics }, ic('calendar-plus'), 'Adicionar à agenda do celular'),
      wa ? h('a', { class: 'btn btn--ghost btn--block', href: wa, target: '_blank', rel: 'noopener' }, ic('whatsapp'), 'Avisar a barbearia no WhatsApp') : null,
      h('a', { class: 'btn btn--ghost btn--block', href: `/agendamento/?t=${encodeURIComponent(data.token)}` }, ic('external-link'), 'Ver ou cancelar o agendamento')),
    h('p', { class: 'b-done__note' }, `Precisa desmarcar? Cancele pelo link até ${b.cancelHours}h antes do horário.`)));
  els.foot.hidden = true;
  document.dispatchEvent(new CustomEvent('booking:done'));
}
