// Endpoints JSON del sistema de caja.
import * as config from './config.js';
import * as store from './store.js';
import { Router, sendJson, readJsonBody } from './router.js';
import * as service from './service.js';
import { describePrinter } from './printer.js';
import { dailyReport, availableDays } from './reports.js';
import { stationQueue } from './queue.js';
import { businessDay, toInt, clean, localAddresses } from './util.js';
import { PAYMENT_LABELS } from './tickets.js';
import {
  LEVELS, resolveRole, accessEnabled, accessCodes, normalizeCode, clientIp, isBlocked, registerFailure,
} from './access.js';
import * as tunnel from './tunnel.js';

const { HttpError } = store;

/**
 * Verifica que quien llama tenga al menos el rol `needed`. `auth` en el error le
 * dice a la pantalla que hacer: 'code' -> pedir el codigo, 'pin' -> pedir el PIN.
 */
function authorize(req, needed) {
  const ip = clientIp(req);
  if (isBlocked(ip)) throw new HttpError(429, 'Demasiados intentos fallidos. Espera unos minutos.');
  const { role, failed } = resolveRole(req);
  if (failed) registerFailure(ip);
  if (role && LEVELS[role] >= LEVELS[needed]) return role;
  if (needed === 'admin' && role === 'cashier') throw new HttpError(401, 'PIN de administrador incorrecto', 'pin');
  if (!role) throw new HttpError(401, 'Necesitas el codigo de acceso', 'code');
  throw new HttpError(403, 'Tu codigo no permite hacer esto', 'role');
}

/** Envuelve un handler exigiendo un rol; el rol queda en ctx.role. */
function need(role, handler) {
  return (ctx) => {
    ctx.role = authorize(ctx.req, role);
    return handler(ctx);
  };
}

async function publicConfig(role) {
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
    role,
    accessEnabled: accessEnabled(),
    paymentMethods: Object.entries(PAYMENT_LABELS).map(([key, label]) => ({ key, label })),
    day: businessDay(),
    stations: catalog.stations,
    products: catalog.products,
  };
}

/** Direccion con la que se entra desde otros equipos: la del tunel o, si no hay, la de la red local. */
function publicUrl() {
  if (tunnel.status().url) return tunnel.status().url;
  const [ip] = localAddresses();
  return ip ? `http://${ip}:${config.get('server.port', 8080)}` : '';
}

function validateAccess(patch) {
  if (!patch.access) return;
  const cashierCode = normalizeCode(patch.access.cashierCode);
  const standCode = normalizeCode(patch.access.standCode);
  for (const code of [cashierCode, standCode]) {
    if (code && code.length < 4) throw new HttpError(400, 'Los codigos deben tener al menos 4 letras o numeros');
  }
  if (cashierCode && cashierCode === standCode) throw new HttpError(400, 'El codigo de cajas y el de stands deben ser distintos');
  patch.access = { cashierCode, standCode };
}

