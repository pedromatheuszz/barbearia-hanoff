// Controle do desenvolvedor sobre o app de gestão: lista os computadores que usam o app
// e bloqueia/libera um computador ou o app inteiro. O desenvolvedor nunca é bloqueado
// (assim ele sempre consegue liberar de novo).
import { HttpError } from './http.js';

const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;
export const DEV_ROLE = 'dev';
const APP_BLOCKED = 'O app está bloqueado. Fale com o desenvolvedor do sistema.';
const DEVICE_BLOCKED = 'Este computador foi bloqueado. Fale com o desenvolvedor do sistema.';

function decode(value, max) {
  try {
    return decodeURIComponent(String(value || '')).replace(/\p{Cc}/gu, '').trim().slice(0, max);
  } catch {
    return '';
  }
}

/** Identificação do computador enviada pelo app (X-Device-Id, X-Device-Name, X-App-Version). */
export function readDevice(req) {
  const id = req.headers.get('x-device-id') || '';
  if (!DEVICE_RE.test(id)) return null;
  return { id, name: decode(req.headers.get('x-device-name'), 80), version: decode(req.headers.get('x-app-version'), 20) };
}

/**
 * Registra o computador (último acesso, usuário, versão) e recusa com 423 se o app
 * ou o computador estiver bloqueado. Chamado em todo acesso da equipe.
 */
export async function enforceAccess(db, req, username, role) {
  try {
    await checkAccess(db, req, username, role);
  } catch (error) {
    // banco ainda sem as tabelas (deploy antes do "npm run db:migrate"): não derruba o app da barbearia
    if (error?.code === '42P01') {
      console.warn('[api] tabelas app_devices/app_license ausentes: rode npm run db:migrate');
      return;
    }
    throw error;
  }
}

async function checkAccess(db, req, username, role) {
  const device = readDevice(req);
  if (device) {
    // grava no máximo uma vez por minuto por computador (o app consulta a agenda a cada poucos segundos)
    await db.query(
      `INSERT INTO app_devices (id, name, app_version, last_user) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, app_version = EXCLUDED.app_version,
              last_user = EXCLUDED.last_user, last_seen = now()
        WHERE app_devices.last_seen < now() - interval '1 minute'
           OR app_devices.last_user IS DISTINCT FROM EXCLUDED.last_user
           OR app_devices.app_version <> EXCLUDED.app_version`,
      [device.id, device.name, device.version, username]
    );
  }
  if (role === DEV_ROLE) return;
  const [row] = await db.query(
    `SELECT (SELECT blocked FROM app_license WHERE id = 1) AS app_blocked,
            (SELECT message FROM app_license WHERE id = 1) AS app_message,
            (SELECT blocked FROM app_devices WHERE id = $1) AS device_blocked`,
    [device?.id ?? '']
  );
  if (row?.app_blocked) throw new HttpError(423, row.app_message || APP_BLOCKED, { blocked: 'app' });
  if (row?.device_blocked) throw new HttpError(423, DEVICE_BLOCKED, { blocked: 'device' });
}

const toDevice = (r) => ({
  id: r.id,
  name: r.name || 'Computador sem nome',
  appVersion: r.app_version,
  lastUser: r.last_user,
  blocked: r.blocked,
  note: r.note,
  firstSeen: new Date(r.first_seen).toISOString(),
  lastSeen: new Date(r.last_seen).toISOString(),
});

export async function getLicense(db) {
  const [r] = await db.query('SELECT blocked, message, updated_by, updated_at FROM app_license WHERE id = 1');
  return r
    ? { blocked: r.blocked, message: r.message, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() }
    : { blocked: false, message: '', updatedBy: null, updatedAt: null };
}

export async function listDevices(db) {
  const rows = await db.query('SELECT * FROM app_devices ORDER BY blocked DESC, last_seen DESC');
  return rows.map(toDevice);
}

export async function setLicense(db, body, actor) {
  if (typeof body?.blocked !== 'boolean') throw new HttpError(422, 'Informe se o app fica bloqueado ou liberado');
  const message = String(body.message ?? '').trim().slice(0, 200);
  await db.query(
    `INSERT INTO app_license (id, blocked, message, updated_by, updated_at) VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET blocked = $1, message = $2, updated_by = $3, updated_at = now()`,
    [body.blocked, message, actor]
  );
}

export async function updateDevice(db, id, body) {
  const [current] = await db.query('SELECT * FROM app_devices WHERE id = $1', [id]);
  if (!current) throw new HttpError(404, 'Computador não encontrado');
  const blocked = typeof body?.blocked === 'boolean' ? body.blocked : current.blocked;
  const note = body?.note !== undefined ? String(body.note).trim().slice(0, 120) : current.note;
  await db.query('UPDATE app_devices SET blocked = $2, note = $3 WHERE id = $1', [id, blocked, note]);
  return { name: current.name, blocked, note };
}

export async function removeDevice(db, id) {
  const [row] = await db.query('SELECT name, blocked FROM app_devices WHERE id = $1', [id]);
  if (!row) throw new HttpError(404, 'Computador não encontrado');
  // um computador bloqueado que some da lista voltaria liberado no próximo acesso
  if (row.blocked) throw new HttpError(409, 'Libere o computador antes de removê-lo da lista');
  await db.query('DELETE FROM app_devices WHERE id = $1', [id]);
  return row;
}
