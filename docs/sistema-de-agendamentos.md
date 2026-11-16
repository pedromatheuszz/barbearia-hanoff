# Sistema de agendamento e gestão

O projeto tem três partes:

| Pasta | O que é | Para quem |
|---|---|---|
| `site/` | Site de agendamento (serviços, barbeiros, agendamento em 4 passos, página `/agendamento/` para ver ou cancelar) | Clientes |
| `app/` | **Hanoff Gestão**, um programa de Windows para administrar a barbearia | Dono, recepção e barbeiros |
| `server/`, `netlify/functions/`, `api/`, `db/` | API e banco **Neon (Postgres)**, usados pelo site e pelo app | — |
| `shared/` | Regras usadas pelos dois lados (horários, horários livres, preços) | — |

O site e a API são publicados juntos na **Vercel** (o projeto também continua pronto para o Netlify). O app é instalado no computador da barbearia e conversa com a API do site pela internet.

## Dados iniciais

Os dados de `db/seed/` foram copiados do perfil da barbearia no Google Maps e da página dela no AppBarber (novembro de 2026):

- **Serviços e valores**: os 23 serviços do AppBarber, com preço e duração. Os serviços "com RENAN" viraram **preço próprio do Renan** (corte R$ 55, barba R$ 45, combos mais caros); os demais barbeiros cobram o preço padrão.
- **Barbeiros**: Daniel, Gabriel, Renan, Victor e Yago, todos seguindo o horário da barbearia (ajuste a jornada de cada um no app).
- **Horário** (Google Maps): seg 13:30–20:00; ter a sex 09:00–12:00 e 13:30–20:00; sáb 08:00–12:00 e 13:00–18:00; domingo fechado.
- **Contato**: WhatsApp (47) 99771-5710, Instagram @barbeariahanoff, link do Google Maps.

O WhatsApp (47) 99771-5710 e os horários do Google foram confirmados (o AppBarber mostra outro número e horários um pouco diferentes, que não são usados). Se algo mudar, corrija no app, em **Barbearia** e **Serviços**, sem mexer no código. Depois que o banco existe, quem manda é o app: rodar `npm run db:migrate` de novo não sobrescreve nada.

A nota do Google (4,9, 137 avaliações) está fixa em `site/index.html`, com link para as avaliações. Depoimentos de clientes não foram copiados; para colocar no site, use textos autorizados.

## O que o app de gestão faz

| Tela | O que faz | Quem acessa |
|---|---|---|
| Agenda | Uma coluna por barbeiro com os agendamentos no horário, almoço e folgas hachurados, linha do "agora", lista do que chegou pelo site para confirmar, som e notificação do Windows. Clicar num horário vazio agenda ali | Todos |
| Detalhe do agendamento | Confirmar (com mensagem pronta no WhatsApp do cliente), iniciar, concluir com forma de pagamento e valor recebido, remarcar, "não compareceu", cancelar com motivo, observações e histórico de quem mudou cada status | Todos (cancelar: dono e recepção) |
| Novo agendamento / encaixe | Cliente pelo telefone ou na cadeira agora, serviços, barbeiro, horários livres ou horário digitado | Todos |
| Bloquear horário | Almoço, folga, férias, curso: de um barbeiro ou da barbearia toda, por horário ou dia inteiro, de um dia até outro | Dono, recepção |
| Histórico | Busca por período, nome, telefone, nº, status e barbeiro, com exportação em CSV | Dono, recepção |
| Clientes | Visitas, última visita (quem anda sumido), próximo horário, faltas, barbeiro de sempre e total gasto | Dono, recepção |
| Serviços | Preço, duração (ocupa a agenda), "a partir de", selo, ativo no site | Todos veem; editar: dono |
| Barbeiros | Jornada da semana (ou o horário da barbearia), serviços que faz, preço próprio, comissão, cor na agenda | Todos veem; editar: dono |
| Barbearia | Pausar a agenda online, dados de contato, horário com almoço, regras do site (intervalo dos horários, antecedência mínima, dias à frente, prazo para cancelar) | Pausar: dono e recepção; editar: dono |
| Caixa | Abertura com troco, sangria/suprimento, atendimentos por forma de pagamento, fechamento com conferência do dinheiro | Dono, recepção |
| Financeiro | Resultado do mês, comissão estimada por barbeiro, despesas por categoria e relatório (serviços mais feitos, por barbeiro, pagamento, dias e horários, faltas) | Dono |
| Equipe | Usuários, papéis (dono, recepção, barbeiro), desativar acesso, encerrar sessões e registro de alterações | Dono |
| Ajustes | Som, avisos de outros dias, tema, servidor e iniciar com o Windows | Cada computador |

