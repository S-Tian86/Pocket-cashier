// Utilidades comunes: dinero, fechas y dia comercial.
import os from 'node:os';

import * as config from './config.js';

/** IPs de este PC en la red local (para entrar desde otros equipos). */
export function localAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

export function money(amount, { symbol = true } = {}) {
  const cur = config.get('currency', {});
  const decimals = Number(cur.decimals || 0);
  const thousands = cur.thousandsSep ?? '.';
  const decSep = cur.decimalSep ?? ',';
  const sym = symbol ? (cur.symbol ?? '$') : '';

  const negative = amount < 0;
  const value = Math.abs(Number(amount) || 0);
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  const body = decPart ? `${grouped}${decSep}${decPart}` : grouped;
  return `${negative ? '-' : ''}${sym}${body}`;
}

export function pad(number, size = 4) {
  return String(number).padStart(size, '0');
}

/**
 * Dia comercial (YYYY-MM-DD). Un bingo puede terminar pasada la medianoche,
 * por eso el dia solo cambia a la hora configurada (por defecto 05:00).
 */
export function businessDay(date = new Date()) {
  const startHour = Number(config.get('businessDayStartHour', 5)) || 0;
  const d = new Date(date.getTime());
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  return localDate(d);
}

export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localDateTime(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${localDate(d)} ${hh}:${mm}:${ss}`;
}

export function humanDate(value) {
  if (!value || value.length < 10) return value || '';
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

export function humanDateTime(value) {
  if (!value) return '';
  return `${humanDate(value)} ${value.slice(11, 16)}`.trim();
}

export function humanTime(value) {
  return value ? value.slice(11, 16) : '';
}

export function stripAccents(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function toInt(value, fallback = 0) {
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d-]/g, '');
    if (!cleaned) return fallback;
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clean(text, maxLength = 0) {
  let out = (text === null || text === undefined ? '' : String(text)).replace(/\s+/g, ' ').trim();
  if (maxLength) out = out.slice(0, maxLength);
  return out;
}

/** Corta un texto en lineas de `width` caracteres respetando palabras. */
export function wrap(text, width) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (let word of words) {
    while (word.length > width) {
      if (current) { lines.push(current); current = ''; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}
