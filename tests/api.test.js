// @vitest-environment node
/**
 * Testes de integração da API (site + app de gestão) contra um Postgres real em memória (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

process.env.SESSION_SECRET = 'teste-'.repeat(8);
process.env.SCRYPT_N = '16384'; // hash rápido nos testes (produção usa 2^17)

const { setDb, migrate, pgliteAdapter } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { getAvailability, createBooking, cancelByClient, findByToken, canTransition } = await import('../server/appointments.js');
const { getStoreSettings } = await import('../server/catalog.js');
const { saoPauloParts } = await import('../shared/store-hours.js');
const { addDays, weekdayOf } = await import('../shared/schedule.js');
const fn = async (name) => (await import(`../netlify/functions/${name}.js`)).default;
const catalogApi = await fn('catalog');
const availabilityApi = await fn('availability');
const bookingsApi = await fn('bookings');
const session = await fn('admin-session');
const adminAppointments = await fn('admin-appointments');
const adminAvailability = await fn('admin-availability');
const adminBlocks = await fn('admin-blocks');
const adminCatalog = await fn('admin-catalog');
const adminClients = await fn('admin-clients');
const adminStore = await fn('admin-store');
const adminCash = await fn('admin-cash');
const adminFinance = await fn('admin-finance');
const reports = await fn('admin-reports');
const adminStaff = await fn('admin-staff');

let db;

const BASE = 'http://localhost';
let ipCounter = 0;
const ctx = (extra = {}) => ({ ip: `10.0.0.${++ipCounter % 250}`, params: {}, ...extra });
const req = (method, path, { token, body } = {}) => new Request(BASE + path, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (path, body) => req('POST', path, { body });
// status = código HTTP (o status do agendamento vem em statusLabel ou dentro de appointment)
const read = async (res) => ({ ...(await res.json()), status: res.status });

// Dias de teste calculados a partir de hoje (o teste não depende da data em que roda)
const today = saoPauloParts().day;
function nextWeekday(dow, minDays = 2) {
  let d = addDays(today, minDays);
  while (weekdayOf(d) !== dow) d = addDays(d, 1);
  return d;
}
const TUE = nextWeekday(2); // terça: 09:00–12:00 e 13:30–20:00
const MON = nextWeekday(1); // segunda: 13:30–20:00
const SUN = nextWeekday(0); // domingo: fechado
const WED = nextWeekday(3);
// "agora" fixo numa terça às 09:50 (horário de Brasília = UTC−3)
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00-03:00`);

let phoneSeq = 0;
const newPhone = () => `4799${String(1000000 + ++phoneSeq).slice(-7)}`;
const booking = (overrides = {}) => ({
  customer: { name: 'Cliente Teste', phone: newPhone() },
  services: ['corte'],
  barberId: 'any',
  day: TUE,
  time: '10:00',
  ...overrides,
});
const book = async (body, ip) => read(await bookingsApi(post('/api/bookings', body), ctx(ip ? { ip } : {})));
const slotsOf = async (query) => read(await availabilityApi(new Request(`${BASE}/api/availability?${new URLSearchParams(query)}`), ctx()));

async function login(username, password) {
  return read(await session(post('/api/admin/session', { username, password }), ctx()));
}

let owner; // token do dono

beforeAll(async () => {
  db = pgliteAdapter(new PGlite());
  setDb(db);
  await migrate(db);
  await db.query(
    "INSERT INTO staff_users (username, password_hash, display_name, role) VALUES ($1, $2, 'Dono Teste', 'dono')",
    ['dono', hashPassword('senha-de-teste-123')]
  );
  owner = (await login('dono', 'senha-de-teste-123')).token;
});

describe('dados iniciais (db/seed)', () => {
  it('migrar de novo não duplica serviços nem barbeiros', async () => {
    const count = async (t) => (await db.query(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
    const before = [await count('services'), await count('barbers')];
    await migrate(db);
    expect([await count('services'), await count('barbers')]).toEqual(before);
    expect(before).toEqual([23, 5]);
  });

  it('o catálogo público traz serviços, barbeiros e horários, sem comissões', async () => {
    const res = await catalogApi(new Request(`${BASE}/api/catalog`), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.services.find(s => s.id === 'corte')).toMatchObject({ price: 45, duration: 30, category: 'cabelo' });
    expect(data.barbers.map(b => b.name)).toEqual(['Daniel', 'Gabriel', 'Renan', 'Victor', 'Yago']);
    expect(data.barbers.find(b => b.id === 'renan').prices.corte).toBe(55);
    expect(data.barbers[0].commissionPercent).toBeUndefined();
    expect(data.settings.hours[2]).toEqual({ open: '09:00', close: '20:00', breakStart: '12:00', breakEnd: '13:30' });
    expect(data.status.label).toBeTruthy();
  });
});

describe('horários livres', () => {
  it('respeita o horário, o almoço e a duração do serviço', async () => {
    const { slots, prices } = await slotsOf({ day: TUE, services: 'corte' });
    const times = slots.map(s => s.time);
    expect(times[0]).toBe('09:00');
    expect(times).toContain('11:30'); // termina 12:00
    expect(times).not.toContain('11:45'); // passaria do almoço
    expect(times).not.toContain('12:00');
    expect(times).toContain('13:30');
    expect(times.at(-1)).toBe('19:30');
    expect(prices).toMatchObject({ daniel: 45, renan: 55 });

    const combo = (await slotsOf({ day: TUE, services: 'corte_barba' })).slots.map(s => s.time);
    expect(combo).toContain('11:00');
    expect(combo).not.toContain('11:15');
  });

  it('"sem preferência" oferece primeiro quem cobra menos', async () => {
    const { slots } = await slotsOf({ day: TUE, services: 'corte' });
    expect(slots[0].barbers).toEqual(['daniel', 'gabriel', 'victor', 'yago', 'renan']);
  });

  it('segunda só à tarde e domingo fechado', async () => {
    expect((await slotsOf({ day: MON, services: 'corte' })).slots[0].time).toBe('13:30');
    expect((await slotsOf({ day: SUN, services: 'corte' })).slots).toEqual([]);
  });

  it('aplica a antecedência mínima no dia de hoje', async () => {
    const settings = await getStoreSettings(db);
    const result = await getAvailability(db, { day: TUE, services: ['corte'] }, at(TUE, '09:50'));
    expect(settings.minNoticeMinutes).toBe(30);
    expect(result.slots[0].time).toBe('10:30'); // 09:50 + 30 min, de 15 em 15
  });

  it('recusa dias além do limite e serviços desconhecidos', async () => {
    expect((await slotsOf({ day: addDays(today, 45), services: 'corte' })).slots).toEqual([]);
    expect((await slotsOf({ day: TUE, services: 'nao_existe' })).status).toBe(422);
    expect((await slotsOf({ day: '2026-02-31', services: 'corte' })).status).toBe(422);
  });

  it('próximos horários livres para a vitrine do site', async () => {
    const { slots } = await slotsOf({ services: 'corte', limit: 4 });
    expect(slots.length).toBe(4);
    expect(slots[0].day >= today).toBe(true);
  });
});

describe('site: agendamento', () => {
  let first;

  it('cria o agendamento e o link não mostra o telefone', async () => {
    const body = booking({ notes: 'Degradê baixo' });
    first = await book(body);
    expect(first.status).toBe(201);
    expect(first.code).toMatch(/^#\d{4}$/);
    expect(first.booking).toMatchObject({ barberName: 'Daniel', day: TUE, time: '10:00', endTime: '10:30', price: 45, status: 'agendado', canCancel: true });
    const view = await read(await bookingsApi(new Request(`${BASE}/api/bookings/${first.token}`), ctx({ params: { token: first.token } })));
    expect(view.status).toBe(200);
    expect(JSON.stringify(view)).not.toContain(body.customer.phone);
    expect(JSON.stringify(view)).not.toContain('Degradê');
  });

  it('o mesmo horário vai para o próximo barbeiro livre', async () => {
    const second = await book(booking());
    expect(second.booking.barberName).toBe('Gabriel');
    const { slots } = await slotsOf({ day: TUE, services: 'corte', barber: 'daniel' });
    expect(slots.map(s => s.time)).not.toContain('10:00');
    expect(slots.map(s => s.time)).not.toContain('10:15'); // ocupado até 10:30
    expect(slots.map(s => s.time)).toContain('10:30');
  });

  it('não deixa dois clientes no mesmo horário do mesmo barbeiro', async () => {
    const res = await book(booking({ barberId: 'daniel' }));
    expect(res.status).toBe(409);
  });

  it('o banco recusa a reserva repetida mesmo sem passar pela checagem de horários', async () => {
    const [a] = await db.query("SELECT * FROM appointments WHERE barber_id = 'daniel' AND start_min = 600 LIMIT 1");
    await expect(db.query(
      `WITH x AS (INSERT INTO appointments (token, customer_name, barber_id, barber_name, services, day, start_min, end_min, price)
                  VALUES ('tok-duplicado-0000000000', 'Fura Fila', 'daniel', 'Daniel', '[]', $1, 615, 645, 45) RETURNING *)
       INSERT INTO appointment_slots (barber_id, day, minute, appointment_id) SELECT barber_id, day, m, id FROM x, generate_series(615, 640, 5) m`,
      [a.day_iso || TUE]
    )).rejects.toThrow();
  });

  it('cobra o preço do barbeiro escolhido', async () => {
    const res = await book(booking({ barberId: 'renan', time: '14:00', services: ['corte', 'barba'] }));
    expect(res.status).toBe(201);
    expect(res.booking).toMatchObject({ price: 100, duration: 60, endTime: '15:00' });
  });

  it('recusa dados inválidos com mensagens claras', async () => {
    const res = await book(booking({ customer: { name: 'A', phone: '123' }, time: '' }));
    expect(res.status).toBe(422);
    expect(res.details).toEqual(expect.arrayContaining(['Informe seu nome', 'Informe um WhatsApp com DDD', 'Escolha o horário']));
    expect((await book(booking({ time: '11:45' }))).status).toBe(409); // não cabe antes do almoço
    expect((await book(booking({ day: SUN }))).status).toBe(409);
    expect((await book(booking({ services: ['corte', 'corte', 'barba', 'sobrancelhas', 'hidratacao', 'pezinho'] }))).status).toBe(422);
  });

  it('o mesmo agendamento reenviado não vira dois', async () => {
    const body = booking({ time: '16:00', clientRef: 'agenda-0123456789abcdef' });
    const a = await book(body);
    const b = await book(body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.id).toBe(a.id);
    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM appointments WHERE client_ref = 'agenda-0123456789abcdef'");
    expect(n).toBe(1);
  });

  it('limita horários marcados por WhatsApp e por IP', async () => {
    const phone = newPhone();
    for (const time of ['17:00', '17:30', '18:00']) expect((await book(booking({ time, customer: { name: 'Repetido', phone } }))).status).toBe(201);
    const fourth = await book(booking({ time: '18:30', customer: { name: 'Repetido', phone } }));
    expect(fourth.status).toBe(429);

    for (const time of ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']) expect((await book(booking({ day: WED, time }), '10.200.0.1')).status).toBe(201);
    expect((await book(booking({ day: WED, time: '17:00' }), '10.200.0.1')).status).toBe(429);
  });

  it('o cliente cancela pelo link e o horário volta a ficar livre', async () => {
    const b = await book(booking({ time: '19:00', barberId: 'yago' }));
    const cancel = await read(await bookingsApi(post(`/api/bookings/${b.token}/cancel`, {}), ctx({ params: { token: b.token, action: 'cancel' } })));
    expect(cancel).toMatchObject({ status: 200, statusLabel: 'Cancelado', canCancel: false });
    const { slots } = await slotsOf({ day: TUE, services: 'corte', barber: 'yago' });
    expect(slots.map(s => s.time)).toContain('19:00');
  });

  it('perto do horário o cancelamento pelo link é recusado', async () => {
    const settings = await getStoreSettings(db);
    const { row } = await createBooking(db, booking({ time: '15:00', barberId: 'victor' }), { now: at(TUE, '08:00') });
    await expect(cancelByClient(db, row, settings, at(TUE, '13:30'))).rejects.toMatchObject({ status: 409 });
    const ok = await cancelByClient(db, await findByToken(db, row.token), settings, at(TUE, '12:00'));
    expect(ok.status).toBe('cancelado');
  });

  it('com a agenda pausada o site não aceita agendamentos', async () => {
    await adminStore(req('PATCH', '/api/admin/store', { token: owner, body: { paused: true, pauseMessage: 'Voltamos amanhã' } }), ctx());
    expect((await slotsOf({ day: TUE, services: 'corte' })).paused).toBe(true);
    expect((await book(booking({ time: '13:30' }))).status).toBe(409);
    await adminStore(req('PATCH', '/api/admin/store', { token: owner, body: { paused: false } }), ctx());
    expect((await book(booking({ time: '13:30' }))).status).toBe(201);
  });
});

describe('app de gestão: login e permissões', () => {
  it('rotas da equipe exigem login', async () => {
    expect((await adminAppointments(req('GET', '/api/admin/appointments'), ctx())).status).toBe(401);
    expect((await adminCatalog(req('GET', '/api/admin/catalog'), ctx())).status).toBe(401);
  });

  it('senha errada e usuário inexistente dão a mesma resposta', async () => {
    const wrong = await login('dono', 'senha-errada-000');
    const ghost = await login('fantasma', 'senha-errada-000');
    expect([wrong.status, ghost.status]).toEqual([401, 401]);
    expect(wrong.error).toBe(ghost.error);
  });

  it('login devolve token e as permissões do papel', async () => {
    const res = await login('dono', 'senha-de-teste-123');
    expect(res.user).toMatchObject({ role: 'dono', roleLabel: 'Dono' });
    expect(res.user.permissions).toContain('finance.view');
    const refreshed = await read(await session(req('GET', '/api/admin/session', { token: res.token }), ctx()));
    expect(refreshed.token).toBeTruthy();
  });

  it('cada papel só faz o que pode', async () => {
    for (const [username, role] of [['bia', 'recepcao'], ['kauan', 'barbeiro']]) {
      const res = await adminStaff(req('POST', '/api/admin/staff', { token: owner, body: { username, role, displayName: username, password: 'cadeira-giratoria-42' } }), ctx());
      expect(res.status).toBe(201);
    }
    const reception = (await login('bia', 'cadeira-giratoria-42')).token;
    const barber = (await login('kauan', 'cadeira-giratoria-42')).token;
    expect((await adminAppointments(req('GET', '/api/admin/appointments', { token: barber }), ctx())).status).toBe(200);
    expect((await adminFinance(req('GET', '/api/admin/finance', { token: reception }), ctx())).status).toBe(403);
    expect((await adminCash(req('GET', '/api/admin/cash', { token: barber }), ctx())).status).toBe(403);
    expect((await adminClients(req('GET', '/api/admin/clients', { token: reception }), ctx())).status).toBe(200);
    const edit = await adminCatalog(req('PATCH', '/api/admin/catalog/services/corte', { token: reception, body: { price: 1 } }), ctx({ params: { resource: 'services', id: 'corte' } }));
    expect(edit.status).toBe(403);
  });

  it('não deixa a barbearia sem dono ativo', async () => {
    const res = await adminStaff(req('PATCH', '/api/admin/staff/dono', { token: owner, body: { role: 'recepcao' } }), ctx({ params: { username: 'dono' } }));
    expect(res.status).toBe(409);
  });
});

describe('app de gestão: agenda', () => {
  let appt;
  const patchAppt = (id, body, token = owner) => adminAppointments(req('PATCH', `/api/admin/appointments/${id}`, { token, body }), ctx({ params: { id: String(id) } }));

  it('mostra o dia com os agendamentos, bloqueios e os que aguardam confirmação', async () => {
    const board = await read(await adminAppointments(req('GET', `/api/admin/appointments?day=${TUE}`, { token: owner }), ctx()));
    expect(board.appointments.length).toBeGreaterThan(3);
    expect(board.pending.every(a => a.status === 'agendado')).toBe(true);
    appt = board.appointments.find(a => a.barberId === 'daniel' && a.start === '10:00');
    expect(appt).toMatchObject({ customerName: 'Cliente Teste', end: '10:30', source: 'site' });
    expect(appt.link).toMatch(/^\/agendamento\/\?t=/);
  });

  it('confirma, atende e conclui com a forma de pagamento', async () => {
    const barber = (await login('kauan', 'cadeira-giratoria-42')).token;
    expect((await patchAppt(appt.id, { status: 'confirmado' }, barber)).status).toBe(200);
    expect((await patchAppt(appt.id, { status: 'em_atendimento' }, barber)).status).toBe(200);
    expect((await patchAppt(appt.id, { status: 'concluido' }, barber)).status).toBe(422);
    const done = await read(await patchAppt(appt.id, { status: 'concluido', paymentMethod: 'dinheiro' }, barber));
    expect(done.appointment).toMatchObject({ status: 'concluido', paymentMethod: 'dinheiro', paidAmount: 45 });
    expect((await patchAppt(appt.id, { status: 'cancelado', cancelReason: 'teste' })).status).toBe(409);
    const detail = await read(await adminAppointments(req('GET', `/api/admin/appointments/${appt.id}`, { token: owner }), ctx({ params: { id: String(appt.id) } })));
    expect(detail.appointment.history.map(h => [h.status, h.by])).toEqual([['agendado', 'cliente'], ['confirmado', 'kauan'], ['em_atendimento', 'kauan'], ['concluido', 'kauan']]);
  });

  it('cancelar exige motivo e só a recepção ou o dono cancelam', async () => {
    const board = await read(await adminAppointments(req('GET', `/api/admin/appointments?day=${TUE}`, { token: owner }), ctx()));
    const target = board.appointments.find(a => a.barberId === 'gabriel' && a.start === '10:00');
    const barber = (await login('kauan', 'cadeira-giratoria-42')).token;
    expect((await patchAppt(target.id, { status: 'cancelado', cancelReason: 'cliente pediu' }, barber)).status).toBe(403);
    expect((await patchAppt(target.id, { status: 'cancelado' })).status).toBe(422);
    expect((await patchAppt(target.id, { status: 'cancelado', cancelReason: 'Cliente pediu' })).status).toBe(200);
    const { slots } = await slotsOf({ day: TUE, services: 'corte', barber: 'gabriel' });
    expect(slots.map(s => s.time)).toContain('10:00');
  });

  it('só permite transições de status válidas', () => {
    expect(canTransition('agendado', 'confirmado')).toBe(true);
    expect(canTransition('concluido', 'agendado')).toBe(false);
    expect(canTransition('faltou', 'concluido')).toBe(false);
  });

  it('a equipe agenda pelo app (encaixe sem telefone) e o banco impede choque de horário', async () => {
    const create = (body) => adminAppointments(req('POST', '/api/admin/appointments', { token: owner, body }), ctx());
    const res = await read(await create({ customer: { name: 'Seu Jorge' }, services: ['barba_express'], barberId: 'victor', day: TUE, time: '09:05', status: 'em_atendimento' }));
    expect(res.status).toBe(201);
    expect(res.appointment).toMatchObject({ status: 'em_atendimento', source: 'app', start: '09:05', end: '09:20', price: 25 });
    expect((await create({ customer: { name: 'Outro' }, services: ['corte'], barberId: 'victor', day: TUE, time: '09:15' })).status).toBe(409);
    expect((await create({ customer: { name: 'Outro' }, services: ['corte'], barberId: 'victor', day: TUE, time: '09:13' })).status).toBe(422);
  });

  it('remarca para outro horário livre e recusa horário ocupado', async () => {
    const created = await read(await adminAppointments(req('POST', '/api/admin/appointments', { token: owner, body: { customer: { name: 'Remarca', phone: '47999990000' }, services: ['corte'], barberId: 'yago', day: TUE, time: '09:00' } }), ctx()));
    const id = String(created.appointment.id);
    const move = (body) => adminAppointments(req('POST', `/api/admin/appointments/${id}/reschedule`, { token: owner, body }), ctx({ params: { id, action: 'reschedule' } }));
    // Victor está ocupado às 09:05–09:20
    expect((await move({ day: TUE, time: '09:00', barberId: 'victor' })).status).toBe(409);
    // continua onde estava
    expect((await slotsOf({ day: TUE, services: 'corte', barber: 'yago' })).slots.map(s => s.time)).not.toContain('09:00');
    // 15 minutos depois com o mesmo barbeiro (sobreposto ao próprio horário antigo)
    const moved = await read(await move({ day: TUE, time: '09:15' }));
    expect(moved.appointment).toMatchObject({ start: '09:15', barberId: 'yago' });
    const renan = await read(await move({ day: WED, time: '15:00', barberId: 'renan' }));
    expect(renan.appointment).toMatchObject({ day: WED, barberName: 'Renan', price: 55 });
    expect((await slotsOf({ day: TUE, services: 'corte', barber: 'yago' })).slots.map(s => s.time)).toContain('09:15');
  });

  it('"não compareceu" libera o horário', async () => {
    const created = await read(await adminAppointments(req('POST', '/api/admin/appointments', { token: owner, body: { customer: { name: 'Sumido', phone: '47988887777' }, services: ['corte'], barberId: 'gabriel', day: TUE, time: '15:30' } }), ctx()));
    expect((await patchAppt(created.appointment.id, { status: 'faltou' })).status).toBe(200);
    expect((await slotsOf({ day: TUE, services: 'corte', barber: 'gabriel' })).slots.map(s => s.time)).toContain('15:30');
  });

  it('bloqueios tiram horários do site (de um barbeiro ou de todos)', async () => {
    const block = async (body) => read(await adminBlocks(req('POST', '/api/admin/blocks', { token: owner, body }), ctx()));
    const one = await block({ barberId: 'victor', day: TUE, start: '13:30', end: '15:00', reason: 'Médico' });
    expect(one.status).toBe(201);
    expect((await slotsOf({ day: TUE, services: 'corte', barber: 'victor' })).slots.map(s => s.time)).not.toContain('14:00');
    const all = await block({ barberId: null, day: WED, untilDay: WED, allDay: true, reason: 'Feriado' });
    expect((await slotsOf({ day: WED, services: 'corte' })).slots).toEqual([]);
    const del = await adminBlocks(req('DELETE', `/api/admin/blocks/${all.block.id}`, { token: owner }), ctx({ params: { id: String(all.block.id) } }));
    expect(del.status).toBe(200);
    expect((await slotsOf({ day: WED, services: 'corte' })).slots.length).toBeGreaterThan(0);
    expect((await block({ day: TUE, start: '15:00', end: '14:00' })).status).toBe(422);
  });

  it('horários para a equipe ignoram a pausa do site', async () => {
    await adminStore(req('PATCH', '/api/admin/store', { token: owner, body: { paused: true } }), ctx());
    const res = await read(await adminAvailability(req('GET', `/api/admin/availability?day=${TUE}&services=corte&barber=daniel`, { token: owner }), ctx()));
    expect(res.slots.length).toBeGreaterThan(0);
    await adminStore(req('PATCH', '/api/admin/store', { token: owner, body: { paused: false } }), ctx());
  });

  it('busca no histórico por nome, telefone e código', async () => {
    const search = async (q) => read(await adminAppointments(req('GET', `/api/admin/appointments?from=${today}&to=${addDays(today, 10)}&q=${encodeURIComponent(q)}`, { token: owner }), ctx()));
    expect((await search('seu jorge')).total).toBe(1);
    expect((await search('47988887777')).total).toBe(1);
    expect((await search(String(appt.id))).appointments.some(a => a.id === appt.id)).toBe(true);
  });

  it('lista clientes com visitas, faltas e total gasto', async () => {
    const { clients } = await read(await adminClients(req('GET', '/api/admin/clients', { token: owner }), ctx()));
    const sumido = clients.find(c => c.phone === '47988887777');
    expect(sumido).toMatchObject({ name: 'Sumido', visits: 0, noShows: 1 });
    const regular = clients.find(c => c.phone === appt.customerPhone);
    expect(regular).toMatchObject({ visits: 1, spent: 45 });
    const history = await read(await adminClients(req('GET', `/api/admin/clients/${appt.customerPhone}`, { token: owner }), ctx({ params: { phone: appt.customerPhone } })));
    expect(history.appointments).toHaveLength(1);
  });
});

describe('app de gestão: serviços, barbeiros e barbearia', () => {
  const patchCatalog = (resource, id, body) => adminCatalog(req('PATCH', `/api/admin/catalog/${resource}/${id}`, { token: owner, body }), ctx({ params: { resource, id } }));

  it('altera preço e duração e o próximo agendamento já usa os valores novos', async () => {
    expect((await patchCatalog('services', 'sobrancelhas', { price: 18, duration: 20 })).status).toBe(200);
    const res = await book(booking({ services: ['sobrancelhas'], time: '11:00', barberId: 'yago' }));
    expect(res.booking).toMatchObject({ price: 18, duration: 20 });
    expect((await patchCatalog('services', 'sobrancelhas', { duration: 7 })).status).toBe(422);
  });

  it('barbeiro com jornada própria, serviço que não faz e preço próprio', async () => {
    const schedule = [null, null, { start: '13:30', end: '20:00' }, null, null, null, null];
    expect((await patchCatalog('barbers', 'victor', { schedule, skipServices: ['platinado'], prices: { barba: 50 } })).status).toBe(200);
    const tue = await slotsOf({ day: TUE, services: 'barba', barber: 'victor' });
    expect(tue.slots[0].time).toBe('15:00'); // bloqueio das 13:30–15:00 continua valendo
    expect(tue.prices.victor).toBe(50);
    expect((await slotsOf({ day: WED, services: 'barba', barber: 'victor' })).slots).toEqual([]);
    expect((await slotsOf({ day: TUE, services: 'platinado', barber: 'victor' })).status).toBe(422);
    const bad = await patchCatalog('barbers', 'victor', { schedule: [null, null, { start: '20:00', end: '13:00' }, null, null, null, null] });
    expect(bad.status).toBe(422);
  });

  it('cria barbeiro e serviço; barbeiro com histórico não pode ser excluído', async () => {
    const create = (resource, body) => adminCatalog(req('POST', `/api/admin/catalog/${resource}`, { token: owner, body }), ctx({ params: { resource } }));
    expect((await create('barbers', { id: 'kauan', name: 'Kauan', color: '#336699' })).status).toBe(201);
    expect((await create('services', { id: 'freestyle', name: 'Desenho freestyle', category: 'cabelo', price: 20, duration: 15 })).status).toBe(201);
    expect((await create('services', { id: 'x', name: 'Inválido', category: 'cabelo', price: 1, duration: 15 })).status).toBe(422);
    expect((await create('barbers', { id: 'foto_ruim', name: 'Foto', photo: 'https://evil.com/x.png' })).status).toBe(422);
    const del = await adminCatalog(req('DELETE', '/api/admin/catalog/barbers/daniel', { token: owner }), ctx({ params: { resource: 'barbers', id: 'daniel' } }));
    expect(del.status).toBe(409);
    const delNew = await adminCatalog(req('DELETE', '/api/admin/catalog/barbers/kauan', { token: owner }), ctx({ params: { resource: 'barbers', id: 'kauan' } }));
    expect(delNew.status).toBe(200);
  });

  it('valida horários e regras da agenda online', async () => {
    const patchStore = (body) => adminStore(req('PATCH', '/api/admin/store', { token: owner, body }), ctx());
    const hours = Array(7).fill({ open: '09:00', close: '20:00' });
    expect((await patchStore({ hours: hours.map((h, i) => (i === 3 ? { open: '20:00', close: '09:00' } : h)) })).status).toBe(422);
    expect((await patchStore({ hours: hours.map((h, i) => (i === 3 ? { ...h, breakStart: '08:00', breakEnd: '09:30' } : h)) })).status).toBe(422);
    expect((await patchStore({ slotInterval: 7 })).status).toBe(422);
    expect((await patchStore({ instagram: 'https://www.instagram.com/barbeariahanoff/' })).status).toBe(200);
    expect((await getStoreSettings(db)).instagram).toBe('barbeariahanoff');
    expect((await patchStore({ mapsUrl: 'https://evil.example.com/maps' })).status).toBe(422);
  });
});

describe('app de gestão: caixa e financeiro', () => {
  it('abre o caixa, entra o atendimento concluído e fecha conferindo o dinheiro', async () => {
    const cash = (action, body) => adminCash(req('POST', `/api/admin/cash/${action}`, { token: owner, body }), ctx({ params: { action } }));
    expect((await cash('open', { amount: 100 })).status).toBe(200);
    const created = await read(await adminAppointments(req('POST', '/api/admin/appointments', { token: owner, body: { customer: { name: 'Caixa' }, services: ['corte_barba'], barberId: 'renan', day: today, time: '06:00' } }), ctx()));
    const id = String(created.appointment.id);
    await adminAppointments(req('PATCH', `/api/admin/appointments/${id}`, { token: owner, body: { status: 'concluido', paymentMethod: 'dinheiro', paidAmount: '100,00' } }), ctx({ params: { id } }));
    await cash('movement', { kind: 'sangria', amount: 30, description: 'Troco' });
    const overview = await read(await adminCash(req('GET', '/api/admin/cash', { token: owner }), ctx()));
    expect(overview.current).toMatchObject({ services: 1, revenue: 100, expectedCash: 170 });
    expect(overview.current.byPayment.dinheiro).toEqual({ services: 1, total: 100 });
    const closed = await read(await cash('close', { countedAmount: 165 }));
    expect(closed.closed.difference).toBe(-5);
  });

  it('lança despesa e calcula o resultado do mês com as comissões', async () => {
    await adminCatalog(req('PATCH', '/api/admin/catalog/barbers/renan', { token: owner, body: { commissionPercent: 50 } }), ctx({ params: { resource: 'barbers', id: 'renan' } }));
    const expense = await adminFinance(req('POST', '/api/admin/finance/expenses', { token: owner, body: { date: today, category: 'Aluguel', amount: '40,00' } }), ctx());
    expect(expense.status).toBe(201);
    const month = await read(await adminFinance(req('GET', `/api/admin/finance?month=${today.slice(0, 7)}`, { token: owner }), ctx()));
    // o atendimento concluído na terça de teste entra se cair neste mesmo mês
    const revenue = 100 + (TUE.slice(0, 7) === today.slice(0, 7) ? 45 : 0);
    expect(month).toMatchObject({ revenue, expenses: 40, result: revenue - 40, commissions: 50 });
    expect(month.byBarber[0]).toMatchObject({ name: 'Renan', commission: 50 });
  });

  it('gera o relatório de atendimentos', async () => {
    const r = await read(await reports(req('GET', `/api/admin/reports?from=${today}&to=${addDays(today, 10)}`, { token: owner }), ctx()));
    expect(r.summary.services).toBe(2);
    expect(r.summary.noShows).toBe(1);
    expect(r.topServices.map(s => s.name)).toContain('Corte e barba');
    expect(r.byPayment[0].key).toBe('dinheiro');
  });

  it('registra as alterações no histórico da equipe', async () => {
    const { entries } = await read(await adminStaff(req('GET', '/api/admin/staff?audit=1', { token: owner }), ctx()));
    const actions = entries.map(e => e.action);
    expect(actions).toEqual(expect.arrayContaining(['servico.editar', 'barbeiro.editar', 'loja.pausar', 'caixa.close', 'despesa.criar', 'agenda.remarcar', 'bloqueio.criar']));
  });
});

describe('Função única da Vercel (api/router.js)', () => {
  // o setup dos testes recria os módulos depois de cada teste: o roteador e o banco são
  // importados juntos aqui (mesmo grafo de módulos) e usados por todos os testes do bloco
  let routerModule;
  beforeAll(async () => {
    routerModule = await import('../api/router.js');
    (await import('../server/db.js')).setDb(db);
  });
  const router = (request) => routerModule.GET(request);
  const call = (path, init) => routerModule[init?.method || 'GET'](new Request(BASE + path, init));

  it('roteia /api/* reescrito com ?__route= e mantém a query original', async () => {
    const res = await router(new Request(`${BASE}/api/router?__route=availability&services=corte&day=${TUE}`));
    expect(res.status).toBe(200);
    expect((await res.json()).slots.length).toBeGreaterThan(0);
  });

  it('extrai parâmetros da rota e repassa corpo e método', async () => {
    const created = await (await call('/api/router?__route=bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(booking({ day: WED, time: '19:30' })) })).json();
    const view = await call(`/api/router?__route=bookings/${created.token}`);
    expect(view.status).toBe(200);
    expect((await view.json()).time).toBe('19:30');
  });

  it('responde 404 para rota desconhecida', async () => {
    expect((await router(new Request(`${BASE}/api/router?__route=nada`))).status).toBe(404);
  });
});

describe('proteções da revisão de segurança', () => {
  const raw = (handler, method, path, body, { token, ...extra } = {}) => handler(new Request(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  }), ctx(extra));

  it('corpo que não é um objeto JSON é recusado com 400 (e não vira erro interno)', async () => {
    expect((await raw(bookingsApi, 'POST', '/api/bookings', '[]')).status).toBe(400);
    expect((await raw(adminStore, 'PATCH', '/api/admin/store', 'null', { token: owner })).status).toBe(400);
  });

  it('link com token inválido ou desconhecido dá 404', async () => {
    const get = (token) => bookingsApi(new Request(`${BASE}/api/bookings/${token}`), ctx({ params: { token } }));
    expect((await get('curto')).status).toBe(404);
    expect((await get('a'.repeat(24))).status).toBe(404);
  });

  it('senhas fáceis de adivinhar são recusadas', async () => {
    for (const password of ['1234567890', 'aaaaaaaaaaaa', 'abcdefghijk', 'hanoff2026!!', 'maria-12345678']) {
      const res = await adminStaff(req('POST', '/api/admin/staff', { token: owner, body: { username: 'maria', role: 'recepcao', password } }), ctx());
      expect(res.status, password).toBe(422);
    }
  });

  it('muitas senhas erradas contra o mesmo usuário bloqueiam, mesmo vindo de IPs diferentes', async () => {
    await adminStaff(req('POST', '/api/admin/staff', { token: owner, body: { username: 'caixa2', role: 'recepcao', password: 'gaveta-azul-77' } }), ctx());
    for (let i = 0; i < 20; i++) {
      const res = await session(post('/api/admin/session', { username: 'caixa2', password: 'errada-000' }), ctx({ ip: `10.9.${i}.1` }));
      expect(res.status).toBe(401);
    }
    const blocked = await session(post('/api/admin/session', { username: 'caixa2', password: 'gaveta-azul-77' }), ctx({ ip: '10.9.99.1' }));
    expect(blocked.status).toBe(429);
    expect((await login('bia', 'cadeira-giratoria-42')).status).toBe(200); // os outros seguem entrando
  });

  it('senha no formato antigo é refeita no login certo, sem derrubar a sessão', async () => {
    const crypto = await import('crypto');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync('navalha-afiada-987', salt, 64, { N: 16384, r: 8, p: 1 });
    await db.query("INSERT INTO staff_users (username, password_hash, display_name, role) VALUES ('velho', $1, 'Velho', 'recepcao')",
      [`scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`]);
    expect((await login('velho', 'navalha-afiada-987')).status).toBe(200);
    const [row] = await db.query("SELECT password_hash, session_version FROM staff_users WHERE username = 'velho'");
    expect(row.password_hash.split('$')).toHaveLength(6);
    expect(row.session_version).toBe(1);
  });

  it('dono encerra as sessões de um usuário', async () => {
    const reception = (await login('bia', 'cadeira-giratoria-42')).token;
    expect((await adminAppointments(req('GET', '/api/admin/appointments', { token: reception }), ctx())).status).toBe(200);
    const res = await adminStaff(req('PATCH', '/api/admin/staff/bia', { token: owner, body: { revokeSessions: true } }), ctx({ params: { username: 'bia' } }));
    expect(res.status).toBe(200);
    expect((await adminAppointments(req('GET', '/api/admin/appointments', { token: reception }), ctx())).status).toBe(401);
  });

  it('texto do cliente chega limpo (sem caracteres de controle nem inversão de direção)', async () => {
    const name = 'Ana ‮abc‬\u0007 Souza';
    const res = await book(booking({ day: WED, time: '19:00', customer: { name, phone: newPhone() } }));
    const [row] = await db.query('SELECT customer_name FROM appointments WHERE token = $1', [res.token]);
    expect(row.customer_name).toBe('Ana abc Souza');
  });

  it('datas que não existem no calendário são recusadas', async () => {
    expect((await reports(req('GET', '/api/admin/reports?from=2026-02-31&to=2026-03-01', { token: owner }), ctx())).status).toBe(422);
    const expense = await adminFinance(req('POST', '/api/admin/finance/expenses', { token: owner, body: { date: '2026-02-30', category: 'Outros', amount: 10 } }), ctx());
    expect(expense.status).toBe(422);
  });

  it('o registro de alterações corta textos longos e listas grandes', async () => {
    const { audit } = await import('../server/auth.js');
    await audit(db, 'dono', 'teste.longo', { notes: 'x'.repeat(5000), lista: Array(100).fill('a') });
    const [row] = await db.query("SELECT details FROM audit_log WHERE action = 'teste.longo'");
    expect(row.details.notes).toHaveLength(300);
    expect(row.details.lista).toHaveLength(30);
  });
});
