// Acesso ao banco. Em produção usa o Neon (DATABASE_URL); em desenvolvimento e nos
// testes um adaptador local (PGlite) é injetado via setDb().
// Adaptador: { query(texto, parâmetros) → linhas, transaction([[texto, parâmetros], ...]) → [linhas, ...] }.
// Na transação vale tudo ou nada: se um comando falha, nenhum dos anteriores fica gravado.
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

let adapter = null;

const isTransient = (error) => !error?.code && /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error?.message || error));

export function setDb(db) {
  adapter = db;
}

export function getDb() {
  if (adapter) return adapter;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não configurada');
  const sql = neon(url);
  adapter = {
    query: async (text, params = []) => {
      try {
        return await sql.query(text, params);
      } catch (error) {
        // oscilação de rede até o Neon (sem código de erro do Postgres): repete uma vez, só leituras
        if (!isTransient(error) || !/^\s*SELECT\b/i.test(text)) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
        return sql.query(text, params);
      }
    },
    transaction: (steps) => sql.transaction(steps.map(([text, params = []]) => sql.query(text, params))),
  };
  return adapter;
}

/** Adaptador para o Postgres local (PGlite), usado no `npm run dev` sem DATABASE_URL e nos testes. */
export function pgliteAdapter(pg) {
  return {
    query: (text, params) => pg.query(text, params).then(r => r.rows),
    transaction: (steps) => pg.transaction(async (tx) => {
      const out = [];
      for (const [text, params = []] of steps) out.push((await tx.query(text, params)).rows);
      return out;
    }),
  };
}

// Divide o schema em comandos individuais (o driver HTTP do Neon executa um por vez)
export function schemaStatements(file = 'db/schema.sql') {
  return fs.readFileSync(file, 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

// Aplica o schema e, se o catálogo estiver vazio, os dados iniciais de db/seed/
export async function migrate(db = getDb()) {
  for (const statement of schemaStatements()) await db.query(statement);
  const { seedCatalog } = await import('./catalog.js');
  await seedCatalog(db);
}
