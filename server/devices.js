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
    if (error?.code === '42P01' || error?.code === '42703') {
      console.warn('[api] tabelas app_devices/app_license ausentes: rode npm run db:migrate');
      return;
    }
    throw error;
  }
}

const NEEDS_UPDATE = 'Atualize o app de gestão para a versão mais nova. Fale com o desenvolvedor do sistema.';
const NEW_DEVICE_NOTE = 'Novo: aguardando liberação';

async function checkAccess(db, req, username, role) {
  const device = readDevice(req);
  const isDev = role === DEV_ROLE;
  let row;
  if (device) {
    // Uma consulta só: registra o computador (no máximo uma gravação por minuto, o app consulta
    // a agenda a cada poucos segundos) e lê o bloqueio geral e o deste computador.
    // Com "exigir liberação", um computador novo já entra bloqueado (menos no login do desenvolvedor).
    [row] = await db.query(
      `WITH lic AS (SELECT blocked, message, approve_devices FROM app_license WHERE id = 1),
       up AS (
         INSERT INTO app_devices (id, name, app_version, last_user, blocked, note)
         SELECT $1, $2, $3, $4, p.pending, CASE WHEN p.pending THEN $6 ELSE '' END
           FROM (SELECT $5::boolean AND coalesce((SELECT approve_devices FROM lic), false) AS pending) p
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, app_version = EXCLUDED.app_version,
                last_user = EXCLUDED.last_user, last_seen = now()
          WHERE app_devices.last_seen < now() - interval '1 minute'
             OR app_devices.last_user IS DISTINCT FROM EXCLUDED.last_user
             OR app_devices.app_version <> EXCLUDED.app_version
         RETURNING blocked
       )
       SELECT (SELECT blocked FROM lic) AS app_blocked, (SELECT message FROM lic) AS app_message,
              coalesce((SELECT blocked FROM up), (SELECT blocked FROM app_devices WHERE id = $1)) AS device_blocked`,
      [device.id, device.name, device.version, username, !isDev, NEW_DEVICE_NOTE]
    );
  } else {
    [row] = await db.query('SELECT blocked AS app_blocked, message AS app_message, approve_devices FROM app_license WHERE id = 1');
  }
  if (isDev) return;
  if (row?.app_blocked) throw new HttpError(423, row.app_message || APP_BLOCKED, { blocked: 'app' });
  if (row?.device_blocked) throw new HttpError(423, DEVICE_BLOCKED, { blocked: 'device' });
  // app antigo, que não se identifica: só passa se não for exigida a liberação de cada computador
  if (!device && row?.approve_devices) throw new HttpError(423, NEEDS_UPDATE, { blocked: 'device' });
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
  const [r] = await db.query('SELECT blocked, message, approve_devices, updated_by, updated_at FROM app_license WHERE id = 1');
  return r
    ? { blocked: r.blocked, message: r.message, approveDevices: r.approve_devices, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() }
    : { blocked: false, message: '', approveDevices: false, updatedBy: null, updatedAt: null };
}

export async function listDevices(db) {
  const rows = await db.query('SELECT * FROM app_devices ORDER BY blocked DESC, last_seen DESC');
  return rows.map(toDevice);
}

/** Altera o bloqueio geral ({ blocked, message }) e/ou a exigência de liberar computadores novos ({ approveDevices }). */
export async function setLicense(db, body, actor) {
  const hasBlocked = typeof body?.blocked === 'boolean';
  const hasApprove = typeof body?.approveDevices === 'boolean';
  if (!hasBlocked && !hasApprove) throw new HttpError(422, 'Nada para alterar');
  const current = await getLicense(db);
  const blocked = hasBlocked ? body.blocked : current.blocked;
  const approve = hasApprove ? body.approveDevices : current.approveDevices;
  const message = body.message !== undefined ? String(body.message).trim().slice(0, 200) : current.message;
  await db.query(
    `INSERT INTO app_license (id, blocked, message, approve_devices, updated_by, updated_at) VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET blocked = $1, message = $2, approve_devices = $3, updated_by = $4, updated_at = now()`,
    [blocked, message, approve, actor]
  );
}

export async function updateDevice(db, id, body) {
  const [current] = await db.query('SELECT * FROM app_devices WHERE id = $1', [id]);
  if (!current) throw new HttpError(404, 'Computador não encontrado');
  const blocked = typeof body?.blocked === 'boolean' ? body.blocked : current.blocked;
  // liberar um computador novo tira o aviso "aguardando liberação"
  const note = body?.note !== undefined ? String(body.note).trim().slice(0, 120)
    : (!blocked && current.note === NEW_DEVICE_NOTE ? '' : current.note);
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
