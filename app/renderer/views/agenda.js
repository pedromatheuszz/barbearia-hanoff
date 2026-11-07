// Agenda do dia: uma coluna por barbeiro com os agendamentos no horário, bloqueios (almoço,
// folga) e as horas fora da jornada. Ao lado, o que chegou pelo site e aguarda confirmação.
// Atualizada a cada 8 s pelo app.js. Clique num espaço vazio para agendar naquele horário.
import {
  h, icon, btn, money, toast, modal, field, input, select, textarea, confirmDialog, kpi, emptyState, skeleton, card,
  STATUS, PAYMENT, PAYMENT_ICON, statusPill, dayShort, dayLong, duration, toMin, toHHMM, todayISO, shiftDays, phone, waLink,
  dateTime, barberAvatar, parseMoney, moneyInput,
} from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { state, can, refreshBoard, setAgendaDay, loadCatalog } from '../app.js';

const PX_PER_MIN = 1.8;
const STEP = 15; // ao clicar num espaço vazio, arredonda para 15 em 15 minutos
const HIDDEN = ['cancelado', 'faltou'];

const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const nowMinutes = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  return toMin(p);
};
const servicesText = (a) => a.services.map(s => s.name).join(' + ');
const firstName = (name) => String(name).split(' ')[0];

// Período com intervalo opcional → trechos [{ start, end }]
function periodWindows(p, startKey, endKey) {
  const start = toMin(p[startKey]);
  const end = toMin(p[endKey]);
  if (!p.breakStart || !p.breakEnd) return [{ start, end }];
  return [{ start, end: toMin(p.breakStart) }, { start: toMin(p.breakEnd), end }].filter(w => w.end > w.start);
}

