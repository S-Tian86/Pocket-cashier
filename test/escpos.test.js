import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ticket, encodeText } from '../src/escpos.js';

test('codifica acentos al codepage de la impresora', () => {
  assert.deepEqual([...encodeText('niño', 'cp850')], [0x6e, 0x69, 0xa4, 0x6f]);
  assert.deepEqual([...encodeText('Á', 'cp850')], [0xb5]);
  // CP437 no tiene A con tilde: se degrada a ASCII en vez de imprimir basura
  assert.deepEqual([...encodeText('Á', 'cp437')], [0x41]);
  assert.deepEqual([...encodeText('café', 'ascii')], [0x63, 0x61, 0x66, 0x65]);
});

test('las columnas ocupan exactamente el ancho del papel', () => {
  const ticket = new Ticket({ width: 32 });
  ticket.cols('TOTAL', '$6.200');
  assert.equal(ticket.lines.at(-1).text.length, 32);
  assert.match(ticket.lines.at(-1).text, /^TOTAL {21}\$6\.200$/);
});

test('el texto doble ancho usa la mitad de caracteres por linea', () => {
  const ticket = new Ticket({ width: 32 });
  assert.equal(ticket.usableWidth, 32);
  ticket.size(2, 2);
  assert.equal(ticket.usableWidth, 16);
  ticket.sep('-');
  assert.equal(ticket.lines.at(-1).text.length, 16);
});

test('incluye inicializacion, corte y codigo de barras', () => {
  const ticket = new Ticket({ width: 32 });
  ticket.line('hola').code('0042', 'code39').cut({ feedLines: 2 });
  const bytes = ticket.build();
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]); // ESC @
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x6b, 69]))); // GS k CODE39
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))); // corte parcial
});

test('desactiva el modo chino solo cuando se pide', () => {
  const plain = new Ticket({ width: 32, codepage: 2 }).build();
  assert.deepEqual([...plain.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 2]); // ESC @, ESC t 2
  const noChinese = new Ticket({ width: 32, codepage: 2, cancelChineseMode: true }).build();
  // FS . debe ir antes de ESC t: en modo chino la impresora ignora el cambio de codepage
  assert.deepEqual([...noChinese.subarray(0, 7)], [0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, 2]);
});

test('sin guillotina no manda el corte e imprime una linea para la tijera', () => {
  const ticket = new Ticket({ width: 32 });
  ticket.line('hola').cut({ feedLines: 2, paperCut: false });
  assert.ok(!ticket.build().includes(Buffer.from([0x1d, 0x56]))); // sin GS V
  const guide = ticket.lines.find((line) => line.text.startsWith('8<'));
  assert.equal(guide.text.length, 32);
});

test('el codigo de barras descarta caracteres no soportados', () => {
  const ticket = new Ticket({ width: 32 });
  ticket.barcode('año-42');
  assert.equal(ticket.lines.at(-1).text, 'AO-42');
});
