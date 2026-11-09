import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

// The UI is plain browser JS with no bundler, so a typo'd identifier only fails at runtime in the browser.
// These checks catch the commonest breakages (an unknown view function, a missing icon, an unbalanced template) in CI.
test('frontend: every registered view function exists and every nav entry has a view', () => {
  const app = read('app.js');
  const views = /const VIEWS = \{([^}]*)\}/.exec(app)[1].split(',').map((x) => x.trim().split(':').map((y) => y.trim())).filter((x) => x[0]);
  for (const [name, fn] of views) assert.match(app, new RegExp(`function ${fn}\\(`), `${name} → ${fn} is not defined`);
  const nav = [...app.matchAll(/\['(\w+)', '[^']+', '\w+'\]/g)].map((m) => m[1]);
  for (const id of nav.filter((n) => !['overview'].includes(n) || true)) assert.ok(views.some(([n]) => n === id), `nav "${id}" has no view`);
});

test('frontend: every icon used by name is defined in icons.js', () => {
  const icons = read('icons.js');
  const defined = new Set([...icons.matchAll(/^\s{2}(\w+): '/gm)].map((m) => m[1]));
  for (const f of ['app.js', 'shop.js']) {
    const src = read(f);
    for (const m of src.matchAll(/\bI\('(\w+)'|\bicon\('(\w+)'|, '(\w+)'\]/g)) {
      const name = m[1] || m[2];
      if (name) assert.ok(defined.has(name), `${f}: icon "${name}" missing`);
    }
  }
  for (const m of read('index.html').matchAll(/data-ic="(\w+)"/g)) assert.ok(defined.has(m[1]), `index.html: icon ${m[1]} missing`);
});

test('frontend: no inline styles or scripts (strict CSP) in shipped HTML/JS templates', () => {
  for (const f of ['index.html', 'shop.html']) {
    const html = read(f);
    assert.ok(!/\sstyle=/.test(html), `${f} has an inline style attribute`);
    assert.ok(!/<script(?![^>]*src=)/.test(html), `${f} has an inline script`);
    assert.ok(!/\son\w+=/.test(html), `${f} has an inline event handler`);
  }
  for (const f of ['app.js', 'shop.js', 'charts.js']) assert.ok(!/\sstyle="/.test(read(f)), `${f} renders an inline style attribute`);
});

test('AG Grid is vendored locally (no CDN), licensed MIT, and used by the three data screens', () => {
  for (const f of ['ag-grid-community.min.js', 'ag-grid.min.css', 'ag-theme-quartz.min.css', 'LICENSE.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor/ag-grid', f)), `${f} missing`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'public/vendor/ag-grid/LICENSE.txt'), 'utf8'), /MIT/);
  const html = read('index.html');
  assert.match(html, /vendor\/ag-grid\/ag-grid-community\.min\.js/);
  assert.ok(!/https?:\/\//.test(html.replace(/<a [^>]*>/g, '')), 'index.html must not load anything from the network');
  const app = read('app.js');
  for (const id of ['auditGrid', 'txGrid', 'ordersGrid']) { assert.match(app, new RegExp(`id="${id}"`)); assert.match(app, new RegExp(`mountGrid\\('${id}'`)); }
  assert.match(app, /exportDataAsCsv/);
  assert.ok(fs.existsSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md')));
});
