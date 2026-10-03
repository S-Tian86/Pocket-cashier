// Diseno de los documentos que salen por la impresora:
//   - el ticket de venta del cliente (detalle + total pagado + vuelto)
//   - un ticket de retiro por cada estacion/stand del pedido
//   - el cierre de caja del dia
import * as config from './config.js';
import { Ticket } from './escpos.js';
import { money, humanDate, humanDateTime, humanTime } from './util.js';
import { pickupLines } from './lines.js';

export const PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  debito: 'Debito',
  credito: 'Credito',
  transferencia: 'Transferencia',
  otro: 'Otro',
};

export function paymentLabel(method) {
  return PAYMENT_LABELS[method] || method || 'Otro';
}

function newTicket() {
  const printer = config.get('printer', {});
  return new Ticket({
    width: Number(printer.charsPerLine) || 32,
    encoding: printer.encoding || 'cp850',
    codepage: printer.codepage,
    cancelChineseMode: Boolean(printer.cancelChineseMode),
  });
}

function header(ticket) {
  const business = config.get('business', {});
  ticket.align('center');
  if (business.name) {
    ticket.size(1, 2).bold(true).wrapped(business.name).bold(false).size(1, 1);
  }
  if (business.subtitle) ticket.wrapped(business.subtitle);
  if (business.extraLine) ticket.wrapped(business.extraLine);
  ticket.align('left');
  return ticket;
}

/** `message: false` omite el pie del negocio ("Gracias por su compra"): solo va en el ticket de venta. */
function footer(ticket, order, { message = true } = {}) {
  const business = config.get('business', {});
  const barcodeMode = config.get('printer.barcode', 'code39');
  const footerText = message ? business.footer : '';
  const hasCode = Boolean(order) && barcodeMode !== 'none';
  ticket.reset();
  if (!footerText && !hasCode) return ticket;
  ticket.feed(1).align('center');
  if (footerText) ticket.wrapped(footerText);
  if (order) ticket.code(order.code, barcodeMode);
  ticket.align('left');
  return ticket;
}

/** Cierre de cada documento: corte con guillotina o, si no tiene, una linea para cortar con tijera. */
function finish(ticket) {
  const printer = config.get('printer', {});
  return ticket.cut({ feedLines: Number(printer.feedLines ?? 3), paperCut: printer.cut !== false });
}

/** Agrupa los productos por estacion: una estacion = un ticket de retiro. Las promos van abiertas. */
export function groupByStation(order) {
  const groups = new Map();
  for (const line of pickupLines(order)) {
    const key = String(line.stationId ?? 'null');
    if (!groups.has(key)) {
      groups.set(key, { stationId: line.stationId ?? null, stationName: line.stationName || 'RETIRO', noTicket: line.noTicket, items: [] });
    }
    groups.get(key).items.push(line);
  }
  return [...groups.values()];
}

/**
 * Stands que llevan ticket de retiro. Los que no (ej: entradas, que solo se
 * cobran para la cuadratura) siguen en el cierre pero no gastan papel.
 */
export function ticketGroups(order) {
  return groupByStation(order).filter((group) => !group.noTicket);
}

export function buildReceipt(order, { copyLabel = '' } = {}) {
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');

  ticket.align('center').size(2, 2).bold(true).line(`PEDIDO ${order.code}`).bold(false).size(1, 1);
  ticket.line(order.status === 'void' ? '*** ANULADO ***' : 'TICKET DE VENTA');
  if (copyLabel) ticket.line(copyLabel);
  ticket.align('left').sep();

  ticket.cols('Fecha', humanDateTime(order.createdAt));
  ticket.cols('Caja', order.cashier || '-');
  if (order.customer) ticket.cols('Cliente', order.customer);
  ticket.sep();

  for (const item of order.items) {
    ticket.wrapped(item.name);
    ticket.cols(`  ${item.qty} x ${money(item.price)}`, money(item.subtotal));
    for (const component of item.components || []) {
      ticket.wrapped(`- ${component.qty * item.qty} ${component.name}`, { indent: '  ' });
    }
    if (item.note) ticket.wrapped(`(${item.note})`, { indent: '  ' });
  }

  ticket.sep();
  ticket.bold(true).size(1, 2).cols('TOTAL', money(order.total)).size(1, 1).bold(false);
  ticket.cols(paymentLabel(order.paymentMethod), money(order.amountPaid));
  if (order.change > 0) ticket.cols('Vuelto', money(order.change));
  ticket.cols('Articulos', String(order.items.reduce((sum, item) => sum + item.qty, 0)));

  const groups = ticketGroups(order);
  if (groups.length) {
    ticket.sep();
    ticket.line(groups.length > 1 ? `RETIRA EN ${groups.length} STANDS:` : 'RETIRA EN:');
    groups.forEach((group, index) => {
      ticket.line(` ${index + 1}. ${group.stationName}`);
    });
  }
  if (order.note) {
    ticket.sep();
    ticket.wrapped(`Nota: ${order.note}`);
  }

  footer(ticket, order);
  finish(ticket);
  return ticket;
}

