// Agendamento pelo site
//   POST /api/bookings                 cria o agendamento (o servidor confere serviço, barbeiro e horário)
//   GET  /api/bookings/:token          link do cliente (sem telefone nem anotações da equipe)
//   POST /api/bookings/:token/cancel   o cliente cancela (até o prazo definido no app)
import { getDb } from '../../server/db.js';
import { handle, json, readJson, clientIpHash, methodNotAllowed, HttpError } from '../../server/http.js';
import { getStoreSettings } from '../../server/catalog.js';
import {
  createBooking, findByClientRef, parseClientRef, findByToken, toPublicBooking, cancelByClient, appointmentCode,
} from '../../server/appointments.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
const NOT_FOUND = 'Agendamento não encontrado';

// Mesmo formato para agendamento novo e para reenvio (clientRef repetido)
async function created(db, row, status) {
  const settings = await getStoreSettings(db);
  return json({ id: Number(row.id), code: appointmentCode(row.id), token: row.token, booking: toPublicBooking(row, settings) }, status);
}

export default handle(async (req, context) => {
  const db = getDb();
  const { token, action } = context.params || {};

  if (!token) {
    if (req.method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readJson(req);
    // o navegador reenviou um agendamento que já tinha chegado (resposta perdida no caminho)
    const previous = await findByClientRef(db, parseClientRef(body.clientRef));
    if (previous) return created(db, previous, 200);
    const { row, replay } = await createBooking(db, body, { ipHash: clientIpHash(req, context) });
    return created(db, row, replay ? 200 : 201);
  }

  if (!TOKEN_RE.test(token)) return json({ error: NOT_FOUND }, 404);
  const row = await findByToken(db, token);
  if (!row) return json({ error: NOT_FOUND }, 404);
  const settings = await getStoreSettings(db);

  if (!action) {
    if (req.method !== 'GET') return methodNotAllowed(['GET']);
    return json(toPublicBooking(row, settings));
  }
  if (action !== 'cancel') throw new HttpError(404, 'Rota não encontrada');
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  return json(toPublicBooking(await cancelByClient(db, row, settings), settings));
});

export const config = { path: ['/api/bookings', '/api/bookings/:token', '/api/bookings/:token/:action'] };
