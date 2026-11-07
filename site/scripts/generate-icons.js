/**
 * Gera os ícones a partir do emblema (site/public/images/emblema.svg):
 *  - PWA: site/public/images/icon-*.png (referenciados no manifest.json)
 *  - App de gestão: app/build/icon.png (instalador/janela) e app/renderer/assets/emblema.png
 * Uso: npm run icons
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');
const SVG = fs.readFileSync(path.join(SITE, 'public/images/emblema.svg'));
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const BG = { r: 15, g: 14, b: 12, alpha: 1 };

const render = (size) => sharp(SVG, { density: Math.max(72, Math.ceil((size / 512) * 72 * 4)) }).resize(size, size);

// "maskable": o emblema dentro da área segura (80%) sobre o fundo da marca
async function maskable(size) {
  const inner = await render(Math.round(size * 0.8)).png().toBuffer();
  const offset = Math.round(size * 0.1);
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } }).composite([{ input: inner, left: offset, top: offset }]).png();
}

fs.mkdirSync(path.join(SITE, 'public/images'), { recursive: true });
for (const size of SIZES) await (await maskable(size)).toFile(path.join(SITE, `public/images/icon-${size}.png`));

fs.mkdirSync(path.join(REPO, 'app/build'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'app/renderer/assets'), { recursive: true });
await render(512).png().toFile(path.join(REPO, 'app/build/icon.png'));
await render(256).png().toFile(path.join(REPO, 'app/renderer/assets/emblema.png'));
console.log(`✓ ${SIZES.length} ícones do site e os ícones do app gerados`);
