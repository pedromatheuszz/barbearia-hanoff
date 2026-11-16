// /api/admin/devices — controle do desenvolvedor (papel "dev")
//   GET               bloqueio geral do app e computadores que já usaram o app
//   PATCH             { blocked, message }  bloqueia ou libera o app para todos (menos o desenvolvedor)
//   PATCH /:id        { blocked, note }     bloqueia ou libera um computador
//   DELETE /:id       tira da lista um computador liberado (ele volta a aparecer se usar o app de novo)
import { getDb } from '../../server/db.js';
import { handle, json, readJson, methodNotAllowed } from '../../server/http.js';
import { requireStaff, audit } from '../../server/auth.js';
import { getLicense, listDevices, setLicense, updateDevice, removeDevice } from '../../server/devices.js';

export default handle(async (req, context) => {
  const db = getDb();
  const user = await requireStaff(req, db, 'system.devices');
  const id = context.params?.id;
  const state = async () => json({ license: await getLicense(db), devices: await listDevices(db) });

  if (!id) {
    if (req.method === 'GET') return state();
    if (req.method !== 'PATCH') return methodNotAllowed(['GET', 'PATCH']);
    const body = await readJson(req);
    await setLicense(db, body, user.username);
    await audit(db, user.username, body.blocked ? 'sistema.bloquear' : 'sistema.liberar', { message: body.message });
    return state();
  }

  if (req.method === 'PATCH') {
    const changed = await updateDevice(db, id, await readJson(req));
    await audit(db, user.username, 'dispositivo.editar', changed);
    return state();
  }
  if (req.method === 'DELETE') {
    const removed = await removeDevice(db, id);
    await audit(db, user.username, 'dispositivo.remover', { name: removed.name });
    return state();
  }
  return methodNotAllowed(['PATCH', 'DELETE']);
});

export const config = { path: ['/api/admin/devices', '/api/admin/devices/:id'] };
