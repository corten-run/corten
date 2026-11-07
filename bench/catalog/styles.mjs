import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const here = new URL('./', import.meta.url);
export const copies = [
  'corten/static/catalog.css',
  ...[
    'nextjs/public', 'tanstack-start/public', 'sveltekit/static', 'react-router/public',
    'leptos/public', 'django/static', 'rails/app/assets/stylesheets', 'laravel/public',
    'aspnet/wwwroot', 'spring/src/main/resources/static', 'phoenix/priv/static/css',
    'astro/public', 'nuxt/public', 'topcoat/static', 'axum-maud/static', 'gin/static', 'drogon/static',
  ].map(path => `../fullstack/apps/${path}/catalog.css`),
];

export function syncStyles(check = true) {
  const canonical = readFileSync(new URL('catalog.css', here));
  const stale = [];
  for (const copy of copies) {
    const path = new URL(copy, here);
    if (check) {
      if (!readFileSync(path).equals(canonical)) stale.push(copy);
    } else writeFileSync(path, canonical);
  }
  if (stale.length) throw new Error(`catalog CSS differs: ${stale.join(', ')}; run node bench/catalog/styles.mjs --write`);
  return copies.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--write', '--check'].includes(args[0]))) throw new Error('usage: node bench/catalog/styles.mjs [--check|--write]');
  console.log(`${syncStyles(args[0] !== '--write')} catalog stylesheets ${args[0] === '--write' ? 'written' : 'match'}`);
}