/**
 * Numero del ticket de retiro con la inicial del stand (B-0004): en la fila del
 * stand se distingue de un vistazo un ticket que va a otro stand.
 */
export function pickupCode(order, group) {
  const initial = group.stationId == null
    ? ''
    : (String(group.stationName || '').normalize('NFD').match(/[a-z0-9]/i)?.[0] || '').toUpperCase();
  return initial ? `${initial}-${order.code}` : `PEDIDO ${order.code}`;
}

export function buildStationTicket(order, group, index, totalTickets) {
  // compacto a proposito: sale uno por stand en cada pedido y es el que mas papel gasta
  const ticket = newTicket();
  ticket.align('center');
  ticket.size(2, 2).bold(true).line(pickupCode(order, group)).bold(false).size(1, 1);
  if (order.status === 'void') ticket.bold(true).line('*** ANULADO ***').bold(false);
  ticket.align('left').sep();
  ticket.spans([{ text: 'Retira en: ' }, { text: group.stationName, scaleH: 2, bold: true }]);
  ticket.sep();

  for (const item of group.items) {
    ticket.size(1, 2);
    ticket.wrapped(`${item.qty} x ${item.name}`);
    ticket.size(1, 1);
    // el ticket de venta dice el nombre de la promo: el stand ve de cual viene para cuadrar
    if (item.promo) ticket.wrapped(`de: ${item.promo}`, { indent: '   ' });
    if (item.note) ticket.wrapped(`(${item.note})`, { indent: '   ' });
  }

  ticket.sep();
  if (order.customer) ticket.wrapped(`Cliente: ${order.customer}`);
  if (order.note) ticket.wrapped(`Nota: ${order.note}`);
  const info = [`Caja: ${order.cashier || '-'}`, humanTime(order.createdAt)];
  if (totalTickets > 1) info.push(`${index + 1} de ${totalTickets}`);
  ticket.wrapped(info.join(' - '));

  footer(ticket, order, { message: false });
  finish(ticket);
  return ticket;
}

/**
 * Arma todos los documentos de un pedido.
 * `what`: 'all' | 'receipt' | 'stations' | 'station:<id>'
 */
export function buildOrderDocuments(order, { what = 'all' } = {}) {
  const tickets = config.get('tickets', {});
  const documents = [];
  const groups = ticketGroups(order);

  // sin ticket de venta si todo es de stands que no lo llevan (ej: solo entradas); si se
  // mezcla, sale completo para que el total cuadre con lo pagado
  const receiptNeeded = order.items.some((item) => !item.noReceipt);
  const wantsReceipt = what === 'all' ? tickets.printReceipt !== false && receiptNeeded : what === 'receipt';
  const wantsStations = what === 'all' ? tickets.printStationTickets !== false : what === 'stations' || what.startsWith('station:');

  if (wantsReceipt) {
    const copies = what === 'receipt' ? 1 : Math.max(1, Number(tickets.receiptCopies) || 1);
    for (let copy = 0; copy < copies; copy += 1) {
      documents.push({
        kind: 'receipt',
        stationId: null,
        title: `Venta ${order.code}`,
        ticket: buildReceipt(order, { copyLabel: copy > 0 ? 'COPIA' : '' }),
      });
    }
  }

  if (wantsStations) {
    const only = what.startsWith('station:') ? what.slice('station:'.length) : null;
    const copies = only ? 1 : Math.max(1, Number(tickets.stationTicketCopies) || 1);
    // pedido a mano desde Pedidos: se imprime aunque el stand no lleve ticket
    const selected = only === null ? groups : groupByStation(order).filter((group) => String(group.stationId ?? 'null') === only);
    selected.forEach((group) => {
      const found = groups.indexOf(groups.find((g) => g.stationId === group.stationId));
      const [index, total] = found === -1 ? [0, 1] : [found, groups.length];
      for (let copy = 0; copy < copies; copy += 1) {
        documents.push({
          kind: 'station',
          stationId: group.stationId,
          title: `Retiro ${group.stationName} (${index + 1}/${total})`,
          ticket: buildStationTicket(order, group, index, total),
        });
      }
    });
  }

  return documents;
}

