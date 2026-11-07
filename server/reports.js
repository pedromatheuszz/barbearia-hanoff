// Relatórios de atendimentos (dia do atendimento, horário de Brasília). Só os concluídos entram no faturamento.
import { HttpError } from './http.js';
import { isRealDate } from '../shared/schedule.js';

const TZ = 'America/Sao_Paulo';
const MAX_DAYS = 366;
const n2 = (v) => Math.round(Number(v ?? 0) * 100) / 100;

export function parseRange(searchParams, today = new Date()) {
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // AAAA-MM-DD
  const to = searchParams.get('to') || fmt(today);
  const from = searchParams.get('from') || to;
  if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(422, 'Datas devem estar no formato AAAA-MM-DD');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (Number.isNaN(days) || days < 0) throw new HttpError(422, 'Período inválido');
  if (days > MAX_DAYS) throw new HttpError(422, 'Período máximo de 1 ano');
  return { from, to };
}

export async function salesReport(db, { from, to }) {
  const range = 'day BETWEEN $1 AND $2';
  const params = [from, to];
  const done = `${range} AND status = 'concluido'`;

  const [[summary], daily, services, byBarber, byPayment, byWeekday, byHour] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'concluido')::int AS services,
              count(*) FILTER (WHERE status = 'faltou')::int AS no_shows,
              count(*) FILTER (WHERE status = 'cancelado')::int AS cancelled,
              count(*) FILTER (WHERE status = 'concluido' AND source = 'site')::int AS online,
              coalesce(sum(paid_amount) FILTER (WHERE status = 'concluido'), 0) AS revenue,
              coalesce(avg(paid_amount) FILTER (WHERE status = 'concluido'), 0) AS avg_ticket
         FROM appointments WHERE ${range}`,
      params
    ),
    db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*)::int AS services, coalesce(sum(paid_amount), 0) AS revenue
         FROM appointments WHERE ${done} GROUP BY 1 ORDER BY 1`,
      params
    ),
    db.query(
      `SELECT s->>'name' AS name, count(*)::int AS qty, sum((s->>'price')::numeric) AS revenue
         FROM appointments, jsonb_array_elements(services) AS s
        WHERE ${done} GROUP BY 1 ORDER BY qty DESC, revenue DESC LIMIT 10`,
      params
    ),
    db.query(
      `SELECT a.barber_name AS key, count(*)::int AS services, coalesce(sum(a.paid_amount), 0) AS revenue,
              coalesce(max(b.commission_percent), 0) AS commission_percent
         FROM appointments a LEFT JOIN barbers b ON b.id = a.barber_id
        WHERE a.day BETWEEN $1 AND $2 AND a.status = 'concluido' GROUP BY 1 ORDER BY revenue DESC`,
      params
    ),
    db.query(
      `SELECT payment_method AS key, count(*)::int AS services, coalesce(sum(paid_amount), 0) AS revenue
         FROM appointments WHERE ${done} GROUP BY 1 ORDER BY revenue DESC`,
      params
    ),
    db.query(
      `SELECT extract(dow FROM day)::int AS dow, count(*)::int AS services
         FROM appointments WHERE ${done} GROUP BY 1 ORDER BY 1`,
      params
    ),
    db.query(
      `SELECT (start_min / 60)::int AS hour, count(*)::int AS services
         FROM appointments WHERE ${done} GROUP BY 1 ORDER BY 1`,
      params
    ),
  ]);

  const booked = summary.services + summary.no_shows;
  return {
    from,
    to,
    summary: {
      services: summary.services,
      noShows: summary.no_shows,
      cancelled: summary.cancelled,
      online: summary.online,
      noShowRate: booked ? Math.round((summary.no_shows / booked) * 1000) / 10 : 0,
      revenue: n2(summary.revenue),
      avgTicket: n2(summary.avg_ticket),
    },
    daily: daily.map(d => ({ day: d.day, services: d.services, revenue: n2(d.revenue) })),
    topServices: services.map(s => ({ name: s.name, qty: s.qty, revenue: n2(s.revenue) })),
    byBarber: byBarber.map(b => ({
      key: b.key, services: b.services, revenue: n2(b.revenue), commissionPercent: n2(b.commission_percent),
      commission: n2((Number(b.revenue) * Number(b.commission_percent)) / 100),
    })),
    byPayment: byPayment.map(r => ({ key: r.key, services: r.services, revenue: n2(r.revenue) })),
    byWeekday: byWeekday.map(r => ({ dow: r.dow, services: r.services })),
    byHour: byHour.map(r => ({ hour: r.hour, services: r.services })),
  };
}