Tudo o que é alterado no app vale **na hora** no site: preços, durações, barbeiros, horários, bloqueios e pausa. O site busca o catálogo em `/api/catalog` ao abrir e confere mudanças a cada 2 minutos; os horários livres são consultados na hora em `/api/availability`. Se a API demorar (o banco gratuito do Neon "acorda" em alguns segundos), o site abre com a cópia feita no último build e se atualiza sozinho.

## Como a agenda funciona

- **Horários livres** = horário da barbearia (sem o almoço) ∩ jornada do barbeiro (sem o intervalo dele) − agendamentos − bloqueios. O site oferece horários de 15 em 15 minutos (ajustável) em que o serviço inteiro cabe antes do almoço ou do fechamento.
- **Sem preferência**: o site mostra o barbeiro que vai atender junto com o horário (primeiro quem cobra menos; depois quem tem menos atendimentos no dia).
- **Dois clientes nunca ficam com o mesmo horário**: cada agendamento ocupa os blocos de 5 minutos da cadeira (tabela `appointment_slots`, com chave única) no mesmo comando que o grava. Se outro cliente confirmar o mesmo horário no mesmo segundo, o banco recusa o segundo e o site pede outro horário. Remarcar usa uma transação: se o horário novo estiver ocupado, nada muda.
- Fluxo: **Agendado pelo site (a confirmar) → Confirmado → Na cadeira → Concluído**. Também: **Não compareceu** e **Cancelado** (os dois liberam o horário). O que a equipe agenda pelo app já entra confirmado.
- O cliente recebe um link (`/agendamento/?t=...`) para pôr o horário na agenda do celular (.ics), ver o caminho, falar no WhatsApp e cancelar até X horas antes (padrão 2 h).
- Com a agenda online pausada, o site não aceita agendamentos; a equipe continua agendando pelo app (sem antecedência mínima, inclusive encaixes fora do horário).

## Configuração inicial (uma vez)

1. **Neon:** crie um projeto (região São Paulo) e copie a *Pooled connection string*.
2. **Variáveis na Vercel** (Project → Settings → Environment Variables, marcando *Production* e *Preview*; no Netlify: Site configuration → Environment variables):
   - `DATABASE_URL`: a string de conexão do Neon.
   - `SESSION_SECRET`: 32+ caracteres aleatórios. Para gerar:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Tabelas e dados iniciais:** crie um `.env.local` com o mesmo `DATABASE_URL` (veja `.env.example`) e rode:
   ```
   npm run db:migrate
   ```
4. **Primeiro dono:** a senha é pedida no terminal (mínimo 10 caracteres):
   ```
   npm run staff:add -- nome-do-dono
   ```
   Os outros usuários são criados pelo próprio app, na tela **Equipe**.
