import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { money, wrap, businessDay, humanDate, toInt, clean } from '../src/util.js';

test('formatea montos con separador de miles', () => {
  assert.equal(money(1500), '$1.500');
  assert.equal(money(155000), '$155.000');
  assert.equal(money(0), '$0');
  assert.equal(money(-2500), '-$2.500');
});

test('corta el texto al ancho del papel sin partir palabras', () => {
  assert.deepEqual(wrap('Completo italiano grande', 12), ['Completo', 'italiano', 'grande']);
  assert.deepEqual(wrap('', 10), ['']);
  // una palabra mas larga que el papel se parte igual
  assert.deepEqual(wrap('ABCDEFGHIJKL', 5), ['ABCDE', 'FGHIJ', 'KL']);
});

test('el dia comercial no cambia a medianoche sino a la hora configurada', () => {
  assert.equal(businessDay(new Date(2026, 8, 8, 1, 30)), '2026-09-07');
  assert.equal(businessDay(new Date(2026, 8, 8, 5, 0)), '2026-09-08');
  assert.equal(businessDay(new Date(2026, 8, 8, 22, 0)), '2026-09-08');
});

test('conversiones auxiliares', () => {
  assert.equal(humanDate('2026-09-07'), '07-09-2026');
  assert.equal(toInt('$10.000'), 10000);
  assert.equal(toInt('', 5), 5);
  assert.equal(clean('  dos   espacios  '), 'dos espacios');
  assert.equal(clean('muy largo', 3), 'muy');
});
