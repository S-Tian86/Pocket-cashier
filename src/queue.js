// Cola de retiro de un stand: pedidos pendientes y ultimos entregados.
// Se filtra en el servidor porque los celulares de los stands consultan cada
// pocos segundos por el hotspot y la respuesta tiene que ser liviana.
import { getCatalog, listOrders, HttpError } from './store.js';
import { businessDay, localDateTime, toInt } from './util.js';
import { pickupLines } from './lines.js';

export const DELIVERED_LIMIT = 15;
const MAX_DELIVERED_LIMIT = 50;

/** Solo los productos del stand, sumando lineas del mismo producto con la misma nota. */
function stationItems(order, key) {
  const lines = new Map();
  for (const item of pickupLines(order)) {
    if (String(item.stationId ?? 'null') !== key) continue;
    const note = item.note || '';
    const lineKey = `${item.productId}|${note}`;
    const line = lines.get(lineKey);
    if (line) line.qty += item.qty;
    else lines.set(lineKey, { name: item.name, qty: item.qty, note });
  }
  return [...lines.values()];
}

/**
 * Arma la cola de un stand a partir de los pedidos del dia. `stationId` null
 * corresponde a los productos sin stand (su entrega se guarda con la clave 'null').
 */
export function buildStationQueue(orders, stationId, { limit = DELIVERED_LIMIT } = {}) {
  const key = String(stationId ?? 'null');
  const max = Math.min(Math.max(toInt(limit, DELIVERED_LIMIT), 0), MAX_DELIVERED_LIMIT);
  const pending = [];
  const delivered = [];

  for (const order of orders) {
    if (order.status === 'void') continue;
    const items = stationItems(order, key);
    if (!items.length) continue;
    const entry = { id: order.id, code: order.code, createdAt: order.createdAt, items };
    const deliveredAt = order.deliveries?.[key];
    if (deliveredAt) delivered.push({ ...entry, deliveredAt });
    else pending.push({ ...entry, number: order.number });
  }

  // FIFO: el que lleva mas rato esperando va primero
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  delivered.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt) || b.id.localeCompare(a.id));

  return {
    pending: pending.map(({ number, ...entry }) => entry),
    delivered: delivered.slice(0, max),
  };
}

/** `id` viene de la URL: el id numerico del stand o 'none' para los productos sin stand. */
export async function stationQueue(id, { day = businessDay(), limit } = {}) {
  let station;
  if (id === 'none') {
    station = { id: null, name: 'RETIRO' };
  } else {
    const catalog = await getCatalog();
    const found = /^\d+$/.test(String(id)) && catalog.stations.find((s) => s.id === Number(id));
    if (!found) throw new HttpError(404, 'Stand no encontrado');
    station = { id: found.id, name: found.name };
  }
  const orders = await listOrders({ day, includeVoid: false });
  // `now` permite calcular el tiempo de espera aunque el reloj del celular no coincida
  return { day, now: localDateTime(), station, ...buildStationQueue(orders, station.id, { limit }) };
}
