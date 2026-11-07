// GET /api/availability?services=corte,barba&barber=any|id&day=AAAA-MM-DD — horários livres do dia
// GET /api/availability?services=corte&barber=any                    — próximos horários livres
import { getDb } from '../../server/db.js';
import { handle, json, methodNotAllowed } from '../../server/http.js';
import { getAvailability, findNextSlots } from '../../server/appointments.js';

export default handle(async (req) => {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const params = new URL(req.url).searchParams;
  const query = { services: params.get('services') || '', barberId: params.get('barber') || 'any' };
  const db = getDb();
  const data = params.has('day')
    ? await getAvailability(db, { ...query, day: params.get('day') })
    : await findNextSlots(db, { ...query, limit: Math.min(12, Number(params.get('limit')) || 6) });
  // horários mudam a cada agendamento: sem cache
  return json(data);
});

export const config = { path: '/api/availability' };
