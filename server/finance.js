// Financeiro: despesas e resultado do mês (faturamento dos atendimentos − despesas), com a
// comissão estimada de cada barbeiro. Datas de Brasília (dia do atendimento).
import { HttpError } from './http.js';
import { isRealDate } from '../shared/schedule.js';

const TZ = 'America/Sao_Paulo';
const num = (v) => Math.round(Number(v ?? 0) * 100) / 100;

export const EXPENSE_CATEGORIES = [
  'Produtos e insumos', 'Comissões', 'Salários', 'Aluguel', 'Água, luz e internet',
  'Taxas da maquininha', 'Impostos', 'Manutenção e equipamentos', 'Marketing', 'Outros',
];

export function parseMonth(value, today = new Date()) {
  const month = value || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(today).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isRealDate(`${month}-01`)) throw new HttpError(422, 'Mês deve estar no formato AAAA-MM');
  return month;
}

export async function monthSummary(db, month) {
  const first = `${month}-01`;
  const range = `day >= $1::date AND day < ($1::date + interval '1 month')`;

  const [[sales], expenses, daily, dailyExpenses, byBarber] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'concluido')::int AS services,
              count(*) FILTER (WHERE status = 'faltou')::int AS no_shows,
              coalesce(sum(paid_amount) FILTER (WHERE status = 'concluido'), 0) AS revenue
         FROM appointments WHERE ${range}`,
      [first]
    ),
    db.query(
      `SELECT id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, description, amount, created_by
         FROM expenses WHERE spent_on >= $1::date AND spent_on < ($1::date + interval '1 month')
        ORDER BY spent_on DESC, id DESC`,
      [first]
    ),
    db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(sum(paid_amount), 0) AS revenue
         FROM appointments WHERE ${range} AND status = 'concluido' GROUP BY 1 ORDER BY 1`,
      [first]
    ),
    db.query(
      `SELECT to_char(spent_on, 'YYYY-MM-DD') AS day, sum(amount) AS total
         FROM expenses WHERE spent_on >= $1::date AND spent_on < ($1::date + interval '1 month') GROUP BY 1`,
      [first]
    ),
    db.query(
      `SELECT a.barber_name AS name, count(*)::int AS services, coalesce(sum(a.paid_amount), 0) AS revenue,
              coalesce(max(b.commission_percent), 0) AS commission_percent
         FROM appointments a LEFT JOIN barbers b ON b.id = a.barber_id
        WHERE a.day >= $1::date AND a.day < ($1::date + interval '1 month') AND a.status = 'concluido'
        GROUP BY a.barber_name ORDER BY revenue DESC`,
      [first]
    ),
  ]);

  const byCategory = {};
  for (const e of expenses) byCategory[e.category] = num((byCategory[e.category] || 0) + Number(e.amount));
  const totalExpenses = num(expenses.reduce((t, e) => t + Number(e.amount), 0));
  const revenue = num(sales.revenue);
  const expenseByDay = Object.fromEntries(dailyExpenses.map(d => [d.day, num(d.total)]));
  const barbers = byBarber.map(b => ({
    name: b.name, services: b.services, revenue: num(b.revenue), commissionPercent: num(b.commission_percent),
    commission: num((Number(b.revenue) * Number(b.commission_percent)) / 100),
  }));

  return {
    month,
    services: sales.services,
    noShows: sales.no_shows,
    revenue,
    avgTicket: sales.services ? num(revenue / sales.services) : 0,
    expenses: totalExpenses,
    result: num(revenue - totalExpenses),
    commissions: num(barbers.reduce((t, b) => t + b.commission, 0)),
    byBarber: barbers,
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
    daily: [...new Set([...daily.map(d => d.day), ...Object.keys(expenseByDay)])].sort().map(day => ({
      day,
      revenue: num(daily.find(d => d.day === day)?.revenue),
      expenses: expenseByDay[day] || 0,
    })),
    items: expenses.map(e => ({
      id: Number(e.id), date: e.spent_on, category: e.category, description: e.description, amount: num(e.amount), by: e.created_by,
    })),
    categories: EXPENSE_CATEGORIES,
  };
}

export function validateExpense(body) {
  const date = String(body?.date || '');
  if (!isRealDate(date)) throw new HttpError(422, 'Data inválida');
  if (!EXPENSE_CATEGORIES.includes(body?.category)) throw new HttpError(422, 'Escolha uma categoria');
  const amount = Number(String(body?.amount ?? '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) throw new HttpError(422, 'Valor inválido');
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 200) : '';
  return { date, category: body.category, amount: num(amount), description };
}

export async function addExpense(db, e, username) {
  const [row] = await db.query(
    'INSERT INTO expenses (spent_on, category, description, amount, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [e.date, e.category, e.description, e.amount, username]
  );
  return Number(row.id);
}
