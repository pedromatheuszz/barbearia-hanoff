-- Esquema do sistema de agendamentos (Neon / Postgres). Idempotente: pode rodar várias vezes.
-- Aplicar com: npm run db:migrate
-- Os dados iniciais vêm de db/seed/ (aplicados só quando as tabelas estão vazias).

-- ---------------------------------------------------------------------------
-- Serviços e barbeiros (editados no app de gestão, mostrados no site)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS services (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  price         NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  price_from    BOOLEAN NOT NULL DEFAULT false,
  duration_min  INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  description   TEXT NOT NULL DEFAULT '',
  badge         TEXT NOT NULL DEFAULT '',
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 9999,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- schedule: null = segue o horário da barbearia; ou 7 posições (0 = domingo) com
-- { start, end, breakStart, breakEnd } ou null (folga). skip_services: ids de serviços que não faz.
-- prices: preço próprio do barbeiro em alguns serviços ({ id do serviço: preço }); os demais seguem o preço do serviço.
CREATE TABLE IF NOT EXISTS barbers (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  bio                 TEXT NOT NULL DEFAULT '',
  photo               TEXT NOT NULL DEFAULT '',
  color               TEXT NOT NULL DEFAULT '#c9a46a',
  schedule            JSONB,
  skip_services       JSONB NOT NULL DEFAULT '[]',
  prices              JSONB NOT NULL DEFAULT '{}',
  commission_percent  NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (commission_percent BETWEEN 0 AND 100),
  active              BOOLEAN NOT NULL DEFAULT true,
  sort_order          INT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Configurações da barbearia (nome, WhatsApp, horários, regras do agendamento, pausa...) como chave → JSON
CREATE TABLE IF NOT EXISTS store_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- ---------------------------------------------------------------------------
-- Agendamentos
-- ---------------------------------------------------------------------------

-- day + start_min/end_min: horário de Brasília (minutos desde 00:00). services: cópia dos
-- serviços no momento do agendamento, já com o preço do barbeiro ([{ id, name, price, duration }]).
CREATE TABLE IF NOT EXISTS appointments (
  id              BIGSERIAL PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'agendado'
                  CHECK (status IN ('agendado', 'confirmado', 'em_atendimento', 'concluido', 'faltou', 'cancelado')),
  source          TEXT NOT NULL DEFAULT 'site' CHECK (source IN ('site', 'app')),
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT NOT NULL DEFAULT '',
  barber_id       TEXT NOT NULL REFERENCES barbers (id),
  barber_name     TEXT NOT NULL,
  services        JSONB NOT NULL,
  day             DATE NOT NULL,
  start_min       INT NOT NULL CHECK (start_min BETWEEN 0 AND 1435),
  end_min         INT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  price           NUMERIC(10, 2) NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  payment_method  TEXT CHECK (payment_method IN ('pix', 'debito', 'credito', 'dinheiro')),
  paid_amount     NUMERIC(10, 2),
  completed_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  client_ref      TEXT UNIQUE,
  client_ip_hash  TEXT,
  created_by      TEXT NOT NULL DEFAULT 'cliente',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_day_idx ON appointments (day, start_min);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments (status);
CREATE INDEX IF NOT EXISTS appointments_phone_idx ON appointments (customer_phone);
CREATE INDEX IF NOT EXISTS appointments_ip_recent_idx ON appointments (client_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS appointments_completed_idx ON appointments (completed_at);

-- Cada agendamento ativo "ocupa" os blocos de 5 minutos da cadeira do barbeiro. A chave
-- primária impede, no próprio banco, que dois clientes fiquem com o mesmo horário
-- (mesmo que os dois confirmem no mesmo segundo). Cancelar ou faltar libera os blocos.
CREATE TABLE IF NOT EXISTS appointment_slots (
  barber_id       TEXT NOT NULL,
  day             DATE NOT NULL,
  minute          INT NOT NULL,
  appointment_id  BIGINT NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  PRIMARY KEY (barber_id, day, minute)
);

CREATE INDEX IF NOT EXISTS appointment_slots_appointment_idx ON appointment_slots (appointment_id);

CREATE TABLE IF NOT EXISTS appointment_history (
  id              BIGSERIAL PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  changed_by      TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_history_idx ON appointment_history (appointment_id, created_at);

-- Bloqueios de agenda (almoço, folga, férias, curso). barber_id nulo = a barbearia toda.
-- Vale de day até until_day (inclusive), das start_min às end_min de cada dia.
CREATE TABLE IF NOT EXISTS time_blocks (
  id          BIGSERIAL PRIMARY KEY,
  barber_id   TEXT REFERENCES barbers (id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  until_day   DATE NOT NULL,
  start_min   INT NOT NULL CHECK (start_min BETWEEN 0 AND 1435),
  end_min     INT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  reason      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (until_day >= day)
);

CREATE INDEX IF NOT EXISTS time_blocks_day_idx ON time_blocks (day, until_day);

-- ---------------------------------------------------------------------------
-- Equipe (app de desktop), caixa, finanças e registros
-- ---------------------------------------------------------------------------

-- role: dono | recepcao | barbeiro. session_version invalida sessões ao trocar senha ou desativar.
CREATE TABLE IF NOT EXISTS staff_users (
  id               BIGSERIAL PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  display_name     TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL DEFAULT 'dono',
  active           BOOLEAN NOT NULL DEFAULT true,
  session_version  INT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  ip_hash     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts (ip_hash, created_at);

-- Tentativas recentes (login por usuário, agendamentos por telefone). Chave guardada só como hash.
CREATE TABLE IF NOT EXISTS rate_events (
  id          BIGSERIAL PRIMARY KEY,
  bucket      TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_events_key_idx ON rate_events (bucket, key_hash, created_at);
CREATE INDEX IF NOT EXISTS rate_events_created_at_idx ON rate_events (created_at);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id               BIGSERIAL PRIMARY KEY,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by        TEXT NOT NULL,
  opening_amount   NUMERIC(10, 2) NOT NULL CHECK (opening_amount >= 0),
  closed_at        TIMESTAMPTZ,
  closed_by        TEXT,
  expected_amount  NUMERIC(10, 2),
  counted_amount   NUMERIC(10, 2),
  notes            TEXT NOT NULL DEFAULT ''
);

-- No máximo um caixa aberto por vez
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_single_open_idx ON cash_sessions ((closed_at IS NULL)) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS cash_movements (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT NOT NULL REFERENCES cash_sessions (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('sangria', 'suprimento')),
  amount       NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  description  TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cash_movements_session_idx ON cash_movements (session_id, created_at);

CREATE TABLE IF NOT EXISTS expenses (
  id           BIGSERIAL PRIMARY KEY,
  spent_on     DATE NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  amount       NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON expenses (spent_on);

-- Quem alterou o quê (serviços, barbeiros, barbearia, caixa, equipe)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  action      TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