export function buildClosingReport(report) {
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');
  ticket.align('center').bold(true).size(1, 2).line('CIERRE DE CAJA').size(1, 1).bold(false);
  ticket.line(humanDate(report.day));
  ticket.line(`Emitido ${humanDateTime(report.generatedAt)}`);
  ticket.align('left').sep();

  ticket.cols('Pedidos', String(report.ordersCount));
  if (report.voidedCount) ticket.cols('Anulados', String(report.voidedCount));
  if (report.firstOrderAt) ticket.cols('Primer pedido', humanTime(report.firstOrderAt));
  if (report.lastOrderAt) ticket.cols('Ultimo pedido', humanTime(report.lastOrderAt));
  ticket.cols('Articulos vendidos', String(report.itemsCount));

  ticket.sep();
  ticket.bold(true).line('MEDIOS DE PAGO').bold(false);
  for (const row of report.byPayment) {
    ticket.cols(`${paymentLabel(row.key)} (${row.orders})`, money(row.total));
  }

  ticket.sep();
  ticket.bold(true).line('VENTAS POR PRODUCTO').bold(false);
  for (const row of report.byProduct) {
    ticket.wrapped(row.name);
    ticket.cols(`  ${row.qty} x ${money(row.price)}`, money(row.total));
  }

  if (report.byStation.length > 1) {
    ticket.sep();
    ticket.bold(true).line('POR STAND').bold(false);
    for (const row of report.byStation) {
      ticket.cols(`${row.name} (${row.qty})`, money(row.total));
    }
  }

  if (report.byCashier.length > 1) {
    ticket.sep();
    ticket.bold(true).line('POR CAJA').bold(false);
    for (const row of report.byCashier) {
      ticket.cols(`${row.name} (${row.orders})`, money(row.total));
    }
  }

  ticket.sep('=');
  ticket.bold(true).size(1, 2).cols('TOTAL', money(report.total)).size(1, 1).bold(false);
  if (report.cashTotal !== report.total) ticket.cols('Efectivo en caja', money(report.cashTotal));
  if (report.voidedTotal) ticket.cols('Anulado (no suma)', money(report.voidedTotal));

  ticket.feed(1).align('center').line('Firma: ______________');
  ticket.align('left');
  finish(ticket);
  return ticket;
}

/** Ticket para repartir: QR que entra directo con el codigo, mas el codigo escrito por si no hay camara. */
export function buildAccessTicket({ role, code, url }) {
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');
  ticket.align('center').bold(true).size(2, 2).line(role === 'stand' ? 'STAND' : 'CAJA').size(1, 1).bold(false);
  ticket.line(role === 'stand' ? 'Ver y entregar pedidos' : 'Cobrar pedidos');
  ticket.feed(1);
  ticket.qr(`${url}/login.html#code=${code}`, { size: 5 });
  ticket.feed(1);
  ticket.line('Escanea con la camara');
  ticket.line('o entra a:');
  ticket.align('left').wrapped(url);
  ticket.align('center').line('y escribe el codigo:');
  ticket.bold(true).size(2, 2).line(code).size(1, 1).bold(false);
  ticket.align('left');
  finish(ticket);
  return ticket;
}

export function buildTestTicket() {
  const printer = config.get('printer', {});
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');
  ticket.align('center').bold(true).size(2, 2).line('PRUEBA').size(1, 1).bold(false);
  ticket.align('left').sep();
  ticket.line('Acentos: a\u00f1os, ni\u00f1o, PA\u00d1OL');
  ticket.line('Vocales: \u00e1\u00e9\u00ed\u00f3\u00fa \u00c1\u00c9\u00cd\u00d3\u00da');
  ticket.line('Signos: \u00bfcu\u00e1nto? \u00a11.000!');
  ticket.cols('Ancho', `${printer.charsPerLine} caracteres`);
  ticket.cols('Codificacion', String(printer.encoding));
  ticket.cols('Modo', String(printer.mode));
  ticket.sep();
  ticket.line('1234567890'.repeat(4).slice(0, Number(printer.charsPerLine) || 32));
  ticket.align('center').code('PRUEBA1', config.get('printer.barcode', 'code39'));
  ticket.align('left');
  finish(ticket);
  return ticket;
}
