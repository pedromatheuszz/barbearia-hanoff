/**
 * Testes do site no navegador (Playwright), contra o build (vite preview).
 * O preview não tem a API: /api/catalog, /api/availability e /api/bookings são simulados aqui.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';

const catalog = JSON.parse(fs.readFileSync('site/src/generated/catalog.json', 'utf8'));
const allDay = Array(7).fill({ open: '00:00', close: '23:59' });
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + 86400000));
const TOKEN = 'tok_e2e_0123456789abcdefgh';

let lastBooking = null;

test.beforeEach(async ({ page }) => {
  lastBooking = null;
  await page.route('**/api/catalog', route => route.fulfill({
    json: { ...catalog, settings: { ...catalog.settings, hours: allDay }, status: { open: true, label: 'Aberto agora • Até as 23:59' } },
  }));
  await page.route('**/api/availability?*', route => {
    const url = new URL(route.request().url());
    const slots = ['09:00', '09:30', '14:00', '18:30'].map(time => ({ time, barbers: ['daniel', 'gabriel'] }));
    return route.fulfill({ json: url.searchParams.has('day') ? { day: url.searchParams.get('day'), duration: 30, prices: {}, slots } : { slots: slots.map(s => ({ ...s, day })) } });
  });
  await page.route('**/api/bookings', async route => {
    lastBooking = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: {
        id: 7, code: '#0007', token: TOKEN,
        booking: {
          code: '#0007', status: 'agendado', statusLabel: 'Aguardando confirmação', firstName: 'Ana', barberName: 'Daniel',
          services: [{ name: 'Corte', price: 45, duration: 30 }], day: lastBooking.day, time: lastBooking.time, endTime: '14:30', duration: 30,
          price: 45, priceFrom: false, canCancel: true, cancelHours: 2, store: { name: 'Barbearia Hanoff', whatsappPhone: '5547997715710', address: '', city: '', mapsUrl: '' },
        },
      },
    });
  });
});

test('abre com serviços, barbeiros e horários do catálogo', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Barbearia Hanoff/);
  await expect(page.locator('h1')).toContainText('hora marcada');
  await expect(page.locator('.service')).toHaveCount(catalog.services.length);
  await expect(page.locator('.barber')).toHaveCount(catalog.barbers.length);
  await expect(page.locator('#hours-list dt')).toHaveCount(7);
  await expect(page.locator('.ticket__slot').first()).toContainText('09:00');
});

test('filtra os serviços por categoria', async ({ page }) => {
  await page.goto('/');
  await page.locator('#services-tabs .tab', { hasText: /^Barba$/ }).click();
  const barba = catalog.services.filter(s => s.category === 'barba').length;
  await expect(page.locator('.service')).toHaveCount(barba);
});

test('agenda um corte do começo ao fim', async ({ page }) => {
  await page.goto('/');
  await page.locator('.service', { hasText: 'Corte pente único' }).locator('.service__book').click();
  await expect(page.locator('#booking-title')).toHaveText('Escolha o barbeiro');
  await page.click('#booking-next');
  await expect(page.locator('#booking-title')).toHaveText('Dia e horário');
  await page.locator('.b-slot', { hasText: '14:00' }).click();
  await page.click('#booking-next');
  await page.fill('#b-name', 'Ana Souza');
  await page.fill('#b-phone', '47988887777');
  await expect(page.locator('#b-phone')).toHaveValue('(47) 98888-7777');
  await page.click('#booking-next');
  await expect(page.locator('#booking-title')).toHaveText('Horário marcado!');
  await expect(page.locator('.b-done__code')).toContainText('#0007');
  expect(lastBooking).toMatchObject({ services: ['corte_pente_unico'], barberId: 'daniel', time: '14:00', customer: { name: 'Ana Souza', phone: '47988887777' } });
  expect(lastBooking.clientRef).toMatch(/^bk-[0-9a-f]{32}$/);
  await expect(page.locator('.b-done a[href^="https://wa.me/5547997715710"]')).toBeVisible();
});

test('não avança sem escolher serviço e horário', async ({ page }) => {
  await page.goto('/');
  await page.locator('.hero__actions [data-book]').click();
  await expect(page.locator('#booking-next')).toBeDisabled();
  await page.locator('.b-option', { hasText: /^Barba express/ }).click();
  await page.click('#booking-next');
  await page.click('#booking-next');
  await expect(page.locator('#booking-next')).toBeDisabled();
});

test('menu do celular abre e fecha', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'só no celular');
  await page.goto('/');
  await page.click('#menu-toggle');
  await expect(page.locator('#nav')).toHaveClass(/is-open/);
  await page.locator('#nav a', { hasText: 'Barbeiros' }).click();
  await expect(page.locator('#nav')).not.toHaveClass(/is-open/);
});

test('página do agendamento mostra o horário e permite cancelar', async ({ page }) => {
  let cancelled = false;
  const booking = (status) => ({
    code: '#0007', status, statusLabel: status === 'cancelado' ? 'Cancelado' : 'Confirmado', firstName: 'Ana', barberName: 'Daniel',
    services: [{ name: 'Corte', price: 45, duration: 30 }], day, time: '14:00', endTime: '14:30', duration: 30, price: 45, priceFrom: false,
    canCancel: status !== 'cancelado', cancelHours: 2, store: { name: 'Barbearia Hanoff', whatsappPhone: '5547997715710', address: 'R. Florianópolis, 3001', city: 'Joinville/SC', mapsUrl: '' },
  });
  await page.route(`**/api/bookings/${TOKEN}`, route => route.fulfill({ json: booking(cancelled ? 'cancelado' : 'confirmado') }));
  await page.route(`**/api/bookings/${TOKEN}/cancel`, route => { cancelled = true; return route.fulfill({ json: booking('cancelado') }); });
  await page.goto(`/agendamento/?t=${TOKEN}`);
  await expect(page.locator('#t-title')).toHaveText('Olá, Ana!');
  await expect(page.locator('#t-status')).toContainText('Confirmado');
  await page.click('#t-cancel');
  await page.click('#t-confirm-yes');
  await expect(page.locator('#t-title')).toHaveText('Horário cancelado');
  expect(cancelled).toBe(true);
});
