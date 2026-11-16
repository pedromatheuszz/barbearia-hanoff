// /api/admin/catalog — serviços e barbeiros para o app de gestão
//   GET                          serviços, barbeiros e configurações
//   POST   /:resource            cria (services | barbers)
//   PATCH  /:resource/:id        altera
//   DELETE /:resource/:id        remove (barbeiro com agendamentos: desative em vez de excluir)
import { getDb } from '../../server/db.js';
import { handle, json, readJson, methodNotAllowed, HttpError } from '../../server/http.js';
import { requireStaff, requirePermission, audit } from '../../server/auth.js';
import { getFullCatalog, validateService, validateBarber, upsertService, upsertBarber } from '../../server/catalog.js';

const RESOURCES = {
  services: { table: 'services', validate: validateService, save: upsertService, label: 'servico', name: 'serviço' },
  barbers: { table: 'barbers', validate: validateBarber, save: upsertBarber, label: 'barbeiro', name: 'barbeiro' },
};

export default handle(async (req, context) => {
  const db = getDb();
  const { resource, id } = context.params || {};
  // login antes de qualquer consulta
  const staff = await requireStaff(req, db, 'agenda.view');

  if (!resource) {
    if (req.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await getFullCatalog(db));
  }

  const r = Object.hasOwn(RESOURCES, resource) ? RESOURCES[resource] : null; // nada de "constructor", "__proto__"
  if (!r) throw new HttpError(404, 'Rota não encontrada');
  const user = requirePermission(staff, 'catalog.edit');
  const items = (await getFullCatalog(db))[resource];

  if (!id) {
    if (req.method !== 'POST') return methodNotAllowed(['POST']);
    const item = r.validate(await readJson(req));
    if (items.some(i => i.id === item.id)) throw new HttpError(409, `Já existe um ${r.name} com esse código`);
    await r.save(db, item);
    await audit(db, user.username, `${r.label}.criar`, { id: item.id, name: item.name });
    return json(await getFullCatalog(db), 201);
  }

  const existing = items.find(i => i.id === id);
  if (!existing) throw new HttpError(404, 'Item não encontrado');

  if (req.method === 'DELETE') {
    try {
      await db.query(`DELETE FROM ${r.table} WHERE id = $1`, [existing.id]);
    } catch {
      // o barbeiro aparece em agendamentos (histórico, caixa, comissões)
      throw new HttpError(409, `${existing.name} tem agendamentos registrados. Desative em vez de excluir.`);
    }
    await audit(db, user.username, `${r.label}.excluir`, { id: existing.id, name: existing.name });
    return json(await getFullCatalog(db));
  }
  if (req.method !== 'PATCH') return methodNotAllowed(['PATCH', 'DELETE']);

  const body = await readJson(req);
  const item = r.validate(body, existing);
  await r.save(db, item);
  // registra os campos alterados já validados (não o corpo bruto da requisição)
  const changes = Object.fromEntries(Object.keys(body).filter(k => k in item).map(k => [k, item[k]]));
  await audit(db, user.username, `${r.label}.editar`, { id: existing.id, name: item.name, changes });
  return json(await getFullCatalog(db));
});

export const config = { path: ['/api/admin/catalog', '/api/admin/catalog/:resource', '/api/admin/catalog/:resource/:id'] };
