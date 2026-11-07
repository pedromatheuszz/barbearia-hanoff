/**
 * Gera site/src/generated/catalog.json: a cópia do catálogo (serviços, barbeiros, horários)
 * embutida no site. O site sempre busca o catálogo atualizado em /api/catalog (editado no
 * app de gestão); esta cópia só é usada se a API estiver fora do ar.
 *  - Com DATABASE_URL (build na Vercel/Netlify ou .env.local): copia do banco.
 *  - Sem DATABASE_URL: usa os dados iniciais de db/seed/.
 * Roda automaticamente antes de `npm run dev` e `npm run build`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');
const SEED = path.join(REPO, 'db/seed');
const OUT_DIR = path.join(SITE, 'src/generated');

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function fromDatabase() {
  const { loadEnv } = await import('vite');
  Object.assign(process.env, { ...loadEnv('production', REPO, ''), ...process.env });
  if (!process.env.DATABASE_URL) return null;
  try {
    const { getPublicCatalog } = await import('../../server/catalog.js');
    const catalog = await getPublicCatalog((await import('../../server/db.js')).getDb());
    delete catalog.status;
    return catalog;
  } catch (e) {
    console.warn(`! Não foi possível ler o catálogo do banco (${e.message}). Usando db/seed/.`);
    return null;
  }
}

// Mesmas validações do banco, sobre os dados de db/seed/
async function fromSeed() {
  const { validateService, validateBarber, validateStoreSettings, STORE_DEFAULTS } = await import('../../server/catalog.js');
  const services = readJSON(path.join(SEED, 'services.json')).map((s, i) => validateService({ ...s, order: (i + 1) * 10 }))
    .filter(s => s.active).map(({ active, ...s }) => s);
  const barbers = readJSON(path.join(SEED, 'barbers.json')).map((b, i) => validateBarber({ ...b, order: (i + 1) * 10 }))
    .filter(b => b.active).map(({ id, name, title, bio, photo, color, schedule, skipServices, prices, order }) => ({ id, name, title, bio, photo, color, schedule, skipServices, prices, order }));
  const store = { ...STORE_DEFAULTS, ...validateStoreSettings(readJSON(path.join(SEED, 'store.json'))) };
  // pausa não vai para a cópia do site (quem diz se está pausado é a API)
  const settings = Object.fromEntries(Object.entries(store).filter(([key]) => !['paused', 'pauseMessage'].includes(key)));
  return { services, barbers, settings };
}

const catalog = (await fromDatabase()) || (await fromSeed());
const errors = [];
if (!catalog.services.length) errors.push('nenhum serviço ativo');
if (!catalog.barbers.length) errors.push('nenhum barbeiro ativo');
if (errors.length) {
  console.error(`\n✗ Catálogo inválido: ${errors.join(', ')}\n`);
  process.exitCode = 1;
} else {
  if (!/^\d{12,13}$/.test(catalog.settings.whatsappPhone || '')) console.warn('! WhatsApp da barbearia não cadastrado: os botões de WhatsApp ficam escondidos no site.');
  // Sem process.exit(): no Windows, encerrar à força com a conexão do banco ainda fechando derruba o Node
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`✓ Catálogo gerado: ${catalog.services.length} serviços, ${catalog.barbers.length} barbeiros`);
}
