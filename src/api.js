// Endpoints JSON del sistema de caja.
import * as config from './config.js';
import * as store from './store.js';
import { Router, sendJson, readJsonBody } from './router.js';
import * as service from './service.js';
import { describePrinter } from './printer.js';
import { dailyReport, availableDays } from './reports.js';
import { businessDay, toInt, clean } from './util.js';
import { PAYMENT_LABELS } from './tickets.js';

const { HttpError } = store;

function requirePin(req) {
  const pin = String(config.get('adminPin', '') || '');
  if (!pin) return;
  const sent = req.headers['x-admin-pin'];
  if (String(sent || '') !== pin) throw new HttpError(401, 'PIN de administrador incorrecto');
}

async function publicConfig() {
  const catalog = await store.getCatalog();
  return {
    business: config.get('business'),
    currency: config.get('currency'),
    tickets: config.get('tickets'),
    printer: {
      mode: config.get('printer.mode'),
      enabled: config.get('printer.enabled'),
      description: describePrinter(),
      charsPerLine: config.get('printer.charsPerLine'),
    },
    requiresPin: Boolean(config.get('adminPin', '')),
    paymentMethods: Object.entries(PAYMENT_LABELS).map(([key, label]) => ({ key, label })),
    day: businessDay(),
    stations: catalog.stations,
    products: catalog.products,
  };
}

export function buildRouter() {
  const router = new Router();

  router.get('/api/bootstrap', async () => ({ ok: true, ...(await publicConfig()) }));

  router.get('/api/catalog', async () => {
    const catalog = await store.getCatalog();
    return { ok: true, stations: catalog.stations, products: catalog.products };
  });

  // --------------------------------------------------------------- catalogo
  router.post('/api/products', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, product: await store.saveProduct(ctx.body) };
  });
  router.put('/api/products/:id', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, product: await store.saveProduct({ ...ctx.body, id: ctx.params.id }) };
  });
  router.delete('/api/products/:id', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, ...(await store.deleteProduct(ctx.params.id)) };
  });

  router.post('/api/stations', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, station: await store.saveStation(ctx.body) };
  });
  router.put('/api/stations/:id', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, station: await store.saveStation({ ...ctx.body, id: ctx.params.id }) };
  });
  router.delete('/api/stations/:id', async (ctx) => {
    requirePin(ctx.req);
    return { ok: true, ...(await store.deleteStation(ctx.params.id)) };
  });

  // ---------------------------------------------------------------- pedidos
  router.post('/api/orders', async (ctx) => {
    const order = await store.createOrder(ctx.body);
    const printResult = ctx.body.print === false
      ? { ok: true, printed: [], error: null }
      : await service.printOrder(order, { what: 'all' });
    return { ok: true, order: await store.getOrder(order.id), print: printResult };
  });

  router.get('/api/orders', async (ctx) => {
    const day = ctx.query.get('day') || businessDay();
    const orders = await store.listOrders({ day });
    return { ok: true, day, orders: [...orders].reverse() };
  });

  router.get('/api/orders/:id', async (ctx) => ({ ok: true, order: await store.getOrder(ctx.params.id) }));

  router.get('/api/orders/:id/preview', async (ctx) => {
    const order = await store.getOrder(ctx.params.id);
    return { ok: true, order, documents: service.previewOrder(order, { what: ctx.query.get('what') || 'all' }) };
  });

  router.post('/api/orders/:id/print', async (ctx) => {
    const order = await store.getOrder(ctx.params.id);
    const result = await service.printOrder(order, { what: clean(ctx.body.what) || 'all' });
    return { ok: result.ok, print: result, order: await store.getOrder(order.id) };
  });

  router.post('/api/orders/:id/void', async (ctx) => {
    requirePin(ctx.req);
    const order = await store.voidOrder(ctx.params.id, ctx.body.reason);
    return { ok: true, order };
  });

  router.post('/api/orders/:id/deliver', async (ctx) => {
    const stationId = ctx.body.stationId === null || ctx.body.stationId === undefined || ctx.body.stationId === ''
      ? null
      : toInt(ctx.body.stationId, 0);
    const order = await store.markDelivered(ctx.params.id, stationId, ctx.body.delivered !== false);
    return { ok: true, order };
  });

  // --------------------------------------------------------------- informes
  router.get('/api/report', async (ctx) => {
    const day = ctx.query.get('day') || businessDay();
    return { ok: true, report: await dailyReport(day) };
  });

  router.post('/api/report/print', async (ctx) => {
    const day = clean(ctx.body.day) || businessDay();
    const result = await service.printDailyReport(day);
    return { ok: result.ok, error: result.error, report: result.report, text: result.text };
  });

  router.get('/api/days', async () => ({ ok: true, days: await availableDays() }));

  // -------------------------------------------------------------- impresora
  router.get('/api/printer/status', async () => ({ ok: true, status: await service.printerStatus() }));

  router.post('/api/printer/test', async () => {
    const result = await service.printTestPage();
    return { ok: result.ok, error: result.error, text: result.text };
  });

  // ----------------------------------------------------------- configuracion
  router.get('/api/settings', async (ctx) => {
    requirePin(ctx.req);
    const current = config.load();
    return { ok: true, settings: { ...current, adminPin: current.adminPin ? '****' : '' } };
  });

  router.put('/api/settings', async (ctx) => {
    requirePin(ctx.req);
    const patch = { ...ctx.body };
    delete patch.server; // el puerto solo se cambia en el archivo, requiere reiniciar
    if (patch.adminPin === '****') delete patch.adminPin;
    config.save(patch);
    return { ok: true, ...(await publicConfig()) };
  });

  return router;
}

export async function handleApi(router, req, res, url) {
  const found = router.match(req.method, url.pathname);
  if (!found) return false;
  if (found.methodNotAllowed) {
    sendJson(res, 405, { ok: false, error: 'Metodo no permitido' });
    return true;
  }
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
    const payload = await found.route.handler({ req, res, body, params: found.params, query: url.searchParams });
    if (payload !== undefined) sendJson(res, 200, payload);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    sendJson(res, status, { ok: false, error: err.message || 'Error interno' });
  }
  return true;
}