/** Horário da barbearia (sem o almoço) cruzado com a jornada do barbeiro (mesma regra da API) */
function workWindows(barber, hours, weekday) {
  const shop = hours?.[weekday];
  if (!shop) return [];
  const shopWindows = periodWindows(shop, 'open', 'close');
  if (!barber.schedule) return shopWindows;
  const own = barber.schedule[weekday];
  if (!own) return [];
  const out = [];
  for (const a of shopWindows) {
    for (const b of periodWindows(own, 'start', 'end')) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

// ---------- Ações ----------

const busy = new Set();

async function setStatus(a, to, extra = {}) {
  if (busy.has(a.id)) return;
  busy.add(a.id);
  try {
    await patch(`/api/admin/appointments/${a.id}`, { status: to, ...extra });
    toast(`${a.code} · ${a.customerName}: ${STATUS[to].long}`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    busy.delete(a.id);
    await refreshBoard();
  }
}

/** Mensagem de confirmação pronta no WhatsApp do cliente */
function sendConfirmation(a) {
  const s = state.store?.settings || {};
  const link = state.config?.serverUrl ? `${state.config.serverUrl}${a.link}` : '';
  const text = [
    `Olá, ${firstName(a.customerName)}! Seu horário na ${s.storeName || 'Barbearia Hanoff'} está confirmado:`,
    `${dayLong(a.day)} às ${a.start} com ${a.barberName} (${servicesText(a)}).`,
    s.address ? `Endereço: ${[s.address, s.city].filter(Boolean).join(', ')}.` : '',
    link ? `Para ver ou cancelar: ${link}` : '',
    'Até lá!',
  ].filter(Boolean).join('\n');
  window.gestao.openExternal(waLink(a.customerPhone, text));
}

function cancelModal(a, after) {
  const reason = textarea('', { placeholder: 'Ex.: Cliente pediu, barbeiro doente, horário errado…', maxlength: 200 });
  modal({
    title: `Cancelar ${a.code}`,
    icon: 'xCircle',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, `${a.customerName} • ${dayShort(a.day)} às ${a.start} com ${a.barberName}. O horário fica livre na agenda e no site. Avise o cliente pelo WhatsApp.`),
      field('Motivo do cancelamento', reason)),
    actions: [
      { label: 'Voltar' },
      {
        label: 'Cancelar agendamento', kind: 'danger', icon: 'xCircle',
        onClick: async () => {
          if (reason.value.trim().length < 3) throw new Error('Informe o motivo');
          await patch(`/api/admin/appointments/${a.id}`, { status: 'cancelado', cancelReason: reason.value.trim() });
          toast(`${a.code} cancelado`);
          await refreshBoard();
          after?.();
        },
      },
    ],
  });
}

function concludeModal(a, after) {
  let method = a.paymentMethod || 'pix';
  const amount = input({ value: moneyInput(a.paidAmount ?? a.price), money: true, inputmode: 'decimal' });
  const methods = h('div', { class: 'chips', style: { flexWrap: 'wrap' } });
  const drawMethods = () => methods.replaceChildren(...Object.entries(PAYMENT).map(([id, label]) =>
    h('button', { type: 'button', class: `chip ${method === id ? 'is-active' : ''}`, onclick: () => { method = id; drawMethods(); } }, icon(PAYMENT_ICON[id]), label)));
  drawMethods();
  const editing = a.status === 'concluido';
  modal({
    title: editing ? `Pagamento de ${a.code}` : `Concluir ${a.code}`,
    icon: 'checkCircle',
    body: h('div', { class: 'stack' },
      h('div', { class: 'summary-box' }, icon('scissors'), h('span', {}, `${servicesText(a)} com ${a.barberName}`), h('div', { class: 'spacer' }), h('strong', {}, money(a.price))),
      field('Forma de pagamento', methods),
      field('Valor recebido (R$)', amount, 'Some produtos vendidos ou desconte o que foi abatido, se houver')),
    actions: [{ label: 'Voltar' }, {
      label: editing ? 'Salvar pagamento' : 'Concluir atendimento', kind: 'primary', icon: 'check', submit: true,
      onClick: async () => {
        const paidAmount = parseMoney(amount.value);
        if (!(paidAmount >= 0)) throw new Error('Valor inválido');
        await patch(`/api/admin/appointments/${a.id}`, editing ? { paymentMethod: method, paidAmount } : { status: 'concluido', paymentMethod: method, paidAmount });
        toast(editing ? 'Pagamento corrigido' : `${a.code} concluído • ${money(paidAmount)} no ${PAYMENT[method]}`);
        await refreshBoard();
        after?.();
      },
    }],
  });
  setTimeout(() => amount.select(), 40);
}

/** Lista de horários livres que preenche o campo de horário ao clicar */
function slotPicker(timeInput, fetchSlots) {
  const box = h('div', { class: 'slot-grid' });
  const mark = () => box.querySelectorAll('.slot-btn').forEach(b => b.classList.toggle('is-active', b.textContent === timeInput.value));
  timeInput.addEventListener('input', mark);
  async function load() {
    box.replaceChildren(h('span', { class: 'faint' }, 'Carregando…'));
    try {
      const slots = await fetchSlots();
      if (slots === null) return box.replaceChildren(h('span', { class: 'faint' }, 'Escolha os serviços para ver os horários livres.'));
      box.replaceChildren(...(slots.length ? slots.map(s => h('button', {
        type: 'button', class: 'slot-btn', onclick: () => { timeInput.value = s.time; mark(); },
      }, s.time)) : [h('span', { class: 'faint' }, 'Nenhum horário livre na jornada deste dia. Você ainda pode digitar um horário (encaixe).')]));
      mark();
    } catch (error) {
      box.replaceChildren(h('span', { class: 'faint' }, error.message));
    }
  }
  return { el: box, load };
}

async function rescheduleModal(a, after) {
  let catalog;
  try { catalog = await loadCatalog(); } catch (e) { return toast(e.message, 'error'); }
  const dayIn = input({ type: 'date', value: a.day, min: todayISO() });
  const barberSel = select(catalog.barbers.filter(b => b.active).map(b => [b.id, b.name]), a.barberId);
  const timeIn = input({ type: 'time', value: a.start, step: 300 });
  const ids = a.services.map(s => s.id).join(',');
  const picker = slotPicker(timeIn, async () => (await get(`/api/admin/availability?${new URLSearchParams({ day: dayIn.value, services: ids, barber: barberSel.value })}`)).slots);
  dayIn.addEventListener('change', picker.load);
  barberSel.addEventListener('change', picker.load);
  modal({
    title: `Remarcar ${a.code}`,
    icon: 'calendarSync',
    body: h('div', { class: 'form-grid' },
      h('p', { class: 'muted span-2', style: { margin: 0 } }, `${a.customerName} • ${servicesText(a)} (${duration(a.duration)}). Hoje: ${dayShort(a.day)} às ${a.start} com ${a.barberName}.`),
      field('Novo dia', dayIn), field('Barbeiro', barberSel),
      field('Horário', timeIn, 'Escolha abaixo ou digite (encaixe)'),
      h('div', { class: 'span-2' }, field('Horários livres', picker.el))),
    actions: [{ label: 'Voltar' }, {
      label: 'Remarcar', kind: 'primary', icon: 'calendarSync', submit: true,
      onClick: async () => {
        if (!timeIn.value) throw new Error('Escolha o horário');
        await post(`/api/admin/appointments/${a.id}/reschedule`, { day: dayIn.value, time: timeIn.value, barberId: barberSel.value });
        toast(`${a.code} remarcado para ${dayShort(dayIn.value)} às ${timeIn.value}`);
        await refreshBoard();
        after?.();
      },
    }],
  });
  picker.load();
}

function notesModal(a, after) {
  const notes = textarea(a.notes || '', { maxlength: 300 });
  modal({
    title: `Observações de ${a.code}`,
    icon: 'notes',
    body: field('Observações (só a equipe vê)', notes),
    actions: [{ label: 'Voltar' }, {
      label: 'Salvar', kind: 'primary', icon: 'check', submit: true,
      onClick: async () => { await patch(`/api/admin/appointments/${a.id}`, { notes: notes.value }); toast('Observação salva'); await refreshBoard(); after?.(); },
    }],
  });
}

// Próximo passo principal de cada status
function primaryAction(a) {
  switch (a.status) {
    case 'agendado': return { label: 'Confirmar', icon: 'check', run: () => setStatus(a, 'confirmado') };
    case 'confirmado': return { label: 'Iniciar atendimento', icon: 'scissors', run: () => setStatus(a, 'em_atendimento') };
    case 'em_atendimento': return { label: 'Concluir', icon: 'checkCircle', run: () => concludeModal(a), keepOpen: true };
    default: return null;
  }
}

/** Janela com todos os dados do agendamento e o histórico de quem mudou cada status */
export async function openAppointment(id) {
  let a;
  try {
    ({ appointment: a } = await get(`/api/admin/appointments/${id}`));
  } catch (error) {
    return toast(error.message, 'error');
  }
  const open = ['agendado', 'confirmado', 'em_atendimento'].includes(a.status);
  const next = can('agenda.status') ? primaryAction(a) : null;
  const reopen = () => openAppointment(id);
  let dialog;
  const quick = (label, name, run, kind = '') => btn(label, { icon: name, size: 'sm', kind, onclick: () => { dialog.close(); run(); } });

  const quickActions = [
    open && a.customerPhone ? quick('Confirmar no WhatsApp', 'whatsapp', () => sendConfirmation(a)) : null,
    ['agendado', 'confirmado'].includes(a.status) && can('agenda.book') ? quick('Remarcar', 'calendarSync', () => rescheduleModal(a, reopen)) : null,
    a.status === 'confirmado' && can('agenda.status') ? quick('Concluir', 'checkCircle', () => concludeModal(a)) : null,
    ['agendado', 'confirmado'].includes(a.status) && can('agenda.status') ? quick('Não compareceu', 'userX', async () => {
      if (await confirmDialog(`Marcar ${a.customerName} como "não compareceu"? O horário fica livre na agenda.`, { title: 'Não compareceu', confirmLabel: 'Marcar falta', danger: true })) setStatus(a, 'faltou');
    }) : null,
    a.status === 'concluido' && can('cash.operate') ? quick('Corrigir pagamento', 'wallet', () => concludeModal(a, reopen)) : null,
    can('agenda.book') ? quick('Observações', 'notes', () => notesModal(a, reopen)) : null,
  ].filter(Boolean);

  dialog = modal({
    title: `${a.code} · ${a.customerName}`,
    icon: 'calendar',
    wide: true,
    body: h('div', { class: 'detail' },
      h('div', {},
        h('section', {}, h('div', { class: 'row' }, statusPill(a.status, { long: true }),
          h('span', { class: 'pill' }, icon(a.source === 'site' ? 'globe' : 'store'), a.source === 'site' ? 'Pelo site' : `Pelo app (${a.createdBy})`))),
        a.cancelReason ? h('section', {}, h('div', { class: 'banner banner--danger', style: { margin: 0 } }, icon('alert'), `Motivo do cancelamento: ${a.cancelReason}`)) : null,
        h('section', {}, h('h3', {}, 'Horário'), h('div', { class: 'contact' },
          h('strong', {}, `${dayLong(a.day)}`),
          h('div', {}, icon('clock'), h('span', {}, `${a.start} às ${a.end} (${duration(a.duration)})`)),
          h('div', {}, icon('scissors'), h('span', {}, 'com ', h('b', {}, a.barberName))))),
        h('section', {}, h('h3', {}, 'Serviços'), h('div', { class: 'lines num' },
          a.services.map(s => h('div', {}, h('span', {}, s.name, h('span', { class: 'faint' }, ` · ${duration(s.duration)}`)), h('span', {}, money(s.price)))),
          h('div', { class: 'total' }, h('span', {}, 'Total'), h('span', {}, money(a.price))),
          a.status === 'concluido' ? h('div', {}, h('span', { class: 'muted' }, `Recebido no ${PAYMENT[a.paymentMethod] || '—'}`), h('span', { class: 'pos' }, money(a.paidAmount))) : null)),
        a.notes ? h('section', {}, h('h3', {}, 'Observações'), h('p', { class: 'selectable', style: { margin: 0, whiteSpace: 'pre-wrap' } }, a.notes)) : null,
        quickActions.length ? h('section', {}, h('h3', {}, 'Ações'), h('div', { class: 'row' }, quickActions)) : null),
      h('div', {},
        h('section', {}, h('h3', {}, 'Cliente'), h('div', { class: 'contact' },
          h('strong', { class: 'selectable' }, a.customerName),
          a.customerPhone
            ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.gestao.openExternal(waLink(a.customerPhone)); } }, icon('whatsapp'), `${phone(a.customerPhone)} · abrir WhatsApp`)
            : h('div', { class: 'faint' }, icon('phone'), 'Sem telefone'),
          a.customerPhone ? h('div', {}, icon('star'), h('span', {}, `${a.client.visits} atendimento${a.client.visits === 1 ? '' : 's'} concluído${a.client.visits === 1 ? '' : 's'}${a.client.noShows ? ` • ${a.client.noShows} falta${a.client.noShows === 1 ? '' : 's'}` : ''}`)) : null)),
        h('section', {}, h('h3', {}, 'Histórico'), h('ul', { class: 'timeline' }, a.history.map(ev =>
          h('li', {}, h('div', {}, h('strong', {}, STATUS[ev.status]?.long || ev.label), ev.note ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, ev.note) : null,
            h('small', {}, `${dateTime(ev.at)} • ${ev.by === 'cliente' ? 'pelo cliente' : ev.by}`)))))))),
    actions: [
      open && can('agenda.cancel') ? { label: 'Cancelar', kind: 'danger', icon: 'xCircle', left: true, onClick: (close) => { close(); cancelModal(a); } } : null,
      { label: 'Fechar' },
      next ? { label: next.label, kind: 'primary', icon: next.icon, onClick: () => { next.run(); } } : null,
    ].filter(Boolean),
  });
  return dialog;
}

