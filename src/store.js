// Persistencia en archivos JSON: catalogo (productos/estaciones) y un archivo
// por dia comercial con sus pedidos. Sin dependencias externas ni servidor de BD.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from './config.js';
import { businessDay, localDateTime, clean, toInt, pad } from './util.js';

// POCKET_CASHIER_DATA permite guardar los datos en otra carpeta (pendrive, red, pruebas).
const DATA_DIR = process.env.POCKET_CASHIER_DATA
  ? path.resolve(process.env.POCKET_CASHIER_DATA)
  : path.join(ROOT, 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');

// Cola de escritura por archivo: evita que dos pedidos simultaneos (dos cajas
// en red) se pisen al guardar el mismo dia.
const locks = new Map();

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function ensureDirs() {
  fs.mkdirSync(DAYS_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw err;
  }
}

async function writeJson(file, data) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------- catalogo

const DEFAULT_CATALOG = {
  seq: { station: 0, product: 0 },
  stations: [],
  products: [],
};

const SEED = {
  stations: [
    { name: 'COCINA' },
    { name: 'BAR' },
    { name: 'PASTELERIA' },
  ],
  products: [
    { name: 'Completo', price: 2500, station: 'COCINA', category: 'Comida' },
    { name: 'Churrasco', price: 4000, station: 'COCINA', category: 'Comida' },
    { name: 'Empanada de pino', price: 2000, station: 'COCINA', category: 'Comida' },
    { name: 'Papas fritas', price: 2500, station: 'COCINA', category: 'Comida' },
    { name: 'Sopaipilla', price: 500, station: 'COCINA', category: 'Comida' },
    { name: 'Bebida lata', price: 1200, station: 'BAR', category: 'Bebestibles' },
    { name: 'Agua mineral', price: 1000, station: 'BAR', category: 'Bebestibles' },
    { name: 'Cafe', price: 1000, station: 'BAR', category: 'Bebestibles' },
    { name: 'Te', price: 800, station: 'BAR', category: 'Bebestibles' },
    { name: 'Trozo de torta', price: 2000, station: 'PASTELERIA', category: 'Dulces' },
    { name: 'Kuchen', price: 2000, station: 'PASTELERIA', category: 'Dulces' },
    { name: 'Mote con huesillo', price: 1500, station: 'PASTELERIA', category: 'Dulces' },
  ],
};

let catalogCache = null;

export async function getCatalog({ force = false } = {}) {
  if (catalogCache && !force) return catalogCache;
  let catalog = await readJson(CATALOG_PATH, DEFAULT_CATALOG);
  if (!catalog.stations.length && !catalog.products.length) {
    catalog = seedCatalog(catalog);
    await writeJson(CATALOG_PATH, catalog);
  }
  catalogCache = catalog;
  return catalog;
}

function seedCatalog(catalog) {
  const out = { ...structuredClone(DEFAULT_CATALOG), ...catalog };
  for (const [index, station] of SEED.stations.entries()) {
    out.seq.station += 1;
    out.stations.push({ id: out.seq.station, name: station.name, sort: index, active: true });
  }
  for (const [index, product] of SEED.products.entries()) {
    const station = out.stations.find((s) => s.name === product.station);
    out.seq.product += 1;
    out.products.push({
      id: out.seq.product,
      name: product.name,
      price: product.price,
      stationId: station ? station.id : null,
      category: product.category || '',
      sort: index,
      active: true,
    });
  }
  return out;
}

async function updateCatalog(mutator) {
  return withLock('catalog', async () => {
    const catalog = await getCatalog();
    const result = await mutator(catalog);
    await writeJson(CATALOG_PATH, catalog);
    catalogCache = catalog;
    return result;
  });
}

export async function saveStation(input) {
  return updateCatalog((catalog) => {
    const name = clean(input.name, 24).toUpperCase();
    if (!name) throw new HttpError(400, 'El nombre de la estacion es obligatorio');
    let station = catalog.stations.find((s) => s.id === toInt(input.id, 0));
    if (!station) {
      catalog.seq.station += 1;
      station = { id: catalog.seq.station, name, sort: catalog.stations.length, active: true };
      catalog.stations.push(station);
    }
    station.name = name;
    if (input.sort !== undefined) station.sort = toInt(input.sort, station.sort);
    if (input.active !== undefined) station.active = Boolean(input.active);
    return station;
  });
}

export async function deleteStation(id) {
  return updateCatalog((catalog) => {
    const stationId = toInt(id, 0);
    const inUse = catalog.products.some((p) => p.stationId === stationId && p.active);
    if (inUse) throw new HttpError(400, 'Hay productos activos asignados a esta estacion');
    catalog.stations = catalog.stations.filter((s) => s.id !== stationId);
    return { ok: true };
  });
}

export async function saveProduct(input) {
  return updateCatalog((catalog) => {
    const name = clean(input.name, 40);
    if (!name) throw new HttpError(400, 'El nombre del producto es obligatorio');
    const price = toInt(input.price, -1);
    if (price < 0) throw new HttpError(400, 'El precio debe ser un numero mayor o igual a 0');
    const stationId = input.stationId === null || input.stationId === '' ? null : toInt(input.stationId, 0);
    if (stationId !== null && !catalog.stations.some((s) => s.id === stationId)) {
      throw new HttpError(400, 'La estacion indicada no existe');
    }
    let product = catalog.products.find((p) => p.id === toInt(input.id, 0));
    if (!product) {
      catalog.seq.product += 1;
      product = { id: catalog.seq.product, sort: catalog.products.length, active: true };
      catalog.products.push(product);
    }
    product.name = name;
    product.price = price;
    product.stationId = stationId;
    product.category = clean(input.category, 24);
    if (input.sort !== undefined) product.sort = toInt(input.sort, product.sort);
    if (input.active !== undefined) product.active = Boolean(input.active);
    return product;
  });
}

export async function deleteProduct(id) {
  return updateCatalog((catalog) => {
    catalog.products = catalog.products.filter((p) => p.id !== toInt(id, 0));
    return { ok: true };
  });
}

// -------------------------------------------------------------------- dias

function dayPath(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new HttpError(400, 'Fecha invalida');
  return path.join(DAYS_DIR, `${day}.json`);
}

export async function getDay(day) {
  return readJson(dayPath(day), { day, lastNumber: 0, orders: [] });
}

async function updateDay(day, mutator) {
  return withLock(`day:${day}`, async () => {
    const data = await getDay(day);
    const result = await mutator(data);
    await writeJson(dayPath(day), data);
    return result;
  });
}

export async function listDays() {
  ensureDirs();
  const files = await fsp.readdir(DAYS_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

export async function listOrders({ day = businessDay(), includeVoid = true } = {}) {
  const data = await getDay(day);
  return includeVoid ? data.orders : data.orders.filter((o) => o.status !== 'void');
}

export async function getOrder(id) {
  const day = String(id || '').slice(0, 10);
  const data = await getDay(day);
  const order = data.orders.find((o) => o.id === id);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  return order;
}

/**
 * Crea un pedido. `items` viene de la interfaz: [{ productId, qty, note }].
 * Los precios y nombres se copian desde el catalogo (nunca desde el cliente)
 * y quedan congelados en el pedido para que el historial no cambie si luego
 * se edita un producto.
 */
export async function createOrder(input) {
  const catalog = await getCatalog();
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) throw new HttpError(400, 'El pedido no tiene productos');

  const items = [];
  for (const raw of rawItems) {
    const product = catalog.products.find((p) => p.id === toInt(raw.productId, 0));
    if (!product) throw new HttpError(400, `Producto ${raw.productId} no existe`);
    const qty = toInt(raw.qty, 0);
    if (qty <= 0) continue;
    const station = catalog.stations.find((s) => s.id === product.stationId) || null;
    items.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      qty,
      subtotal: product.price * qty,
      stationId: station ? station.id : null,
      stationName: station ? station.name : 'RETIRO',
      note: clean(raw.note, 40),
    });
  }
  if (!items.length) throw new HttpError(400, 'El pedido no tiene productos');

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const paymentMethod = clean(input.paymentMethod, 20) || 'efectivo';
  const amountPaid = paymentMethod === 'efectivo' ? toInt(input.amountPaid, total) : total;
  const day = businessDay();

  return updateDay(day, (data) => {
    data.lastNumber += 1;
    const number = data.lastNumber;
    const order = {
      id: `${day}-${pad(number, 4)}`,
      number,
      code: pad(number, 4),
      day,
      createdAt: localDateTime(),
      cashier: clean(input.cashier, 24) || 'Caja',
      customer: clean(input.customer, 24),
      note: clean(input.note, 80),
      paymentMethod,
      items,
      total,
      amountPaid: Math.max(amountPaid, total),
      change: Math.max(amountPaid - total, 0),
      status: 'paid',
      printCount: 0,
      lastPrintError: null,
      deliveries: {},
    };
    data.orders.push(order);
    return order;
  });
}

export async function voidOrder(id, reason) {
  const day = String(id || '').slice(0, 10);
  return updateDay(day, (data) => {
    const order = data.orders.find((o) => o.id === id);
    if (!order) throw new HttpError(404, 'Pedido no encontrado');
    if (order.status === 'void') return order;
    order.status = 'void';
    order.voidedAt = localDateTime();
    order.voidReason = clean(reason, 80);
    return order;
  });
}

export async function markDelivered(id, stationId, delivered = true) {
  const day = String(id || '').slice(0, 10);
  return updateDay(day, (data) => {
    const order = data.orders.find((o) => o.id === id);
    if (!order) throw new HttpError(404, 'Pedido no encontrado');
    const key = String(stationId ?? 'null');
    if (delivered) order.deliveries[key] = localDateTime();
    else delete order.deliveries[key];
    return order;
  });
}

export async function registerPrint(id, { error = null } = {}) {
  const day = String(id || '').slice(0, 10);
  return updateDay(day, (data) => {
    const order = data.orders.find((o) => o.id === id);
    if (!order) return null;
    if (!error) order.printCount = (order.printCount || 0) + 1;
    order.lastPrintError = error;
    return order;
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const paths = { DATA_DIR, DAYS_DIR, CATALOG_PATH };
