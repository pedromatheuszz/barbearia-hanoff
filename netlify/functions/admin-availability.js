// GET /api/admin/availability?day=&services=&barber= — horários livres para a equipe agendar
// (sem a antecedência mínima nem o limite de dias do site; a pausa do site não vale para a equipe)
import { getDb } from '../../server/db.js';
import { handle, json, methodNotAllowed } from '../../server/http.js';
import { requireStaff } from '../../server/auth.js';
import { getAvailability } from '../../server/appointments.js';

export default handle(async (req) => {
  const db = getDb();
  await requireStaff(req, db, 'agenda.book');
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const params = new URL(req.url).searchParams;
  return json(await getAvailability(db, {
    day: params.get('day') || '', services: params.get('services') || '', barberId: params.get('barber') || 'any', staff: true,
  }));
});

export const config = { path: '/api/admin/availability' };