// ---------- Novo agendamento, bloqueio ----------

/** Agendamento pela equipe (telefone, WhatsApp, encaixe). Com "na cadeira", já começa o atendimento. */
export async function openNewAppointment({ day = state.day, time = '', barberId = '' } = {}) {
  let catalog;
  try { catalog = await loadCatalog(); } catch (e) { return toast(e.message, 'error'); }
  const barbers = catalog.barbers.filter(b => b.active);
  const services = catalog.services.filter(s => s.active);
  const name = input({ maxlength: 80, placeholder: 'Nome do cliente', autocomplete: 'off' });
  const phoneIn = input({ type: 'tel', maxlength: 16, placeholder: '(47) 99999-9999 — opcional' });
  const svcBox = h('div', { class: 'svc-pick' }, services.map(s => h('label', {}, h('input', { type: 'checkbox', value: s.id }), h('span', {}, s.name), h('small', { dataset: { price: s.id } }, `${duration(s.duration)} · ${money(s.price)}`))));
  const barberSel = select(barbers.map(b => [b.id, b.name]), barberId || barbers[0]?.id);
  const dayIn = input({ type: 'date', value: day });
  const timeIn = input({ type: 'time', value: time, step: 300 });
  const notes = textarea('', { maxlength: 300, placeholder: 'Opcional' });
  const inChair = h('input', { type: 'checkbox' });
  const summary = h('div', { class: 'summary-box' });
  const chosen = () => [...svcBox.querySelectorAll('input:checked')].map(i => i.value);
  const picker = slotPicker(timeIn, async () => {
    if (!chosen().length) return null;
    return (await get(`/api/admin/availability?${new URLSearchParams({ day: dayIn.value, services: chosen().join(','), barber: barberSel.value })}`)).slots;
  });

  function update() {
    const barber = barbers.find(b => b.id === barberSel.value);
    const list = services.filter(s => chosen().includes(s.id));
    const priceOf = (s) => (Number.isFinite(barber?.prices?.[s.id]) ? barber.prices[s.id] : s.price);
    svcBox.querySelectorAll('small[data-price]').forEach(el => {
      const s = services.find(x => x.id === el.dataset.price);
      el.textContent = `${duration(s.duration)} · ${money(priceOf(s))}`;
    });
    const total = list.reduce((t, s) => t + priceOf(s), 0);
    const mins = list.reduce((t, s) => t + s.duration, 0);
    summary.replaceChildren(icon('hourglass'), h('span', {}, list.length ? `${duration(mins)}${timeIn.value ? ` • ${timeIn.value} às ${toHHMM(Math.min(1440, toMin(timeIn.value) + mins))}` : ''}` : 'Escolha os serviços'),
      h('div', { class: 'spacer' }), h('strong', {}, money(total)));
  }
  svcBox.addEventListener('change', () => { update(); picker.load(); });
  barberSel.addEventListener('change', () => { update(); picker.load(); });
  dayIn.addEventListener('change', picker.load);
  timeIn.addEventListener('input', update);
  inChair.addEventListener('change', () => {
    if (!inChair.checked) return;
    dayIn.value = todayISO();
    timeIn.value = toHHMM(Math.floor(nowMinutes() / 5) * 5);
    update();
    picker.load();
  });
  // cliente que já veio antes: o nome aparece sozinho pelo telefone
  phoneIn.addEventListener('change', async () => {
    const digits = phoneIn.value.replace(/\D/g, '');
    if (digits.length < 10 || name.value.trim() || !can('clients.view')) return;
    try {
      const { clients } = await get(`/api/admin/clients?q=${digits}`);
      if (clients[0] && !name.value.trim()) name.value = clients[0].name;
    } catch { /* sem permissão ou sem conexão: digita o nome */ }
  });

  modal({
    title: 'Novo agendamento',
    icon: 'calendarPlus',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Cliente', name), field('Telefone / WhatsApp', phoneIn),
      h('div', { class: 'span-2' }, field('Serviços', svcBox)),
      field('Barbeiro', barberSel), field('Dia', dayIn),
      field('Horário', timeIn, 'Escolha um horário livre ou digite (encaixe)'),
      h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '0.6rem' } }, inChair, 'Cliente já está na cadeira'),
      h('div', { class: 'span-2' }, field('Horários livres', picker.el)),
      h('div', { class: 'span-2' }, field('Observações', notes)),
      h('div', { class: 'span-2' }, summary)),
    actions: [
      can('agenda.block') ? { label: 'Bloquear horário', icon: 'ban', left: true, onClick: (close) => { close(); openBlock({ day: dayIn.value, barberId: barberSel.value, start: timeIn.value }); } } : null,
      { label: 'Cancelar' },
      {
        label: 'Agendar', kind: 'primary', icon: 'check', submit: true,
        onClick: async () => {
          if (!chosen().length) throw new Error('Escolha pelo menos um serviço');
          if (!timeIn.value) throw new Error('Escolha o horário');
          const { appointment } = await post('/api/admin/appointments', {
            customer: { name: name.value, phone: phoneIn.value }, services: chosen(), barberId: barberSel.value,
            day: dayIn.value, time: timeIn.value, notes: notes.value, status: inChair.checked ? 'em_atendimento' : 'confirmado',
          });
          toast(`${appointment.code} agendado: ${appointment.customerName}, ${dayShort(appointment.day)} às ${appointment.start} com ${appointment.barberName}`);
          if (appointment.day !== state.day) await setAgendaDay(appointment.day);
          else await refreshBoard();
        },
      },
    ].filter(Boolean),
  });
  update();
  picker.load();
  setTimeout(() => name.focus(), 40);
}

