// /api/admin/blocks — bloqueios de agenda (almoço, folga, férias, curso)
//   POST         { barberId|null, day, untilDay, start, end, allDay, reason }
//   DELETE /:id
import { getDb } from '../../server/db.js';
import { handle, json, readJson, methodNotAllowed, HttpError } from '../../server/http.js';
import { requireStaff, audit } from '../../server/auth.js';
import { createBlock } from '../../server/appointments.js';

export default handle(async (req, context) => {
  const db = getDb();
  const user = await requireStaff(req, db, 'agenda.block');
  const id = context.params?.id;

  if (!id) {
    if (req.method !== 'POST') return methodNotAllowed(['POST']);
    const block = await createBlock(db, await readJson(req), user.username);
    await audit(db, user.username, 'bloqueio.criar', { barberId: block.barberId, day: block.day, untilDay: block.untilDay, reason: block.reason });
    return json({ block }, 201);
  }

  if (req.method !== 'DELETE') return methodNotAllowed(['DELETE']);
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(404, 'Bloqueio não encontrado');
  const [row] = await db.query(`DELETE FROM time_blocks WHERE id = $1 RETURNING barber_id, to_char(day, 'YYYY-MM-DD') AS day, reason`, [Number(id)]);
  if (!row) throw new HttpError(404, 'Bloqueio não encontrado');
  await audit(db, user.username, 'bloqueio.excluir', { id: Number(id), barberId: row.barber_id, day: row.day, reason: row.reason });
  return json({ ok: true });
});

export const config = { path: ['/api/admin/blocks', '/api/admin/blocks/:id'] };