export function buildRouter() {
  const router = new Router();

  // Sin rol: la pantalla de ingreso pregunta si hace falta codigo y valida el que se escribio
  router.get('/api/access', async (ctx) => {
    const ip = clientIp(ctx.req);
    if (isBlocked(ip)) throw new HttpError(429, 'Demasiados intentos fallidos. Espera unos minutos.');
    const { role, failed } = resolveRole(ctx.req);
    if (failed) registerFailure(ip);
    return { ok: true, required: accessEnabled(), role, business: config.get('business.name', '') };
  });

  router.get('/api/bootstrap', need('stand', async (ctx) => ({ ok: true, ...(await publicConfig(ctx.role)) })));

  router.get('/api/catalog', need('stand', async () => {
    const catalog = await store.getCatalog();
    return { ok: true, stations: catalog.stations, products: catalog.products };
  }));

  // --------------------------------------------------------------- catalogo
  router.post('/api/products', need('admin', async (ctx) => ({ ok: true, product: await store.saveProduct(ctx.body) })));
  router.put('/api/products/:id', need('admin', async (ctx) => (
    { ok: true, product: await store.saveProduct({ ...ctx.body, id: ctx.params.id }) })));
  router.post('/api/products/:id/stock', need('admin', async (ctx) => {
    const { set, add } = ctx.body;
    return { ok: true, product: await store.adjustStock(ctx.params.id, set !== undefined ? { set } : { add }) };
  }));
  router.delete('/api/products/:id', need('admin', async (ctx) => ({ ok: true, ...(await store.deleteProduct(ctx.params.id)) })));

  router.post('/api/stations', need('admin', async (ctx) => ({ ok: true, station: await store.saveStation(ctx.body) })));
  router.put('/api/stations/:id', need('admin', async (ctx) => (
    { ok: true, station: await store.saveStation({ ...ctx.body, id: ctx.params.id }) })));
  router.delete('/api/stations/:id', need('admin', async (ctx) => ({ ok: true, ...(await store.deleteStation(ctx.params.id)) })));

  // Pantalla del stand: le basta el codigo de stands
  router.get('/api/stations/:id/queue', need('stand', async (ctx) => ({
    ok: true,
    ...(await stationQueue(ctx.params.id, {
      day: ctx.query.get('day') || businessDay(),
      limit: ctx.query.get('limit') ?? undefined,
    })),
  })));

  // ---------------------------------------------------------------- pedidos
  router.post('/api/orders', need('cashier', async (ctx) => {
    const order = await store.createOrder(ctx.body);
    const printResult = ctx.body.print === false
      ? { ok: true, printed: [], error: null }
      : await service.printOrder(order, { what: 'all' });
    return { ok: true, order: await store.getOrder(order.id), print: printResult };
  }));

  router.get('/api/orders', need('cashier', async (ctx) => {
    const day = ctx.query.get('day') || businessDay();
    const orders = await store.listOrders({ day });
    return { ok: true, day, orders: [...orders].reverse() };
  }));

  router.get('/api/orders/:id', need('cashier', async (ctx) => ({ ok: true, order: await store.getOrder(ctx.params.id) })));

  router.get('/api/orders/:id/preview', need('cashier', async (ctx) => {
    const order = await store.getOrder(ctx.params.id);
    return { ok: true, order, documents: service.previewOrder(order, { what: ctx.query.get('what') || 'all' }) };
  }));

  router.post('/api/orders/:id/print', need('cashier', async (ctx) => {
    const order = await store.getOrder(ctx.params.id);
    const result = await service.printOrder(order, { what: clean(ctx.body.what) || 'all' });
    return { ok: result.ok, print: result, order: await store.getOrder(order.id) };
  }));

  router.post('/api/orders/:id/void', need('admin', async (ctx) => {
    const order = await store.voidOrder(ctx.params.id, ctx.body.reason);
    return { ok: true, order };
  }));

  router.post('/api/orders/:id/deliver', need('stand', async (ctx) => {
    const stationId = ctx.body.stationId === null || ctx.body.stationId === undefined || ctx.body.stationId === ''
      ? null
      : toInt(ctx.body.stationId, 0);
    const order = await store.markDelivered(ctx.params.id, stationId, ctx.body.delivered !== false);
    return { ok: true, order };
  }));

  // --------------------------------------------------------------- informes
  router.get('/api/report', need('cashier', async (ctx) => {
    const day = ctx.query.get('day') || businessDay();
    return { ok: true, report: await dailyReport(day) };
  }));

  router.post('/api/report/print', need('cashier', async (ctx) => {
    const day = clean(ctx.body.day) || businessDay();
    const result = await service.printDailyReport(day);
    return { ok: result.ok, error: result.error, report: result.report, text: result.text };
  }));

  router.get('/api/days', need('cashier', async () => ({ ok: true, days: await availableDays() })));

  // -------------------------------------------------------------- impresora
  router.get('/api/printer/status', need('stand', async () => ({ ok: true, status: await service.printerStatus() })));

  router.post('/api/printer/test', need('admin', async () => {
    const result = await service.printTestPage();
    return { ok: result.ok, error: result.error, text: result.text };
  }));

  // --------------------------------------------------------- acceso remoto
  router.get('/api/remote', need('admin', async () => ({
    ok: true,
    tunnel: tunnel.status(),
    url: publicUrl(),
    enabled: accessEnabled(),
    codes: accessCodes(),
  })));

  // Ticket con QR para entrar: el QR ya trae el codigo, en el stand solo hay que escanearlo
  router.post('/api/access/print', need('admin', async (ctx) => {
    const role = ctx.body.role === 'stand' ? 'stand' : 'cashier';
    const code = accessCodes()[role];
    if (!code) throw new HttpError(400, 'Primero define y guarda ese codigo');
    const url = publicUrl();
    if (!url) throw new HttpError(400, 'No hay una direccion para entrar: inicia el tunel o conecta el PC a una red');
    const result = await service.printAccessTicket({ role, code, url });
    return { ok: result.ok, error: result.error, text: result.text };
  }));

  // ----------------------------------------------------------- configuracion
  router.get('/api/settings', need('admin', async () => {
    const current = config.load();
    return { ok: true, settings: { ...current, adminPin: current.adminPin ? '****' : '' } };
  }));

  router.put('/api/settings', need('admin', async (ctx) => {
    const patch = { ...ctx.body };
    delete patch.server; // el puerto solo se cambia en el archivo, requiere reiniciar
    if (patch.adminPin === '****') delete patch.adminPin;
    validateAccess(patch);
    config.save(patch);
    return { ok: true, ...(await publicConfig(ctx.role)) };
  }));

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
    sendJson(res, status, { ok: false, error: err.message || 'Error interno', auth: err.auth });
  }
  return true;
}