5. **Publicar o site:** veja [Publicar na Vercel](#publicar-na-vercel).
6. **Instalar o app:** gere o instalador com `npm run app:dist` (sai em `app/dist/`) e rode-o no computador da barbearia. Na tela de login, confira o servidor (padrão `https://barbearia-hanoff.vercel.app`; troque em Ajustes quando o domínio próprio for ligado).
7. **Fotos dos barbeiros (opcional):** coloque os arquivos em `site/public/images/barbeiros/` e informe o nome em **Serviços › Barbeiros › editar › Foto**. Sem foto, o site mostra a inicial na cor do barbeiro.

## Publicar na Vercel

Tudo já está configurado em `vercel.json`: build (`npm run build`), pasta publicada (`site/dist`), a API em `/api/*`, cabeçalhos de segurança (CSP, HSTS) e cache. A função roda em São Paulo (`gru1`), na mesma região do banco.

1. Na Vercel, **Add New › Project** e importe o repositório do GitHub.
2. Em *Framework Preset* deixe **Other**. Não mude build, pasta de saída nem install: o `vercel.json` já define.
3. Em *Environment Variables*, cadastre `DATABASE_URL` e `SESSION_SECRET` (os mesmos do `.env.local`). Elas precisam existir também no build, para o site sair com o catálogo atual.
4. **Deploy.** Depois, em *Settings › Domains*, ligue o domínio próprio. Com o domínio ligado, o próximo deploy já usa ele no canonical, no sitemap e na prévia de link do WhatsApp (variável `VERCEL_PROJECT_PRODUCTION_URL` da Vercel); no Netlify, ou para forçar outro endereço, cadastre `SITE_URL`.
5. Teste `https://<seu-endereço>/api/catalog` (deve responder com os serviços) e faça login no app apontando para esse endereço.

Como funciona: a Vercel não usa as rotas de cada arquivo de `netlify/functions/`. O `vercel.json` manda todo `/api/*` para uma função só, `api/router.js`, que escolhe a função certa pela tabela de `server/routes.js`. As funções são as mesmas nas duas hospedagens. **Ao criar uma função nova em `netlify/functions/`, inclua-a também em `server/routes.js`.**

**Banco ao atualizar o código:** quando uma versão nova muda o `db/schema.sql`, rode `npm run db:migrate` antes do deploy. As mudanças só acrescentam colunas e tabelas, então a versão que está no ar continua funcionando.

## Instalar e atualizar o app

O app é distribuído pelo instalador `.exe`, sem assinatura digital.

**Instalar**
1. Gere o instalador: `npm run app:dist` (sai em `app/dist/Hanoff Gestão Setup <versão>.exe`).
2. Leve o arquivo ao computador da barbearia e abra.
3. Como o instalador não é assinado, o Windows mostra "O Windows protegeu o computador". Clique em **Mais informações** › **Executar assim mesmo**. Isso só acontece na instalação.
4. Na tela de login, confira o endereço do servidor (link "alterar servidor").

**Atualizar**
1. Aumente `version` em `app/package.json` (ex.: 1.0.0 → 1.0.1) e gere o instalador de novo.
2. Rode o instalador novo por cima do antigo. As configurações (som, servidor) são mantidas; pode ser preciso entrar de novo.

## Desenvolvimento local

```
npm install
npm run dev            # site + API em http://localhost:3000 (banco local PGlite em .data/)
npm run app:install    # uma vez: dependências do app (Electron)
npm --prefix app run dev   # abre o app já apontando para http://localhost:3000
```

Sem `DATABASE_URL`, a API usa um Postgres local em `.data/dev-db` com o usuário de teste do `.env.example` (papel dono). Para zerar os dados locais, apague a pasta `.data/`.

Na primeira instalação, o npm pode bloquear o script de instalação do Electron (ele já está liberado em `app/package.json`, em `allowScripts`). Se `app/node_modules/electron/dist` não existir, rode `node app/node_modules/electron/install.js`.

## Segurança

**API e banco**
- Preço, duração, horários livres, jornada dos barbeiros e bloqueios são conferidos no servidor a partir do banco. O que o navegador envia (preço, barbeiro "livre") é só um pedido.
- O mesmo horário não vai para dois clientes: a chave única de `appointment_slots` garante isso no próprio banco.
- Toda consulta ao banco é parametrizada. A API só aceita JSON de até 32 KB, e um corpo que não seja um objeto é recusado.
- Textos digitados pelo cliente (nome, observações) chegam limpos: sem caracteres de controle nem as marcas de direção do Unicode que disfarçam o que aparece na tela e no WhatsApp.
- O mesmo agendamento reenviado (rede lenta, clique duplo) devolve o que já foi criado, sem duplicar.
- Limites: 3 horários marcados ao mesmo tempo por WhatsApp; 6 agendamentos do mesmo IP em 10 minutos; 10 logins errados por IP ou 20 contra o mesmo usuário em 15 minutos. IPs e usuários ficam guardados só como hash.
- O link do cliente usa um token aleatório e não mostra telefone nem as observações da equipe. Cancelar pelo link só vale até o prazo definido no app.
- As rotas da equipe pedem login antes de qualquer consulta. O registro de alterações guarda só campos conhecidos (nunca senhas), com textos e listas cortados.

**Equipe e senhas**
- Senhas guardadas com scrypt no custo recomendado pela OWASP (N = 2^17). Senhas com menos de 10 caracteres, sequências, repetições, o nome da barbearia ou do usuário são recusadas.
- O login responde igual para usuário inexistente e senha errada, inclusive no tempo de resposta.
- O app recebe um token assinado com `SESSION_SECRET` (14 horas, renovado a cada 30 minutos com o app aberto), guardado criptografado pelo Windows quando "Manter conectado" está marcado.
- A cada requisição a API confere se o usuário continua ativo e com o mesmo papel. Desativar alguém, trocar a senha ou usar **Equipe › editar › Encerrar sessões** derruba os logins abertos na hora.
- Cada papel só acessa o que precisa (ver tabela acima). As permissões são checadas no servidor, não só escondidas na tela.

**Site**
- Cabeçalhos em todas as páginas: CSP sem scripts de fora nem inline, `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP e CORP. A API e `/agendamento/` levam `noindex`.
- O build não publica source maps, e o service worker nunca guarda respostas da API.

**App de gestão**
- Roda isolado: sem Node na interface, `sandbox`, `contextIsolation` e CSP própria.
- O processo principal só atende chamadas vindas da própria interface (`app://gestao`), só fala com `/api/admin/*` do servidor configurado (https), sem seguir redirecionamentos, e só abre no navegador o WhatsApp, o próprio site e o link do mapa.
- Nenhuma janela do app navega para fora, abre outra janela ou embute `<webview>`. Câmera, microfone, localização e afins são negados.
- No instalador, as ferramentas de desenvolvedor ficam desligadas e os *fuses* do Electron travados.
- O CSV exportado no Histórico neutraliza fórmulas digitadas por clientes (proteção contra *CSV injection* no Excel).
