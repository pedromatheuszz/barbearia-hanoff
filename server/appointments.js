// Regras de negócio dos agendamentos. Preço, duração e horários livres são sempre calculados
// no servidor a partir do banco — o que o navegador envia não é confiável.
// Dois clientes nunca ficam com o mesmo horário: cada agendamento ocupa os blocos de 5 minutos
// da cadeira do barbeiro (tabela appointment_slots, com chave única) no mesmo comando que o grava.
import crypto from 'crypto';
import { HttpError } from './http.js';
import { cleanText } from './text.js';
import { getBookingCatalog } from './catalog.js';
import { computeSlots, doesAll, isRealDate, addDays, daysBetween, minutesUntil, toHHMM, GRANULE } from '../shared/schedule.js';
import { saoPauloParts, TIME_RE, toMin } from '../shared/store-hours.js';
import { summarize, pickServices, priceFor, MAX_SERVICES, PAYMENT_METHODS } from '../shared/services.js';

export const STATUSES = ['agendado', 'confirmado', 'em_atendimento', 'concluido', 'faltou', 'cancelado'];
// ocupam a cadeira (concluído também: o horário foi usado)
const OCCUPYING = ['agendado', 'confirmado', 'em_atendimento', 'concluido'];
export const OPEN_STATUSES = ['agendado', 'confirmado', 'em_atendimento'];

export const STATUS_LABELS = {
  agendado: 'Aguardando confirmação',
  confirmado: 'Confirmado',
  em_atendimento: 'Em atendimento',
  concluido: 'Concluído',
  faltou: 'Não compareceu',
  cancelado: 'Cancelado',
};

// Próximos status permitidos a partir de cada status
const TRANSITIONS = {
  agendado: ['confirmado', 'em_atendimento', 'concluido', 'faltou', 'cancelado'],
  confirmado: ['em_atendimento', 'concluido', 'faltou', 'cancelado'],
  em_atendimento: ['concluido', 'cancelado'],
  concluido: [],
  faltou: [],
  cancelado: [],
};

export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;

export const appointmentCode = (id) => `#${String(id).padStart(4, '0')}`;

const MAX_ACTIVE_PER_PHONE = 3;
const MAX_BOOKINGS_PER_IP_10_MIN = 6;
const NEXT_SLOTS_DAYS = 14;

const num = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const digits = (v) => String(v ?? '').replace(/\D/g, '');

// Identificador do agendamento gerado no navegador: reenviar o mesmo pedido (rede lenta,
// clique duplo) devolve o agendamento já criado em vez de criar outro
const CLIENT_REF_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const parseClientRef = (value) => (typeof value === 'string' && CLIENT_REF_RE.test(value) ? value : null);

// colunas lidas: o dia também como texto 'AAAA-MM-DD' (sem depender do fuso do driver)
const COLS = "*, to_char(day, 'YYYY-MM-DD') AS day_iso";

const isConflict = (error) => error?.code === '23505' || /appointment_slots/.test(String(error?.constraint || error?.message || ''));

// ---------- Representações ----------