const REASONS = ['Almoço', 'Folga', 'Férias', 'Curso', 'Médico', 'Compromisso', 'Feriado'];

export async function openBlock({ day = state.day, barberId = '', start = '', end = '' } = {}) {
  let catalog;
  try { catalog = await loadCatalog(); } catch (e) { return toast(e.message, 'error'); }
  const barberSel = select([['', 'Toda a barbearia'], ...catalog.barbers.filter(b => b.active).map(b => [b.id, b.name])], barberId);
  const from = input({ type: 'date', value: day });
  const until = input({ type: 'date', value: day });
  const allDay = h('input', { type: 'checkbox' });
  const startIn = input({ type: 'time', value: start || '12:00', step: 300 });
  const endIn = input({ type: 'time', value: end || (start ? toHHMM(Math.min(1435, toMin(start) + 60)) : '13:00'), step: 300 });
  const reason = input({ maxlength: 80, list: 'block-reasons', placeholder: 'Ex.: Almoço, folga, férias, curso' });
  allDay.addEventListener('change', () => { startIn.disabled = endIn.disabled = allDay.checked; });
  from.addEventListener('change', () => { if (until.value < from.value) until.value = from.value; });
  modal({
    title: 'Bloquear horário',
    icon: 'ban',
    body: h('div', { class: 'form-grid' },
      h('p', { class: 'muted span-2', style: { margin: 0 } }, 'O site não oferece horários bloqueados. Agendamentos que já existem continuam valendo.'),
      h('div', { class: 'span-2' }, field('Barbeiro', barberSel)),
      field('De', from), field('Até', until, 'Para férias, escolha o último dia'),
      field('Início', startIn), field('Fim', endIn),
      h('label', { class: 'check span-2' }, allDay, 'Dia inteiro'),
      h('div', { class: 'span-2' }, field('Motivo', reason)),
      h('datalist', { id: 'block-reasons' }, REASONS.map(r => h('option', { value: r })))),
    actions: [{ label: 'Cancelar' }, {
      label: 'Bloquear', kind: 'primary', icon: 'ban', submit: true,
      onClick: async () => {
        await post('/api/admin/blocks', {
          barberId: barberSel.value || null, day: from.value, untilDay: until.value || from.value,
          allDay: allDay.checked, start: startIn.value, end: endIn.value, reason: reason.value,
        });
        toast('Horário bloqueado');
        await refreshBoard();
      },
    }],
  });
}

