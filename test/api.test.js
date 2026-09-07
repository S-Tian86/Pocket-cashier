// Prueba de integracion: levanta el servidor real y cobra un pedido por HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-cashier-api-'));
const configPath = path.join(dir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  business: { name: 'BINGO API' },
  printer: { enabled: true, mode: 'file', file: path.join(dir, 'spool.bin'), charsPerLine: 32 },
}));

const port = 8000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, POCKET_CASHIER_DATA: path.join(dir, 'data'), POCKET_CASHIER_CONFIG: configPath },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`${base}/api/bootstrap`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('el servidor no respondio');
});

test.after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(path, options) {
  const response = await fetch(base + path, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('entrega el catalogo inicial y la configuracion publica', async () => {
  const { body } = await call('/api/bootstrap');
  assert.equal(body.ok, true);
  assert.equal(body.business.name, 'BINGO API');
  assert.ok(body.products.length > 0);
  assert.ok(body.stations.length > 0);
  assert.ok(body.paymentMethods.some((method) => method.key === 'efectivo'));
});

test('cobra un pedido e imprime boleta y tickets de retiro', async () => {
  const { body: bootstrap } = await call('/api/bootstrap');
  const cocina = bootstrap.stations[0];
  const bar = bootstrap.stations[1];
  const productoCocina = bootstrap.products.find((product) => product.stationId === cocina.id);
  const productoBar = bootstrap.products.find((product) => product.stationId === bar.id);

  const { status, body } = await call('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: productoCocina.id, qty: 2 }, { productId: productoBar.id, qty: 1 }],
      paymentMethod: 'efectivo',
      amountPaid: 20000,
      cashier: 'Caja test',
    }),
  });

  assert.equal(status, 200);
  assert.equal(body.order.total, productoCocina.price * 2 + productoBar.price);
  assert.equal(body.print.ok, true);
  assert.deepEqual(body.print.printed.map((doc) => doc.kind), ['receipt', 'station', 'station']);
  assert.equal(body.order.printCount, 1);

  // los bytes ESC/POS llegaron al "papel"
  const spool = fs.readFileSync(path.join(dir, 'spool.bin'));
  assert.ok(spool.length > 100);
  assert.ok(spool.includes(Buffer.from('BINGO API')));
  assert.ok(spool.includes(Buffer.from('TICKET DE RETIRO')));
});

test('el cierre suma lo cobrado', async () => {
  const { body } = await call('/api/report');
  assert.equal(body.report.ordersCount, 1);
  assert.ok(body.report.total > 0);
  assert.equal(body.report.byStation.length, 2);
});

test('valida las peticiones incorrectas', async () => {
  const vacio = await call('/api/orders', { method: 'POST', body: JSON.stringify({ items: [] }) });
  assert.equal(vacio.status, 400);
  assert.equal(vacio.body.ok, false);

  const inexistente = await call('/api/orders/2000-01-01-0001');
  assert.equal(inexistente.status, 404);

  const metodo = await call('/api/report', { method: 'DELETE' });
  assert.equal(metodo.status, 405);
});
