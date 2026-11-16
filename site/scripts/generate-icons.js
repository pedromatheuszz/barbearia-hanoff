/**
 * Gera o emblema, os ícones e a prévia de link (og-image.png) a partir da logo original (site/scripts/assets/logo-hanoff.png,
 * desenho preto/cinza sobre fundo claro):
 *  - site/public/images/logo-hanoff.svg: emblema transparente com traço escuro (o CSS inverte no tema escuro)
 *  - site/public/images/favicon.svg: mesmo emblema, segue o tema do sistema (prefers-color-scheme)
 *  - PWA: site/public/images/icon-*.png (traço creme sobre o fundo da marca)
 *  - App de gestão: app/build/icon.png (disco escuro + traço creme) e app/renderer/assets/emblema.png (transparente)
 * Uso: npm run icons
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');
const SRC = path.join(SITE, 'scripts/assets/logo-hanoff.png');
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const BG = { r: 15, g: 14, b: 12 };
const DARK_INK = { r: 17, g: 16, b: 14 };
const LIGHT_INK = { r: 241, g: 233, b: 219 };

// Converte o fundo claro em transparência: quanto mais escuro o pixel, mais opaco o traço.
const { data, info } = await sharp(SRC).resize(1024, 1024).greyscale().raw().toBuffer({ resolveWithObject: true });
let bgL = 0;
for (let i = 0; i < data.length; i++) bgL = Math.max(bgL, data[i]);
const alpha = Buffer.alloc(data.length);
// fora do círculo do emblema só há fundo (e a borda da imagem original): fica transparente
const center = info.width / 2, maxR2 = (info.width * 0.46) ** 2;
for (let i = 0; i < data.length; i++) {
  const x = i % info.width, y = Math.floor(i / info.width);
  if ((x - center) ** 2 + (y - center) ** 2 > maxR2) continue;
  const a = Math.round(((bgL - data[i]) / bgL) * 255 * 1.15);
  alpha[i] = a < 14 ? 0 : Math.min(255, a);
}

function ink(color, size) {
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < alpha.length; i++) px.set([color.r, color.g, color.b, alpha[i]], i * 4);
  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } }).resize(size, size).png().toBuffer();
}

async function onDisc(size, scale, circle) {
  const inner = Math.round(size * scale);
  const off = Math.round((size - inner) / 2);
  const shape = circle
    ? Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="rgb(${BG.r},${BG.g},${BG.b})"/></svg>`)
    : null;
  const base = sharp({ create: { width: size, height: size, channels: 4, background: circle ? { r: 0, g: 0, b: 0, alpha: 0 } : { ...BG, alpha: 1 } } });
  const layers = [...(shape ? [{ input: shape }] : []), { input: await ink(LIGHT_INK, inner), left: off, top: off }];
  return base.composite(layers).png();
}

const svgFrom = (b64, style = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${style}<image width="512" height="512" href="data:image/png;base64,${b64}"/></svg>`;

const dark512 = (await ink(DARK_INK, 512)).toString('base64');
const IMG = path.join(SITE, 'public/images');
fs.mkdirSync(IMG, { recursive: true });
fs.writeFileSync(path.join(IMG, 'logo-hanoff.svg'), svgFrom(dark512));
fs.writeFileSync(path.join(IMG, 'favicon.svg'), svgFrom(dark512, '<style>@media (prefers-color-scheme: dark){image{filter:invert(1)}}</style>'));
for (const size of SIZES) await (await onDisc(size, 0.8, false)).toFile(path.join(IMG, `icon-${size}.png`));

// Prévia de link (WhatsApp, Instagram, Facebook): 1200×630, emblema creme sobre o fundo da marca
const glow = Buffer.from(`<svg width="1200" height="630"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
  <stop offset="0" stop-color="#C9A46A" stop-opacity="0.22"/><stop offset="1" stop-color="#C9A46A" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/></svg>`);
await sharp({ create: { width: 1200, height: 630, channels: 4, background: { ...BG, alpha: 1 } } })
  .composite([{ input: glow }, { input: await ink(LIGHT_INK, 540), left: 330, top: 45 }])
  .png().toFile(path.join(IMG, 'og-image.png'));

fs.mkdirSync(path.join(REPO, 'app/build'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'app/renderer/assets'), { recursive: true });
await (await onDisc(512, 0.94, true)).toFile(path.join(REPO, 'app/build/icon.png'));
fs.writeFileSync(path.join(REPO, 'app/renderer/assets/emblema.png'), await ink(DARK_INK, 256));
console.log(`✓ emblema, favicon, ${SIZES.length} ícones do site e os ícones do app gerados`);
