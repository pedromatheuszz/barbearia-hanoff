// /api/admin/appointments — agenda da equipe
//   GET ?day=AAAA-MM-DD                         agenda do dia (agendamentos, bloqueios, aguardando confirmação)
//   GET ?from=&to=&q=&status=&barber=&page=     busca no histórico
//   POST                                        agendamento pela equipe (telefone, encaixe, cliente na cadeira)
//   GET   /:id                                  detalhe com histórico de status
//   PATCH /:id  { status, cancelReason, paymentMethod, paidAmount } | { notes } | { paymentMethod, paidAmount }
//   POST  /:id/reschedule { day, time, barberId }
import { getDb } from '../../server/db.js';
import { handle, json, readJson, methodNotAllowed, HttpError } from '../../server/http.js';
import { requireStaff, requirePermission, audit } from '../../server/auth.js';
import {
  getDayBoard, searchAppointments, createByStaff, getDetail, updateStatus, updatePayment, updateNotes, reschedule,
} from '../../server/appointments.js';
import { parseRange } from '../../server/reports.js';
import { isRealDate } from '../../shared/schedule.js';
import { saoPauloParts } from '../../shared/store-hours.js';

export default handle(async (req, context) => {
  const db = getDb();
  const { id, action } = context.params || {};
  // login antes de qualquer consulta
  const staff = await requireStaff(req, db, 'agenda.view');

  if (!id) {
    if (req.method === 'POST') {
      const user = requirePermission(staff, 'agenda.book');
      const appointment = await createByStaff(db, await readJson(req), user.username);
      await audit(db, user.username, 'agenda.criar', { code: appointment.code, name: appointment.customerName, day: appointment.day, start: appointment.start, barber: appointment.barberName });
      return json({ appointment }, 201);
    }
    if (req.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
    const params = new URL(req.url).searchParams;
    if (params.has('from') || params.has('q')) {
      requirePermission(staff, 'agenda.history');
      const range = parseRange(params);
      return json(await searchAppointments(db, {
        ...range, q: params.get('q') || '', status: params.get('status') || '', barber: params.get('barber') || '', page: params.get('page') || 1,
      }));
    }
    const day = params.get('day') || saoPauloParts().day;
    if (!isRealDate(day)) throw new HttpError(422, 'Data inválida');
    return json({ ...(await getDayBoard(db, day)), serverTime: new Date().toISOString() });
  }

  if (!/^\d{1,12}$/.test(id)) throw new HttpError(404, 'Agendamento não encontrado');
  const appointmentId = Number(id);

  if (action) {
    if (action !== 'reschedule') throw new HttpError(404, 'Rota não encontrada');
    if (req.method !== 'POST') return methodNotAllowed(['POST']);
    const user = requirePermission(staff, 'agenda.book');
    const appointment = await reschedule(db, appointmentId, await readJson(req), user.username);
    await audit(db, user.username, 'agenda.remarcar', { code: appointment.code, day: appointment.day, start: appointment.start, barber: appointment.barberName });
    return json({ appointment });
  }

  if (req.method === 'GET') return json({ appointment: await getDetail(db, appointmentId) });
  if (req.method !== 'PATCH') return methodNotAllowed(['GET', 'PATCH']);

  const body = await readJson(req);
  if (body.status) {
    const user = requirePermission(staff, body.status === 'cancelado' ? 'agenda.cancel' : 'agenda.status');
    return json({ appointment: await updateStatus(db, appointmentId, body.status, user.username, body) });
  }
  if (body.notes !== undefined) {
    requirePermission(staff, 'agenda.book');
    return json({ appointment: await updateNotes(db, appointmentId, body.notes) });
  }
  if (body.paymentMethod !== undefined || body.paidAmount !== undefined) {
    const user = requirePermission(staff, 'cash.operate');
    const appointment = await updatePayment(db, appointmentId, body, user.username);
    await audit(db, user.username, 'agenda.pagamento', { code: appointment.code, paymentMethod: appointment.paymentMethod, paidAmount: appointment.paidAmount });
    return json({ appointment });
  }
  throw new HttpError(422, 'Nada para alterar');
});

export const config = { path: ['/api/admin/appointments', '/api/admin/appointments/:id', '/api/admin/appointments/:id/:action'] };
