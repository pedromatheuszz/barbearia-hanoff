// /api/admin/clients — clientes (agrupados pelo telefone)
//   GET ?q=&page=     lista com visitas, última visita, total gasto e faltas
//   GET /:phone       agendamentos do cliente
import { getDb } from '../../server/db.js';
import { handle, json, methodNotAllowed, HttpError } from '../../server/http.js';
import { requireStaff } from '../../server/auth.js';
import { listClients, clientHistory } from '../../server/appointments.js';

export default handle(async (req, context) => {
  const db = getDb();
  await requireStaff(req, db, 'clients.view');
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const phone = context.params?.phone;
  if (phone) {
    if (!/^\d{10,13}$/.test(phone)) throw new HttpError(404, 'Cliente não encontrado');
    return json(await clientHistory(db, phone));
  }
  const params = new URL(req.url).searchParams;
  return json(await listClients(db, { q: params.get('q') || '', page: params.get('page') || 1 }));
});

export const config = { path: ['/api/admin/clients', '/api/admin/clients/:phone'] };
