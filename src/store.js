// Persistencia en archivos JSON: catalogo (productos/estaciones) y un archivo
// por dia comercial con sus pedidos. Sin dependencias externas ni servidor de BD.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from './config.js';
import { businessDay, localDateTime, clean, toInt, pad } from './util.js';
import { stockNeeds } from './lines.js';

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

// colores suaves y distintos entre si para que en caja se reconozca el stand de un vistazo
export const STATION_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#d81b60', '#6d4c41'];

function parseColor(value) {
  const color = String(value ?? '').trim().toLowerCase();
  if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, 'El color debe tener el formato #rrggbb');
  return color;
}

export async function saveStation(input) {
  return updateCatalog((catalog) => {
    const name = clean(input.name, 24).toUpperCase();
    if (!name) throw new HttpError(400, 'El nombre de la estacion es obligatorio');
    let station = catalog.stations.find((s) => s.id === toInt(input.id, 0));
    if (!station) {
      catalog.seq.station += 1;
      station = {
        id: catalog.seq.station,
        name,
        sort: catalog.stations.length,
        active: true,
        color: STATION_COLORS[(catalog.seq.station - 1) % STATION_COLORS.length],
        printReceipt: true,
        printTicket: true,
      };
      catalog.stations.push(station);
    }
    station.name = name;
    if (input.sort !== undefined) station.sort = toInt(input.sort, station.sort);
    if (input.active !== undefined) station.active = Boolean(input.active);
    if (input.color !== undefined) station.color = parseColor(input.color);
    if (input.printReceipt !== undefined) station.printReceipt = Boolean(input.printReceipt);
    if (input.printTicket !== undefined) station.printTicket = Boolean(input.printTicket);
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

export function isPromo(product) {
  return Array.isArray(product?.components) && product.components.length > 0;
}

/** Stock vacio = el producto no lleva control y se vende sin limite. */
function parseStock(value) {
  if (value === null || value === undefined || value === '') return null;
  const stock = toInt(value, -1);
  if (stock < 0) throw new HttpError(400, 'El stock debe ser un numero mayor o igual a 0');
  return stock;
}

function parseComponents(raw, catalog, selfId) {
  const merged = new Map();
  for (const part of Array.isArray(raw) ? raw : []) {
    const productId = toInt(part.productId, 0);
    const qty = toInt(part.qty, 0);
    if (qty <= 0) continue;
    const product = catalog.products.find((p) => p.id === productId);
    if (!product) throw new HttpError(400, `Producto ${part.productId} no existe`);
    // una promo dentro de otra complicaria el stock y los tickets sin aportar nada
    if (isPromo(product) || productId === selfId) throw new HttpError(400, 'Una promo no puede incluir otra promo');
    merged.set(productId, (merged.get(productId) || 0) + qty);
  }
  if (!merged.size) throw new HttpError(400, 'La promo tiene que incluir al menos un producto');
  return [...merged].map(([productId, qty]) => ({ productId, qty }));
}

/**
 * Crea o edita un producto. Si trae `components` es una promo: no tiene stand ni
 * stock propio, sale de sus productos. El stock solo se toma al crear: despues
 * se cambia con adjustStock, para que un formulario abierto hace rato no pise
 * lo que se vendio mientras tanto.
 */
export async function saveProduct(input) {
  return updateCatalog((catalog) => {
    const name = clean(input.name, 40);
    if (!name) throw new HttpError(400, 'El nombre del producto es obligatorio');
    const price = toInt(input.price, -1);
    if (price < 0) throw new HttpError(400, 'El precio debe ser un numero mayor o igual a 0');
    let product = catalog.products.find((p) => p.id === toInt(input.id, 0));
    const promo = input.components !== undefined ? true : isPromo(product);

    let stationId = null;
    let components = null;
    if (promo) {
      components = input.components !== undefined ? parseComponents(input.components, catalog, product?.id) : product.components;
    } else {
      stationId = input.stationId === null || input.stationId === '' || input.stationId === undefined ? null : toInt(input.stationId, 0);
      if (stationId !== null && !catalog.stations.some((s) => s.id === stationId)) {
        throw new HttpError(400, 'La estacion indicada no existe');
      }
    }

    if (!product) {
      catalog.seq.product += 1;
      product = { id: catalog.seq.product, sort: catalog.products.length, active: true, stock: promo ? null : parseStock(input.stock) };
      catalog.products.push(product);
    }
    product.name = name;
    product.price = price;
    product.stationId = stationId;
    product.category = clean(input.category, 24);
    if (promo) product.components = components;
    if (input.sort !== undefined) product.sort = toInt(input.sort, product.sort);
    if (input.active !== undefined) product.active = Boolean(input.active);
    return product;
  });
}

/** `set` fija el stock (vacio = sin control); `add` repone o descuenta sobre lo que haya. */
export async function adjustStock(id, { set, add } = {}) {
  return updateCatalog((catalog) => {
    const product = catalog.products.find((p) => p.id === toInt(id, 0));
    if (!product) throw new HttpError(404, 'Producto no encontrado');
    if (isPromo(product)) throw new HttpError(400, 'El stock de una promo sale de los productos que incluye');
    if (set !== undefined) {
      product.stock = parseStock(set);
    } else {
      if (product.stock === null || product.stock === undefined) {
        throw new HttpError(400, `${product.name} no lleva control de stock: fija una cantidad primero`);
      }
      const next = product.stock + toInt(add, 0);
      if (next < 0) throw new HttpError(400, `No se pueden descontar mas de ${product.stock}`);
      product.stock = next;
    }
    return product;
  });
}

export async function deleteProduct(id) {
  return updateCatalog((catalog) => {
    const productId = toInt(id, 0);
    const usedIn = catalog.products.find((p) => isPromo(p) && p.components.some((c) => c.productId === productId));
    if (usedIn) throw new HttpError(400, `Esta incluido en la promo "${usedIn.name}": quitalo de ahi antes de borrarlo`);
    catalog.products = catalog.products.filter((p) => p.id !== productId);
    return { ok: true };
  });
}

/**
 * Descuenta el stock de todo el pedido o de nada: si un producto no alcanza,
 * no se toca ninguno. Devuelve lo descontado para poder devolverlo al anular.
 */
async function reserveStock(needs) {
  return updateCatalog((catalog) => {
    const tracked = [];
    for (const [productId, qty] of needs) {
      const product = catalog.products.find((p) => p.id === productId);
      if (!product || product.stock === null || product.stock === undefined) continue;
      if (product.stock < qty) {
        throw new HttpError(409, product.stock > 0
          ? `Solo quedan ${product.stock} de ${product.name}`
          : `${product.name} esta agotado`);
      }
      tracked.push([product, qty]);
    }
    const applied = {};
    for (const [product, qty] of tracked) {
      product.stock -= qty;
      applied[product.id] = qty;
    }
    return applied;
  });
}

async function releaseStock(applied) {
  const entries = Object.entries(applied || {});
  if (!entries.length) return;
  await updateCatalog((catalog) => {
    for (const [productId, qty] of entries) {
      const product = catalog.products.find((p) => p.id === Number(productId));
      // si le quitaron el control de stock despues de la venta, no hay nada que devolver
      if (product && product.stock !== null && product.stock !== undefined) product.stock += qty;
    }
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
 * se edita un producto. El stock se valida aqui y no en la caja: dos cajas
 * pueden estar vendiendo la ultima unidad al mismo tiempo.
 */
export async function createOrder(input) {
  const catalog = await getCatalog();
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) throw new HttpError(400, 'El pedido no tiene productos');

  const stationOf = (product) => catalog.stations.find((s) => s.id === product.stationId) || null;
  const items = [];
  for (const raw of rawItems) {
    const product = catalog.products.find((p) => p.id === toInt(raw.productId, 0));
    if (!product) throw new HttpError(400, `Producto ${raw.productId} no existe`);
    const qty = toInt(raw.qty, 0);
    if (qty <= 0) continue;
    const item = {
      productId: product.id,
      name: product.name,
      price: product.price,
      qty,
      subtotal: product.price * qty,
      stationId: null,
      stationName: 'RETIRO',
      note: clean(raw.note, 40),
    };
    if (isPromo(product)) {
      // se congela el contenido de la promo: si despues se edita, el pedido no cambia
      item.components = product.components.map((part) => {
        const base = catalog.products.find((p) => p.id === part.productId);
        if (!base) throw new HttpError(400, `La promo ${product.name} incluye un producto que ya no existe`);
        const station = stationOf(base);
        const component = {
          productId: base.id,
          name: base.name,
          qty: part.qty,
          price: base.price,
          stationId: station ? station.id : null,
          stationName: station ? station.name : 'RETIRO',
        };
        if (station?.printTicket === false) component.noTicket = true;
        if (station?.printReceipt === false) component.noReceipt = true;
        return component;
      });
      if (item.components.every((component) => component.noReceipt)) item.noReceipt = true;
    } else {
      const station = stationOf(product);
      item.stationId = station ? station.id : null;
      item.stationName = station ? station.name : 'RETIRO';
      // se congela como el nombre: una reimpresion respeta lo que valia al cobrar
      if (station?.printTicket === false) item.noTicket = true;
      if (station?.printReceipt === false) item.noReceipt = true;
    }
    items.push(item);
  }
  if (!items.length) throw new HttpError(400, 'El pedido no tiene productos');

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const paymentMethod = clean(input.paymentMethod, 20) || 'efectivo';
  const amountPaid = paymentMethod === 'efectivo' ? toInt(input.amountPaid, total) : total;
  const day = businessDay();

  const stock = await reserveStock(stockNeeds(items));
  try {
    return await saveNewOrder(day, input, { items, total, paymentMethod, amountPaid, stock });
  } catch (err) {
    await releaseStock(stock); // el pedido no quedo guardado: el stock vuelve
    throw err;
  }
}

function saveNewOrder(day, input, { items, total, paymentMethod, amountPaid, stock }) {
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
      stock, // lo descontado del stock: al anular se devuelve exactamente esto
    };
    data.orders.push(order);
    return order;
  });
}

export async function voidOrder(id, reason) {
  const day = String(id || '').slice(0, 10);
  let justVoided = false;
  const voided = await updateDay(day, (data) => {
    const order = data.orders.find((o) => o.id === id);
    if (!order) throw new HttpError(404, 'Pedido no encontrado');
    if (order.status === 'void') return order;
    order.status = 'void';
    order.voidedAt = localDateTime();
    order.voidReason = clean(reason, 80);
    justVoided = true;
    return order;
  });
  // solo la primera anulacion devuelve el stock; anular dos veces no lo duplica
  if (justVoided) await releaseStock(voided.stock);
  return voided;
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
  /** `auth` ('code' | 'pin' | 'role') le indica a la pantalla que falta para seguir. */
  constructor(status, message, auth) {
    super(message);
    this.status = status;
    if (auth) this.auth = auth;
  }
}

export const paths = { DATA_DIR, DAYS_DIR, CATALOG_PATH };
