import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { devApi } from '../server/dev-api.js';
import { LUCIDE_ICONS, CUSTOM_ICONS } from './src/icons.js';

// Site dos clientes. Rode pela raiz do repositório (npm run dev / npm run build):
// a API em ../server e ../netlify/functions é servida junto pelo plugin devApi.

// Sprite dos ícones (Lucide + os desenhados para a barbearia), embutido no começo do <body> de cada
// página. Assim o HTML e o JS usam <svg><use href="#i-nome"></use></svg> sem carregar nada a mais.
function iconSprite() {
  let sprite = null;
  const build = () => {
    const dir = resolve(dirname(createRequire(import.meta.url).resolve('lucide-static/package.json')), 'icons');
    const symbol = (name, inner) => `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
    const symbols = LUCIDE_ICONS.map((name) => {
      const svg = fs.readFileSync(resolve(dir, `${name}.svg`), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      return symbol(name, svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, ''));
    });
    for (const [name, inner] of Object.entries(CUSTOM_ICONS)) symbols.push(symbol(name, inner));
    return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">${symbols.join('')}</svg>`;
  };
  return {
    name: 'icon-sprite',
    transformIndexHtml(html) {
      sprite ||= build();
      return html.replace(/<body([^>]*)>/, `<body$1>\n${sprite}`);
    },
  };
}

// Endereço público do site, usado nas prévias de link (WhatsApp, Instagram), no canonical e no sitemap.
// Ordem: SITE_URL (domínio próprio) → domínio de produção da Vercel → URL do Netlify → padrão.
const SITE_URL = (process.env.SITE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || process.env.URL
  || 'https://barbearia-hanoff.vercel.app').replace(/\/+$/, '');

// Troca __SITE_URL__ no HTML e gera robots.txt e sitemap.xml no build
function siteMeta() {
  return {
    name: 'site-meta',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('__SITE_URL__', SITE_URL) },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\nDisallow: /agendamento/\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n` });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [siteMeta(), iconSprite(), devApi()],
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    // sem .map públicos: o site no ar não precisa expor o código-fonte original
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true, pure_funcs: ['console.log', 'console.info', 'console.debug'] },
      mangle: { safari10: true },
      format: { comments: false },
    },
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        agendamento: resolve(import.meta.dirname, 'agendamento/index.html'),
        notFound: resolve(import.meta.dirname, '404.html'),
      },
      output: {
        // GSAP em um arquivo separado (muda pouco, fica no cache do navegador)
        manualChunks: (id) => (id.includes('node_modules/gsap') ? 'vendor-gsap' : undefined),
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] || assetInfo.name || '';
          const ext = name.split('.').pop();
          if (/\.(png|jpe?g|gif|svg|webp|avif|woff2?)$/.test(name)) return `assets/images/[name]-[hash].${ext}`;
          if (/\.css$/.test(name)) return `assets/css/[name]-[hash].${ext}`;
          return `assets/[name]-[hash].${ext}`;
        },
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
      },
    },
    cssCodeSplit: true,
    target: 'es2022',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 500,
  },
  optimizeDeps: { include: ['gsap', 'gsap/ScrollTrigger'] },
  server: {
    port: 3000,
    open: !process.env.NO_OPEN,
    headers: { 'Service-Worker-Allowed': '/' },
  },
  preview: { port: 4173, open: !process.env.NO_OPEN },
});