/** Linha do banco → objeto da API da equipe */
export function toStaffAppointment(row) {
  return {
    id: Number(row.id),
    code: appointmentCode(row.id),
    link: `/agendamento/?t=${row.token}`,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    nextStatuses: TRANSITIONS[row.status] || [],
    source: row.source,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    barberId: row.barber_id,
    barberName: row.barber_name,
    services: row.services,
    day: dayOf(row),
    start: toHHMM(row.start_min),
    end: toHHMM(row.end_min),
    startMin: row.start_min,
    endMin: row.end_min,
    duration: row.end_min - row.start_min,
    price: num(row.price),
    notes: row.notes,
    paymentMethod: row.payment_method,
    paidAmount: row.paid_amount === null ? null : num(row.paid_amount),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    cancelReason: row.cancel_reason || null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const dayOf = (row) => row.day_iso || (typeof row.day === 'string' ? row.day.slice(0, 10) : new Date(row.day).toISOString().slice(0, 10));

/** O cliente ainda pode cancelar pelo link? (até `cancelHours` antes do horário) */
export function canClientCancel(row, settings, now = new Date()) {
  if (!['agendado', 'confirmado'].includes(row.status)) return false;
  return minutesUntil(dayOf(row), row.start_min, saoPauloParts(now)) >= settings.cancelHours * 60;
}

/** Visão pública do link enviado ao cliente (sem telefone nem anotações da equipe). */
export function toPublicBooking(row, settings, now = new Date()) {
  return {
    code: appointmentCode(row.id),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    firstName: String(row.customer_name).split(' ')[0],
    barberName: row.barber_name,
    services: row.services.map(({ name, price, duration }) => ({ name, price, duration })),
    day: dayOf(row),
    time: toHHMM(row.start_min),
    endTime: toHHMM(row.end_min),
    duration: row.end_min - row.start_min,
    price: num(row.price),
    priceFrom: row.services.some(s => s.priceFrom),
    canCancel: canClientCancel(row, settings, now),
    cancelHours: settings.cancelHours,
    store: {
      name: settings.storeName,
      whatsappPhone: settings.whatsappPhone,
      address: settings.address,
      city: settings.city,
      mapsUrl: settings.mapsUrl,
    },
  };
}

// ---------- Horários livres ----------

/** Agendamentos que ocupam a cadeira e bloqueios de um período, por dia. */
async function busyByDay(db, from, to) {
  const [appts, blocks] = await Promise.all([
    db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, barber_id, start_min, end_min FROM appointments
        WHERE day BETWEEN $1 AND $2 AND status = ANY($3::text[])`,
      [from, to, OCCUPYING]
    ),
    db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(until_day, 'YYYY-MM-DD') AS until_day, barber_id, start_min, end_min
         FROM time_blocks WHERE day <= $2 AND until_day >= $1`,
      [from, to]
    ),
  ]);
  const out = new Map();
  const get = (day) => {
    if (!out.has(day)) out.set(day, { busy: [], load: {} });
    return out.get(day);
  };
  for (const a of appts) {
    const d = get(a.day);
    d.busy.push({ barberId: a.barber_id, start: a.start_min, end: a.end_min });
    d.load[a.barber_id] = (d.load[a.barber_id] || 0) + 1;
  }
  for (const b of blocks) {
    for (let day = b.day < from ? from : b.day; day <= b.until_day && day <= to; day = addDays(day, 1)) {
      get(day).busy.push({ barberId: b.barber_id, start: b.start_min, end: b.end_min });
    }
  }
  return out;
}

function chooseServices(ids, servicesById) {
  const list = Array.isArray(ids) ? ids : String(ids || '').split(',');
  const wanted = [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
  if (!wanted.length) throw new HttpError(422, 'Escolha pelo menos um serviço');
  if (wanted.length > MAX_SERVICES) throw new HttpError(422, `Escolha no máximo ${MAX_SERVICES} serviços por horário`);
  const services = pickServices(wanted, servicesById);
  if (services.length !== wanted.length) throw new HttpError(422, 'Algum serviço escolhido não está mais disponível');
  return services;
}

/** Barbeiros que podem atender, na ordem de preferência do "sem preferência". */
function candidatesFor(catalog, services, barberId) {
  const ids = services.map(s => s.id);
  let list = catalog.barbers.filter(b => doesAll(b, ids));
  if (barberId && barberId !== 'any') {
    list = list.filter(b => b.id === barberId);
    if (!list.length) throw new HttpError(422, 'Esse barbeiro não faz algum dos serviços escolhidos ou não está atendendo');
  }
  return list;
}

function slotsForDay({ day, services, candidates, settings, info, now, staff }) {
  const nowSp = saoPauloParts(now);
  if (day < nowSp.day) return [];
  const duration = summarize(services).duration;
  const notBefore = day === nowSp.day ? nowSp.minutes + (staff ? 0 : settings.minNoticeMinutes) : 0;
  // "sem preferência": primeiro o menor preço, depois quem tem menos atendimentos no dia
  const ordered = [...candidates].sort((a, b) =>
    summarize(services, a).price - summarize(services, b).price
    || (info?.load[a.id] || 0) - (info?.load[b.id] || 0)
    || a.order - b.order);
  return computeSlots({ day, duration, barbers: ordered, hours: settings.hours, busy: info?.busy || [], interval: settings.slotInterval, notBefore })
    .map(s => ({ time: s.time, barbers: s.barbers }));
}

/**
 * Horários livres de um dia para os serviços escolhidos. barberId = 'any' (sem preferência)
 * ou o id do barbeiro. staff = true (app da equipe) ignora a antecedência mínima e o limite de dias.
 */
export async function getAvailability(db, { day, services: serviceIds, barberId = 'any', staff = false }, now = new Date()) {
  const catalog = await getBookingCatalog(db);
  const { settings } = catalog;
  if (!isRealDate(day)) throw new HttpError(422, 'Data inválida');
  const services = chooseServices(serviceIds, catalog.servicesById);
  const candidates = candidatesFor(catalog, services, barberId);
  const today = saoPauloParts(now).day;
  const prices = Object.fromEntries(candidates.map(b => [b.id, summarize(services, b).price]));
  const base = { day, duration: summarize(services).duration, prices };
  if (!staff && settings.paused) return { ...base, paused: true, slots: [] };
  if (!staff && (day < today || daysBetween(today, day) > settings.maxDaysAhead)) return { ...base, slots: [] };
  const info = (await busyByDay(db, day, day)).get(day);
  return { ...base, slots: slotsForDay({ day, services, candidates, settings, info, now, staff }) };
}

/** Próximos horários livres (a partir de hoje) — usado na vitrine do site. */
export async function findNextSlots(db, { services: serviceIds, barberId = 'any', limit = 6 }, now = new Date()) {
  const catalog = await getBookingCatalog(db);
  const { settings } = catalog;
  const services = chooseServices(serviceIds, catalog.servicesById);
  const candidates = candidatesFor(catalog, services, barberId);
  if (settings.paused) return { paused: true, slots: [] };
  const today = saoPauloParts(now).day;
  const last = addDays(today, Math.min(NEXT_SLOTS_DAYS, settings.maxDaysAhead));
  const busy = await busyByDay(db, today, last);
  const out = [];
  for (let day = today; day <= last && out.length < limit; day = addDays(day, 1)) {
    for (const slot of slotsForDay({ day, services, candidates, settings, info: busy.get(day), now, staff: false })) {
      out.push({ day, ...slot });
      if (out.length >= limit) break;
    }
  }
  return { slots: out };
}

// ---------- Gravação ----------

/**
 * Grava o agendamento e ocupa os blocos da cadeira no mesmo comando.
 * Retorna a linha, null (mesmo clientRef já gravado) ou 'conflict' (horário tomado).
 */
async function insertAppointment(db, a) {
  const token = crypto.randomBytes(18).toString('base64url');
  try {
    const [row] = await db.query(
      `WITH a AS (
         INSERT INTO appointments (token, status, source, customer_name, customer_phone, barber_id, barber_name, services,
                                   day, start_min, end_min, price, notes, client_ref, client_ip_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (client_ref) DO NOTHING
         RETURNING *
       ), s AS (
         INSERT INTO appointment_slots (barber_id, day, minute, appointment_id)
         SELECT a.barber_id, a.day, m, a.id FROM a, generate_series(a.start_min, a.end_min - ${GRANULE}, ${GRANULE}) AS m
       ), h AS (
         INSERT INTO appointment_history (appointment_id, status, changed_by) SELECT id, status, created_by FROM a
       )
       SELECT *, to_char(day, 'YYYY-MM-DD') AS day_iso FROM a`,
      [token, a.status, a.source, a.customerName, a.customerPhone, a.barber.id, a.barber.name, JSON.stringify(a.services),
        a.day, a.start, a.end, a.price, a.notes, a.clientRef ?? null, a.ipHash ?? null, a.createdBy]
    );
    return row || null;
  } catch (error) {
    if (isConflict(error)) return 'conflict';
    throw error;
  }
}

// cópia dos serviços com o preço deste barbeiro
const snapshot = (services, barber) => services.map(s => ({ id: s.id, name: s.name, price: priceFor(s, barber), duration: s.duration, ...(s.priceFrom ? { priceFrom: true } : {}) }));

export async function findByClientRef(db, clientRef) {
  if (!clientRef) return null;
  const [row] = await db.query(`SELECT ${COLS} FROM appointments WHERE client_ref = $1`, [clientRef]);
  return row || null;
}

/**
 * Agendamento feito pelo site. Confere tudo no servidor: serviços ativos, barbeiro, horário
 * ainda livre (e dentro das regras), limite por telefone e por IP. Lança HttpError com a
 * lista de problemas (422) ou 409 se o horário não estiver mais livre.
 */
export async function createBooking(db, body, { ipHash = null, now = new Date() } = {}) {
  const catalog = await getBookingCatalog(db);
  const { settings } = catalog;
  if (settings.paused) throw new HttpError(409, 'A agenda online está pausada agora. Fale com a gente pelo WhatsApp.');

  const errors = [];
  const name = cleanText(body.customer?.name, 80);
  const phone = digits(body.customer?.phone).slice(0, 13);
  if (name.length < 2) errors.push('Informe seu nome');
  if (phone.length < 10) errors.push('Informe um WhatsApp com DDD');
  const day = String(body.day || '');
  const time = String(body.time || '');
  if (!isRealDate(day)) errors.push('Escolha o dia');
  if (!TIME_RE.test(time)) errors.push('Escolha o horário');
  const notes = cleanText(body.notes, 300, { multiline: true });
  if (errors.length) throw new HttpError(422, errors[0], errors);

  const services = chooseServices(body.services, catalog.servicesById);
  const barberId = typeof body.barberId === 'string' && body.barberId ? body.barberId : 'any';
  const candidates = candidatesFor(catalog, services, barberId);

  const today = saoPauloParts(now).day;
  if (day < today) throw new HttpError(422, 'Esse dia já passou');
  if (daysBetween(today, day) > settings.maxDaysAhead) throw new HttpError(422, `Agendamos com até ${settings.maxDaysAhead} dias de antecedência`);

  // limites contra abuso (alguém tentando ocupar a agenda inteira)
  const [{ n: active }] = await db.query(
    `SELECT count(*)::int AS n FROM appointments
      WHERE customer_phone = $1 AND status IN ('agendado', 'confirmado') AND day >= $2`,
    [phone, today]
  );
  if (active >= MAX_ACTIVE_PER_PHONE) {
    throw new HttpError(429, `Este WhatsApp já tem ${MAX_ACTIVE_PER_PHONE} horários marcados. Para mudar, cancele um pelo link do agendamento ou fale com a barbearia.`);
  }
  if (ipHash) {
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM appointments WHERE client_ip_hash = $1 AND created_at > now() - interval '10 minutes'`,
      [ipHash]
    );
    if (n >= MAX_BOOKINGS_PER_IP_10_MIN) throw new HttpError(429, 'Muitos agendamentos em pouco tempo. Aguarde alguns minutos ou fale com a gente no WhatsApp.');
  }

  const info = (await busyByDay(db, day, day)).get(day);
  const slot = slotsForDay({ day, services, candidates, settings, info, now, staff: false }).find(s => s.time === time);
  if (!slot) throw new HttpError(409, 'Esse horário não está mais livre. Escolha outro.', { field: 'time' });

  const start = toMin(time);
  const duration = summarize(services).duration;
  for (const id of slot.barbers) {
    const barber = catalog.barbers.find(b => b.id === id);
    const row = await insertAppointment(db, {
      status: 'agendado', source: 'site', customerName: name, customerPhone: phone, barber,
      services: snapshot(services, barber), day, start, end: start + duration, price: summarize(services, barber).price,
      notes, clientRef: parseClientRef(body.clientRef), ipHash, createdBy: 'cliente',
    });
    if (row === 'conflict') continue; // outro cliente pegou este barbeiro agora: tenta o próximo livre
    if (row === null) return { row: await findByClientRef(db, parseClientRef(body.clientRef)), replay: true };
    return { row, replay: false };
  }
  throw new HttpError(409, 'Esse horário acabou de ser reservado. Escolha outro.', { field: 'time' });
}

/** Agendamento feito pela equipe no app (telefone, WhatsApp, encaixe, cliente na cadeira agora). */
export async function createByStaff(db, body, username) {
  const catalog = await getBookingCatalog(db);
  const errors = [];
  const name = cleanText(body.customer?.name, 80);
  const phone = digits(body.customer?.phone).slice(0, 13);
  if (name.length < 2) errors.push('Informe o nome do cliente');
  if (phone && phone.length < 10) errors.push('Telefone: informe com DDD (ou deixe em branco)');
  const day = String(body.day || '');
  const time = String(body.time || '');
  if (!isRealDate(day)) errors.push('Escolha o dia');
  if (!TIME_RE.test(time) || toMin(time) % GRANULE) errors.push('Horário inválido (use minutos de 5 em 5)');
  if (errors.length) throw new HttpError(422, errors[0], errors);

  const services = chooseServices(body.services, catalog.servicesById);
  const barber = catalog.barbers.find(b => b.id === body.barberId);
  if (!barber) throw new HttpError(422, 'Escolha o barbeiro');
  const start = toMin(time);
  const end = start + summarize(services).duration;
  if (end > 1440) throw new HttpError(422, 'O atendimento passaria da meia-noite');
  const status = body.status === 'em_atendimento' ? 'em_atendimento' : 'confirmado';

  const row = await insertAppointment(db, {
    status, source: 'app', customerName: name, customerPhone: phone, barber, services: snapshot(services, barber),
    day, start, end, price: summarize(services, barber).price, notes: cleanText(body.notes, 300, { multiline: true }), createdBy: username,
  });
  if (row === 'conflict') throw new HttpError(409, `${barber.name} já tem um atendimento nesse horário`);
  return toStaffAppointment(row);
}

export async function countRecentByIp(db, ipHash) {
  const [row] = await db.query(`SELECT count(*)::int AS n FROM appointments WHERE client_ip_hash = $1 AND created_at > now() - interval '10 minutes'`, [ipHash]);
  return row.n;
}

// ---------- Status ----------

function parsePayment(body, price) {
  const method = body?.paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) throw new HttpError(422, 'Escolha a forma de pagamento');
  const raw = body?.paidAmount ?? price;
  const amount = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new HttpError(422, 'Valor recebido inválido');
  return { method, amount: num(amount) };
}

/**
 * Muda o status. Concluir pede forma de pagamento (e o valor recebido); cancelar pede motivo.
 * Cancelado e "não compareceu" liberam o horário na agenda.
 */
export async function updateStatus(db, id, to, username, body = {}) {
  if (!STATUSES.includes(to)) throw new HttpError(422, 'Status inválido');
  const [current] = await db.query(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
  if (!current) throw new HttpError(404, 'Agendamento não encontrado');
  if (!canTransition(current.status, to)) {
    throw new HttpError(409, `Não é possível mudar de "${STATUS_LABELS[current.status]}" para "${STATUS_LABELS[to]}"`);
  }
  const reason = to === 'cancelado' ? cleanText(body.cancelReason, 200) : null;
  if (to === 'cancelado' && (!reason || reason.length < 3)) throw new HttpError(422, 'Informe o motivo do cancelamento');
  const payment = to === 'concluido' ? parsePayment(body, Number(current.price)) : null;

  const [row] = await db.query(
    `WITH a AS (
       UPDATE appointments SET status = $2::text, updated_at = now(),
              cancel_reason = CASE WHEN $2::text = 'cancelado' THEN $5::text ELSE cancel_reason END,
              payment_method = CASE WHEN $2::text = 'concluido' THEN $6::text ELSE payment_method END,
              paid_amount = CASE WHEN $2::text = 'concluido' THEN $7::numeric ELSE paid_amount END,
              completed_at = CASE WHEN $2::text = 'concluido' THEN now() ELSE completed_at END
        WHERE id = $1 AND status = $3::text RETURNING *
     ), freed AS (
       DELETE FROM appointment_slots WHERE appointment_id IN (SELECT id FROM a WHERE status IN ('cancelado', 'faltou'))
     ), h AS (
       INSERT INTO appointment_history (appointment_id, status, changed_by, note) SELECT id, status, $4::text, $5::text FROM a
     )
     SELECT *, to_char(day, 'YYYY-MM-DD') AS day_iso FROM a`,
    [id, to, current.status, username, reason, payment?.method ?? null, payment?.amount ?? null]
  );
  if (!row) throw new HttpError(409, 'O agendamento foi alterado por outra pessoa. Atualize a tela.');
  return toStaffAppointment(row);
}

/** Corrige a forma de pagamento ou o valor de um atendimento já concluído. */
export async function updatePayment(db, id, body, username) {
  const [current] = await db.query(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
  if (!current) throw new HttpError(404, 'Agendamento não encontrado');
  if (current.status !== 'concluido') throw new HttpError(409, 'Só dá para alterar o pagamento de um atendimento concluído');
  const payment = parsePayment({ paymentMethod: body.paymentMethod ?? current.payment_method, paidAmount: body.paidAmount ?? current.paid_amount }, Number(current.price));
  const [row] = await db.query(
    `WITH a AS (
       UPDATE appointments SET payment_method = $2, paid_amount = $3, updated_at = now() WHERE id = $1 RETURNING *
     ), h AS (
       INSERT INTO appointment_history (appointment_id, status, changed_by, note) SELECT id, status, $4, 'Pagamento alterado' FROM a
     )
     SELECT *, to_char(day, 'YYYY-MM-DD') AS day_iso FROM a`,
    [id, payment.method, payment.amount, username]
  );
  return toStaffAppointment(row);
}

export async function updateNotes(db, id, notes) {
  const [row] = await db.query(`UPDATE appointments SET notes = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, cleanText(notes, 300, { multiline: true })]);
  if (!row) throw new HttpError(404, 'Agendamento não encontrado');
  return toStaffAppointment(row);
}

/**
 * Remarca (outro dia, horário e/ou barbeiro) numa transação: libera os blocos antigos, muda o
 * horário e ocupa os novos. Se o horário novo estiver ocupado, nada muda.
 */
export async function reschedule(db, id, body, username) {
  const catalog = await getBookingCatalog(db);
  const [current] = await db.query(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
  if (!current) throw new HttpError(404, 'Agendamento não encontrado');
  if (!['agendado', 'confirmado'].includes(current.status)) throw new HttpError(409, 'Só dá para remarcar agendamentos que ainda não começaram');
  const day = String(body.day || '');
  const time = String(body.time || '');
  if (!isRealDate(day)) throw new HttpError(422, 'Escolha o dia');
  if (!TIME_RE.test(time) || toMin(time) % GRANULE) throw new HttpError(422, 'Horário inválido (use minutos de 5 em 5)');
  const barber = catalog.barbers.find(b => b.id === (body.barberId || current.barber_id));
  if (!barber) throw new HttpError(422, 'Escolha um barbeiro ativo');

  // preço e duração seguem o cadastro atual; serviço que saiu do catálogo mantém o valor antigo
  const services = current.services.map(s => {
    const svc = catalog.allServicesById.get(s.id);
    return svc ? { ...s, price: priceFor(svc, barber), duration: svc.duration } : s;
  });
  const start = toMin(time);
  const end = start + services.reduce((t, s) => t + Number(s.duration || 0), 0);
  if (end > 1440) throw new HttpError(422, 'O atendimento passaria da meia-noite');
  const price = num(services.reduce((t, s) => t + Number(s.price || 0), 0));
  const note = `Remarcado de ${dayOf(current).split('-').reverse().slice(0, 2).join('/')} ${toHHMM(current.start_min)} (${current.barber_name})`;

  try {
    await db.transaction([
      [`DELETE FROM appointment_slots WHERE appointment_id = $1
          AND EXISTS (SELECT 1 FROM appointments WHERE id = $1 AND status = $2)`, [id, current.status]],
      [`UPDATE appointments SET day = $2, start_min = $3, end_min = $4, barber_id = $5, barber_name = $6, services = $7,
              price = $8, updated_at = now() WHERE id = $1 AND status = $9`,
      [id, day, start, end, barber.id, barber.name, JSON.stringify(services), price, current.status]],
      [`INSERT INTO appointment_slots (barber_id, day, minute, appointment_id)
        SELECT barber_id, day, m, id FROM appointments, generate_series(start_min, end_min - ${GRANULE}, ${GRANULE}) AS m
         WHERE id = $1 AND day = $2 AND start_min = $3 AND barber_id = $4 AND status = $5`, [id, day, start, barber.id, current.status]],
      [`INSERT INTO appointment_history (appointment_id, status, changed_by, note)
        SELECT id, status, $2, $3 FROM appointments WHERE id = $1`, [id, username, note]],
    ]);
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, `${barber.name} já tem um atendimento nesse horário`);
    throw error;
  }
  const [row] = await db.query(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
  if (dayOf(row) !== day || row.start_min !== start) throw new HttpError(409, 'O agendamento foi alterado por outra pessoa. Atualize a tela.');
  return toStaffAppointment(row);
}

// ---------- Link público do cliente ----------

export async function findByToken(db, token) {
  const [row] = await db.query(`SELECT ${COLS} FROM appointments WHERE token = $1`, [token]);
  return row || null;
}

/** O cliente cancela pelo link (até `cancelHours` antes). */
export async function cancelByClient(db, row, settings, now = new Date()) {
  if (!canClientCancel(row, settings, now)) {
    const late = ['agendado', 'confirmado'].includes(row.status);
    throw new HttpError(409, late
      ? `Faltam menos de ${settings.cancelHours} hora${settings.cancelHours === 1 ? '' : 's'} para o horário. Para cancelar, fale com a barbearia pelo WhatsApp.`
      : 'Este agendamento não pode mais ser cancelado.');
  }
  await updateStatus(db, Number(row.id), 'cancelado', 'cliente', { cancelReason: 'Cancelado pelo cliente pelo link' });
  return findByToken(db, row.token);
}

// ---------- Consultas da equipe ----------

/** Agenda de um dia: agendamentos (todos os status), bloqueios e pendentes de confirmação. */
export async function getDayBoard(db, day, now = new Date()) {
  const today = saoPauloParts(now).day;
  const [appointments, blocks, pending] = await Promise.all([
    db.query(`SELECT ${COLS} FROM appointments WHERE day = $1 ORDER BY start_min, id`, [day]),
    listBlocks(db, day),
    db.query(`SELECT ${COLS} FROM appointments WHERE status = 'agendado' AND day >= $1 ORDER BY day, start_min LIMIT 100`, [today]),
  ]);
  return { day, today, appointments: appointments.map(toStaffAppointment), blocks, pending: pending.map(toStaffAppointment) };
}

export async function getDetail(db, id) {
  const [row] = await db.query(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Agendamento não encontrado');
  const [history, stats] = await Promise.all([
    db.query('SELECT status, changed_by, note, created_at FROM appointment_history WHERE appointment_id = $1 ORDER BY created_at, id', [id]),
    row.customer_phone
      ? db.query(
        `SELECT count(*) FILTER (WHERE status = 'concluido')::int AS visits, count(*) FILTER (WHERE status = 'faltou')::int AS no_shows
           FROM appointments WHERE customer_phone = $1`, [row.customer_phone])
      : Promise.resolve([{ visits: 0, no_shows: 0 }]),
  ]);
  return {
    ...toStaffAppointment(row),
    client: { visits: stats[0].visits, noShows: stats[0].no_shows },
    history: history.map(h => ({ status: h.status, label: STATUS_LABELS[h.status], by: h.changed_by, note: h.note, at: new Date(h.created_at).toISOString() })),
  };
}

const PAGE_SIZE = 50;
const page = (p) => Math.max(1, Math.floor(Number(p)) || 1);

/** Histórico: período (datas do atendimento), texto (código, nome, telefone), status e barbeiro. */
export async function searchAppointments(db, { from, to, q = '', status = '', barber = '', page: p = 1 }) {
  const params = [from, to];
  let where = 'day BETWEEN $1 AND $2';
  if (STATUSES.includes(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (barber) {
    params.push(String(barber).slice(0, 40));
    where += ` AND barber_id = $${params.length}`;
  }
  const term = String(q).trim().slice(0, 60);
  if (term) {
    const d = term.replace(/\D/g, '');
    params.push(`%${term.toLowerCase()}%`);
    const conds = [`lower(customer_name) LIKE $${params.length}`];
    if (d) {
      params.push(Number(d.slice(0, 12)));
      conds.push(`id = $${params.length}`);
      params.push(`%${d}%`);
      conds.push(`customer_phone LIKE $${params.length}`);
    }
    where += ` AND (${conds.join(' OR ')})`;
  }
  const offset = (page(p) - 1) * PAGE_SIZE;
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM appointments WHERE ${where}`, params);
  const rows = await db.query(`SELECT ${COLS} FROM appointments WHERE ${where} ORDER BY day DESC, start_min DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params);
  return { appointments: rows.map(toStaffAppointment), total: n, pageSize: PAGE_SIZE };
}

/** Clientes (agrupados pelo telefone): visitas, última visita, total gasto, faltas e próximo horário. */
export async function listClients(db, { q = '', page: p = 1 }, now = new Date()) {
  const today = saoPauloParts(now).day;
  const params = [today];
  let having = '';
  const term = String(q).trim().slice(0, 60);
  if (term) {
    const d = term.replace(/\D/g, '');
    params.push(`%${term.toLowerCase()}%`);
    having = `HAVING bool_or(lower(customer_name) LIKE $${params.length})`;
    if (d.length >= 3) {
      params.push(`%${d}%`);
      having += ` OR customer_phone LIKE $${params.length}`;
    }
  }
  const base = `SELECT customer_phone,
                       (array_agg(customer_name ORDER BY created_at DESC))[1] AS name,
                       count(*) FILTER (WHERE status = 'concluido')::int AS visits,
                       count(*) FILTER (WHERE status = 'faltou')::int AS no_shows,
                       to_char(max(day) FILTER (WHERE status = 'concluido'), 'YYYY-MM-DD') AS last_visit,
                       to_char(min(day) FILTER (WHERE status IN ('agendado', 'confirmado') AND day >= $1), 'YYYY-MM-DD') AS next_visit,
                       coalesce(sum(paid_amount) FILTER (WHERE status = 'concluido'), 0) AS spent,
                       mode() WITHIN GROUP (ORDER BY barber_name) AS barber
                  FROM appointments WHERE customer_phone <> '' GROUP BY customer_phone ${having}`;
  const offset = (page(p) - 1) * PAGE_SIZE;
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM (${base}) c`, params);
  const rows = await db.query(`${base} ORDER BY max(created_at) DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params);
  return {
    clients: rows.map(r => ({
      phone: r.customer_phone, name: r.name, visits: r.visits, noShows: r.no_shows, lastVisit: r.last_visit,
      nextVisit: r.next_visit, spent: num(r.spent), barber: r.barber,
    })),
    total: n,
    pageSize: PAGE_SIZE,
  };
}

export async function clientHistory(db, phone) {
  const rows = await db.query(`SELECT ${COLS} FROM appointments WHERE customer_phone = $1 ORDER BY day DESC, start_min DESC LIMIT 100`, [digits(phone)]);
  if (!rows.length) throw new HttpError(404, 'Cliente não encontrado');
  return { phone: digits(phone), name: rows[0].customer_name, appointments: rows.map(toStaffAppointment) };
}

// ---------- Bloqueios ----------

export async function listBlocks(db, day) {
  const rows = await db.query(
    `SELECT b.*, to_char(b.day, 'YYYY-MM-DD') AS from_day, to_char(b.until_day, 'YYYY-MM-DD') AS to_day, r.name AS barber_name
       FROM time_blocks b LEFT JOIN barbers r ON r.id = b.barber_id
      WHERE b.day <= $1 AND b.until_day >= $1 ORDER BY b.start_min`,
    [day]
  );
  return rows.map(b => ({
    id: Number(b.id), barberId: b.barber_id, barberName: b.barber_name || null, day: b.from_day, untilDay: b.to_day,
    start: toHHMM(b.start_min), end: toHHMM(b.end_min), startMin: b.start_min, endMin: b.end_min, reason: b.reason, by: b.created_by,
  }));
}

export function validateBlock(body, barbers) {
  const day = String(body?.day || '');
  const untilDay = String(body?.untilDay || day);
  if (!isRealDate(day) || !isRealDate(untilDay)) throw new HttpError(422, 'Datas inválidas');
  if (untilDay < day) throw new HttpError(422, 'A data final precisa ser depois da inicial');
  if (daysBetween(day, untilDay) > 90) throw new HttpError(422, 'Bloqueie no máximo 90 dias de uma vez');
  const allDay = body?.allDay === true;
  const start = allDay ? 0 : TIME_RE.test(body?.start || '') ? toMin(body.start) : NaN;
  const end = allDay ? 1440 : TIME_RE.test(body?.end || '') ? toMin(body.end) : body?.end === '24:00' ? 1440 : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(422, 'Informe o início e o fim do bloqueio');
  const barberId = body?.barberId || null;
  if (barberId && !barbers.some(b => b.id === barberId)) throw new HttpError(422, 'Barbeiro inválido');
  return { barberId, day, untilDay, start, end, reason: cleanText(body?.reason, 80) };
}

export async function createBlock(db, body, username) {
  const { allBarbers } = await getBookingCatalog(db);
  const b = validateBlock(body, allBarbers);
  const [row] = await db.query(
    `INSERT INTO time_blocks (barber_id, day, until_day, start_min, end_min, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [b.barberId, b.day, b.untilDay, b.start, b.end, b.reason, username]
  );
  return { id: Number(row.id), ...b };
}
