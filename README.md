# Barbearia Hanoff

Site de agendamento online da Barbearia Hanoff (R. Florianópolis, 3001 — Fátima, Joinville/SC) e **Hanoff Gestão**, o app de Windows que a equipe usa para administrar a agenda e a barbearia.

| Pasta | O que é |
|---|---|
| `site/` | Site dos clientes: serviços e valores, barbeiros, agendamento em 4 passos e a página do agendamento (`/agendamento/`) para ver ou cancelar. Vite + JavaScript puro + GSAP |
| `app/` | App de gestão para Windows (Electron): agenda por barbeiro em tempo real, histórico, clientes, serviços e barbeiros, barbearia (horários e regras), caixa, financeiro e equipe |
| `server/`, `netlify/functions/`, `api/` | API usada pelo site e pelo app. Na Vercel, tudo passa por `api/router.js` (rotas em `server/routes.js`); o Netlify usa cada arquivo de `netlify/functions/` direto |
| `db/` | Schema do banco (Neon/Postgres) e dados iniciais (`db/seed/`) |
| `shared/` | Regras usadas pelos dois lados: horário de funcionamento, cálculo de horários livres, serviços e preços |
| `tests/` | Testes unitários, da API (Postgres em memória) e e2e do site (Playwright) |

## Comandos

```bash
npm install                 # dependências do site e da API
npm run dev                 # site + API em http://localhost:3000
npm test                    # testes unitários e da API
npm run test:e2e            # testes do site no navegador
npm run lint
npm run build               # gera site/dist (publicado pela Vercel ou Netlify)
npm run icons               # refaz os ícones (site e app) a partir de site/public/images/emblema.svg

npm run app:install         # dependências do app (uma vez)
npm --prefix app run dev    # abre o app apontando para http://localhost:3000
npm run app:dist            # gera o instalador em app/dist/

npm run db:migrate          # cria/atualiza as tabelas no Neon (DATABASE_URL no .env.local)
npm run staff:add -- nome   # cria o primeiro dono
```

Sem `DATABASE_URL`, o `npm run dev` usa um Postgres local de teste em `.data/`. Com `DATABASE_URL` no `.env.local`, ele usa o banco real.

## Documentação

- [Sistema de agendamento e gestão](docs/sistema-de-agendamentos.md): configuração do Neon, publicação na Vercel, papéis da equipe, como funcionam a agenda e os horários livres, e segurança.
