// Tabela de rotas da API para hospedagens que usam uma função só (Vercel).
// No Netlify cada arquivo de netlify/functions é publicado sozinho pelo seu config.path.
// Ao criar uma função nova em netlify/functions/, inclua-a aqui também.
import { json } from './http.js';
import { matchPath } from './route-pattern.js';
import * as adminAppointments from '../netlify/functions/admin-appointments.js';
import * as adminAvailability from '../netlify/functions/admin-availability.js';
import * as adminBlocks from '../netlify/functions/admin-blocks.js';
import * as adminCash from '../netlify/functions/admin-cash.js';
import * as adminCatalog from '../netlify/functions/admin-catalog.js';
import * as adminClients from '../netlify/functions/admin-clients.js';
import * as adminFinance from '../netlify/functions/admin-finance.js';
import * as adminReports from '../netlify/functions/admin-reports.js';
import * as adminSession from '../netlify/functions/admin-session.js';
import * as adminStaff from '../netlify/functions/admin-staff.js';
import * as adminStore from '../netlify/functions/admin-store.js';
import * as availability from '../netlify/functions/availability.js';
import * as bookings from '../netlify/functions/bookings.js';
import * as catalog from '../netlify/functions/catalog.js';

const MODULES = [adminAppointments, adminAvailability, adminBlocks, adminCash, adminCatalog, adminClients, adminFinance,
  adminReports, adminSession, adminStaff, adminStore, availability, bookings, catalog];

export async function routeRequest(request, { ip, pathname = new URL(request.url).pathname } = {}) {
  for (const mod of MODULES) {
    const params = matchPath(mod.config.path, pathname);
    if (params) return mod.default(request, { params, ip });
  }
  return json({ error: 'Rota não encontrada' }, 404);
}