function openBlockDetail(b) {
  modal({
    title: b.reason || 'Horário bloqueado',
    icon: 'ban',
    body: h('div', { class: 'lines' },
      h('div', {}, h('span', { class: 'muted' }, 'Quem'), h('span', {}, b.barberName || 'Toda a barbearia')),
      h('div', {}, h('span', { class: 'muted' }, 'Período'), h('span', {}, b.day === b.untilDay ? dayShort(b.day) : `${dayShort(b.day)} até ${dayShort(b.untilDay)}`)),
      h('div', {}, h('span', { class: 'muted' }, 'Horário'), h('span', {}, b.startMin === 0 && b.endMin === 1440 ? 'Dia inteiro' : `${b.start} às ${b.end}`)),
      h('div', {}, h('span', { class: 'muted' }, 'Bloqueado por'), h('span', {}, b.by))),
    actions: [
      can('agenda.block') ? {
        label: 'Remover bloqueio', kind: 'danger', icon: 'trash', left: true,
        onClick: async () => { await del(`/api/admin/blocks/${b.id}`); toast('Bloqueio removido'); await refreshBoard(); },
      } : null,
      { label: 'Fechar', kind: 'primary' },
    ].filter(Boolean),
  });
}

// ---------- Tela ----------

export default {
  id: 'agenda',
  label: 'Agenda',
  title: 'Agenda',
  subtitle: 'Agendamentos do dia por barbeiro. Clique num horário vazio para agendar.',
  icon: 'calendar',
  group: 'Operação',
  permission: 'agenda.view',
  render(container, { actions }) {
    let filter = 'all';
    let showHidden = false;
    let signature = '';
    let scrolled = false;
    const freshIds = new Set();

    const dayInput = input({ type: 'date', value: state.day, class: 'input day-input' });
    const dayLabel = h('span', { class: 'day-nav__label' });
    const changeDay = (day) => {
      if (!day) return;
      dayInput.value = day;
      scrolled = false;
      signature = '';
      body.replaceChildren(loading());
      setAgendaDay(day);
    };
    dayInput.addEventListener('change', () => changeDay(dayInput.value));
    const chips = h('div', { class: 'chips', style: { flexWrap: 'wrap' } });
    const kpis = h('div', { class: 'kpis' });
    const body = h('div');
    container.append(
      h('div', { class: 'toolbar' },
        h('div', { class: 'day-nav' },
          btn('', { icon: 'chevronLeft', size: 'sm', title: 'Dia anterior', onclick: () => changeDay(shiftDays(state.day, -1)) }),
          dayLabel,
          btn('', { icon: 'chevronRight', size: 'sm', title: 'Próximo dia', onclick: () => changeDay(shiftDays(state.day, 1)) })),
        btn('Hoje', { size: 'sm', onclick: () => changeDay(todayISO()) }),
        dayInput,
        h('div', { class: 'spacer' }),
        chips),
      kpis, body);

    if (can('agenda.block')) actions.append(btn('Bloquear', { icon: 'ban', size: 'sm', onclick: () => openBlock({}) }));
    actions.append(btn('', { icon: 'refresh', size: 'sm', title: 'Atualizar (F5)', onclick: () => refreshBoard() }));
    if (can('agenda.book')) actions.append(btn('Agendar', { icon: 'calendarPlus', kind: 'primary', size: 'sm', title: 'Novo agendamento (Ctrl+N)', onclick: () => openNewAppointment({}) }));

    const loading = () => h('div', { class: 'agenda' }, h('div', { class: 'card' }, skeleton(8, 48)), h('div', { class: 'card' }, skeleton(4, 64)));

    function drawChips(barbers) {
      chips.replaceChildren(
        ...[['all', 'Todos']].map(([id, label]) => h('button', { class: `chip ${filter === id ? 'is-active' : ''}`, onclick: () => { filter = id; draw(true); } }, icon('users'), label)),
        ...barbers.map(b => h('button', { class: `chip ${filter === b.id ? 'is-active' : ''}`, onclick: () => { filter = b.id; draw(true); } }, barberAvatar(b, 20), b.name)),
        h('button', { class: `chip ${showHidden ? 'is-active' : ''}`, title: 'Mostrar cancelados e faltas na grade', onclick: () => { showHidden = !showHidden; draw(true); } }, icon('ban'), 'Cancelados'));
    }

    function drawKpis(list) {
      const valid = list.filter(a => !HIDDEN.includes(a.status));
      const done = list.filter(a => a.status === 'concluido');
      const revenue = done.reduce((t, a) => t + (a.paidAmount || 0), 0);
      const minutes = valid.reduce((t, a) => t + a.duration, 0);
      const noShows = list.filter(a => a.status === 'faltou').length;
      kpis.replaceChildren(
        kpi({ label: 'Atendimentos', value: String(valid.length), hint: `${duration(minutes)} de cadeira ocupada`, icon: 'calendar' }),
        kpi({ label: 'A confirmar', value: String(list.filter(a => a.status === 'agendado').length), hint: 'chegaram pelo site', icon: 'hourglass', tone: 'warn' }),
        kpi({ label: 'Na cadeira', value: String(list.filter(a => a.status === 'em_atendimento').length), hint: 'em atendimento agora', icon: 'scissors' }),
        kpi({ label: 'Faturado', value: money(revenue), hint: `${done.length} concluído${done.length === 1 ? '' : 's'}${noShows ? ` • ${noShows} falta${noShows === 1 ? '' : 's'}` : ''}`, icon: 'trend', tone: 'accent' }));
    }

    function apptBox(a, start, color) {
      const top = (a.startMin - start) * PX_PER_MIN;
      const height = Math.max(22, a.duration * PX_PER_MIN - 3);
      const short = height < 30;      // uma linha: horário e nome
      const compact = height < 62;    // duas linhas: sem os serviços
      return h('div', {
        class: `appt appt--${a.status} ${short ? 'is-short' : compact ? 'is-compact' : ''} ${freshIds.has(a.id) ? 'is-fresh' : ''}`,
        style: { top: `${top + 1}px`, height: `${height}px`, '--c': color },
        tabindex: 0, title: `${a.start}–${a.end} • ${a.customerName} • ${servicesText(a)} • ${STATUS[a.status].long}`,
        onclick: (e) => { e.stopPropagation(); openAppointment(a.id); },
        onkeydown: (e) => { if (e.key === 'Enter') openAppointment(a.id); },
      },
      h('span', { class: 'appt__time' }, icon(STATUS[a.status].icon), short ? a.start : `${a.start}–${a.end}`),
      h('span', { class: 'appt__name' }, a.customerName),
      h('span', { class: 'appt__svc' }, servicesText(a)));
    }

    function draw(force = false) {
      const board = state.board;
      const catalog = state.catalog;
      if (!board || board.day !== state.day || !catalog) {
        if (!body.childElementCount) body.append(loading());
        return;
      }
      const sig = JSON.stringify([board, filter, showHidden, catalog.barbers]);
      dayLabel.textContent = `${dayLong(state.day)}${state.day === todayISO() ? ' (hoje)' : ''}`;
      dayInput.value = state.day;
      if (!force && sig === signature) return updateNow();
      signature = sig;

      const day = state.day;
      const weekday = weekdayOf(day);
      const hours = catalog.settings.hours;
      const list = board.appointments;
      const working = catalog.barbers.filter(b => b.active || list.some(a => a.barberId === b.id));
      drawChips(working);
      drawKpis(list);
      const barbers = filter === 'all' ? working : working.filter(b => b.id === filter);
      const visible = list.filter(a => showHidden || !HIDDEN.includes(a.status));

      // faixa de horas: do primeiro expediente/agendamento ao último, em horas cheias
      const windows = new Map(barbers.map(b => [b.id, workWindows(b, hours, weekday)]));
      const edges = [...windows.values()].flat();
      const partials = board.blocks.filter(b => !(b.startMin === 0 && b.endMin === 1440));
      const startMin = Math.min(...edges.map(w => w.start), ...visible.map(a => a.startMin), ...partials.map(b => b.startMin), edges.length || visible.length ? 1440 : 8 * 60);
      const endMin = Math.max(...edges.map(w => w.end), ...visible.map(a => a.endMin), ...partials.map(b => b.endMin), edges.length || visible.length ? 0 : 20 * 60);
      const start = Math.floor(startMin / 60) * 60;
      const end = Math.min(1440, Math.ceil(endMin / 60) * 60);
      const marks = [];
      for (let m = start; m < end; m += 60) marks.push(m);

      const cal = h('div', { class: 'cal', style: { '--cols': String(Math.max(1, barbers.length)), '--hour': `${60 * PX_PER_MIN}px` } });
      if (!barbers.length) {
        cal.append(emptyState('Nenhum barbeiro ativo', 'Cadastre ou ative barbeiros em Serviços › Barbeiros.', 'users'));
      } else {
        const head = h('div', { class: 'cal__head' }, h('div', { class: 'cal__corner' }, icon('clock', { size: 15 })),
          barbers.map(b => {
            const mine = list.filter(a => a.barberId === b.id && !HIDDEN.includes(a.status));
            const off = !windows.get(b.id).length;
            return h('div', { class: 'cal__barber' }, barberAvatar(b, 30),
              h('div', {}, h('strong', {}, b.name), h('small', {}, off ? (mine.length ? `Folga • ${mine.length} agendado(s)` : 'Folga neste dia') : `${mine.length} atendimento${mine.length === 1 ? '' : 's'}`)));
          }));
        const times = h('div', { class: 'cal__times' }, marks.map(m => h('span', { class: 'cal__time', style: { top: `${(m - start) * PX_PER_MIN}px` } }, toHHMM(m))));
        const cols = barbers.map(b => {
          const col = h('div', { class: 'cal__col', dataset: { barber: b.id } });
          // horas fora da jornada (hachurado)
          let cursor = start;
          for (const w of [...windows.get(b.id), { start: end, end }]) {
            if (w.start > cursor) col.append(h('div', { class: 'cal__off', style: { top: `${(cursor - start) * PX_PER_MIN}px`, height: `${(Math.min(w.start, end) - cursor) * PX_PER_MIN}px` } }));
            cursor = Math.max(cursor, w.end);
          }
          for (const bl of board.blocks.filter(x => x.barberId === null || x.barberId === b.id)) {
            const s = Math.max(bl.startMin, start);
            const e = Math.min(bl.endMin, end);
            if (e <= s) continue;
            col.append(h('div', {
              class: 'cal__block', style: { top: `${(s - start) * PX_PER_MIN}px`, height: `${(e - s) * PX_PER_MIN}px` },
              title: `${bl.reason || 'Bloqueado'} • ${bl.start}–${bl.end}`, onclick: (ev) => { ev.stopPropagation(); openBlockDetail(bl); },
            }, icon('ban'), bl.reason || 'Bloqueado'));
          }
          for (const a of visible.filter(x => x.barberId === b.id)) col.append(apptBox(a, start, b.color));
          if (can('agenda.book')) {
            const hint = h('div', { class: 'cal__hint', hidden: true });
            col.append(hint);
            const at = (e) => Math.min(end - STEP, start + Math.floor(e.offsetY / PX_PER_MIN / STEP) * STEP);
            col.addEventListener('mousemove', (e) => {
              if (e.target !== col) { hint.hidden = true; return; }
              const m = at(e);
              hint.hidden = false;
              hint.style.top = `${(m - start) * PX_PER_MIN}px`;
              hint.textContent = `+ ${toHHMM(m)} com ${b.name}`;
            });
            col.addEventListener('mouseleave', () => { hint.hidden = true; });
            col.addEventListener('click', (e) => { if (e.target === col) openNewAppointment({ day, time: toHHMM(at(e)), barberId: b.id }); });
          }
          return col;
        });
        const nowLine = h('div', { class: 'now-line', hidden: true });
        const grid = h('div', { class: 'cal__grid', style: { '--h': `${(end - start) * PX_PER_MIN}px` } }, times, cols, nowLine);
        const scroll = h('div', { class: 'cal__scroll' }, head, grid);
        cal.append(scroll);
        cal.dataset.start = String(start);
        cal.dataset.end = String(end);
      }

      // painel: aguardando confirmação + legenda
      const pending = board.pending;
      const side = h('div', { class: 'side' },
        card({ title: 'A confirmar', subtitle: pending.length ? `${pending.length} agendamento${pending.length === 1 ? '' : 's'} pelo site` : 'Nada pendente', icon: 'hourglass' },
          pending.length ? h('div', { class: 'pending' }, pending.map(a => h('div', { class: 'pending__item', onclick: () => openAppointment(a.id) },
            h('div', { class: 'pending__top' }, h('span', { class: 'pending__when' }, `${a.day === todayISO() ? 'Hoje' : dayShort(a.day)} · ${a.start}`), h('span', { class: 'faint', style: { marginLeft: 'auto', fontSize: '12px' } }, a.code)),
            h('div', { class: 'pending__who' }, a.customerName),
            h('div', { class: 'pending__what' }, `${servicesText(a)} · ${a.barberName}`),
            can('agenda.status') ? h('div', { class: 'pending__actions' },
              btn('Confirmar', { icon: 'check', kind: 'primary', size: 'sm', onclick: (e) => { e.stopPropagation(); setStatus(a, 'confirmado'); } }),
              a.customerPhone ? btn('', { icon: 'whatsapp', size: 'sm', title: 'Mandar a confirmação no WhatsApp', onclick: (e) => { e.stopPropagation(); sendConfirmation(a); } }) : null,
              a.day !== state.day ? btn('', { icon: 'calendar', size: 'sm', title: 'Abrir este dia na agenda', onclick: (e) => { e.stopPropagation(); changeDay(a.day); } }) : null) : null)))
            : emptyState('Tudo confirmado', 'Os agendamentos feitos pelo site aparecem aqui.', 'checkCircle')),
        card({ title: 'Legenda', icon: 'info' }, h('div', { class: 'legend-list' },
          h('span', {}, h('i', { class: 'warn' }), 'Agendado pelo site (a confirmar)'),
          h('span', {}, h('i'), 'Confirmado'),
          h('span', {}, h('i', { class: 'gold' }), 'Na cadeira'),
          h('span', {}, h('i', { class: 'block' }), 'Bloqueio ou fora da jornada'))));

      const previous = body.querySelector('.cal__scroll');
      const keep = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
      body.replaceChildren(h('div', { class: 'agenda' }, cal, side));
      const scroll = body.querySelector('.cal__scroll');
      if (scroll && keep && scrolled) {
        scroll.scrollTop = keep.top;
        scroll.scrollLeft = keep.left;
      }
      updateNow();
      if (scroll && !scrolled) {
        scrolled = true;
        // abre perto de agora (hoje) ou do primeiro atendimento
        const first = state.day === todayISO() ? nowMinutes() - 45 : (visible[0]?.startMin ?? start) - 30;
        scroll.scrollTop = Math.max(0, (first - start) * PX_PER_MIN);
      }
    }

    function updateNow() {
      const cal = body.querySelector('.cal');
      const line = body.querySelector('.now-line');
      if (!cal || !line) return;
      const now = nowMinutes();
      const start = Number(cal.dataset.start);
      const end = Number(cal.dataset.end);
      line.hidden = state.day !== todayISO() || now < start || now > end;
      line.style.top = `${(now - start) * PX_PER_MIN}px`;
    }

    state.listeners.add((board, fresh) => {
      fresh.forEach(a => freshIds.add(a.id));
      if (fresh.length) setTimeout(() => { fresh.forEach(a => freshIds.delete(a.id)); }, 4000);
      draw();
    });
    body.append(loading());
    loadCatalog().then(() => draw(true)).catch(err => body.replaceChildren(h('div', { class: 'card' }, emptyState('Não foi possível carregar', err.message, 'wifiOff'))));
    if (state.board?.day !== state.day) refreshBoard();
    this.timer = setInterval(() => { updateNow(); }, 30000);
  },
  destroy() {
    clearInterval(this.timer);
  },
};
