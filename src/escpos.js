// Generador de comandos ESC/POS para impresoras termicas de 58mm (y 80mm).
// Ademas de los bytes, guarda una version en texto de cada linea para poder
// mostrar una vista previa en pantalla o imprimir desde el navegador.
import { wrap, stripAccents } from './util.js';

const ESC = 0x1b;
const GS = 0x1d;

// Tabla base compartida por CP437 / CP850 / CP858.
const BASE_CP = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'å': 0x86, 'ç': 0x87,
  'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'Å': 0x8f,
  'É': 0x90, 'æ': 0x91, 'Æ': 0x92, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97,
  'ÿ': 0x98, 'Ö': 0x99, 'Ü': 0x9a,
  'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7,
  '¿': 0xa8, '¬': 0xaa, '½': 0xab, '¼': 0xac, '¡': 0xad, '«': 0xae, '»': 0xaf,
  '°': 0xf8, '·': 0xfa, '²': 0xfd,
};

const CP437_EXTRA = { '¢': 0x9b, '£': 0x9c, '¥': 0x9d, 'ƒ': 0x9f, 'ß': 0xe1, 'µ': 0xe6 };

const CP850_EXTRA = {
  'ø': 0x9b, '£': 0x9c, 'Ø': 0x9d, '×': 0x9e, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7,
  '©': 0xb8, '¢': 0xbd, '¥': 0xbe, 'ã': 0xc6, 'Ã': 0xc7, 'ð': 0xd0, 'Ð': 0xd1,
  'Ê': 0xd2, 'Ë': 0xd3, 'È': 0xd4, 'Í': 0xd6, 'Î': 0xd7, 'Ï': 0xd8,
  'Ó': 0xe0, 'ß': 0xe1, 'Ô': 0xe2, 'Ò': 0xe3, 'õ': 0xe4, 'Õ': 0xe5, 'µ': 0xe6,
  'Ú': 0xe9, 'Û': 0xea, 'Ù': 0xeb, 'ý': 0xec, 'Ý': 0xed, '¯': 0xee, '´': 0xef,
};

const CODEPAGES = {
  cp437: { ...BASE_CP, ...CP437_EXTRA },
  cp850: { ...BASE_CP, ...CP850_EXTRA },
  cp858: { ...BASE_CP, ...CP850_EXTRA, '€': 0xd5 },
};

/** Codifica texto al juego de caracteres de la impresora, con degradacion elegante. */
export function encodeText(text, encoding = 'cp850') {
  const name = String(encoding || '').toLowerCase().replace(/[-_ ]/g, '');
  const input = String(text ?? '');

  if (name === 'latin1' || name === 'cp1252' || name === 'iso88591' || name === 'windows1252') {
    const bytes = [];
    for (const char of input) {
      const code = char.codePointAt(0);
      bytes.push(code <= 0xff ? code : asciiFallback(char));
    }
    return Buffer.from(bytes);
  }
  if (name === 'ascii') {
    return Buffer.from([...input].map((char) => asciiFallback(char)));
  }

  const table = CODEPAGES[name] || CODEPAGES.cp850;
  const bytes = [];
  for (const char of input) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (table[char] !== undefined) bytes.push(table[char]);
    else bytes.push(asciiFallback(char));
  }
  return Buffer.from(bytes);
}

function asciiFallback(char) {
  const plain = stripAccents(char);
  const code = plain.codePointAt(0);
  return code !== undefined && code < 0x80 ? code : 0x3f; // '?'
}

export class Ticket {
  constructor({ width = 32, encoding = 'cp850', codepage = 2 } = {}) {
    this.width = width;
    this.encoding = encoding;
    this.chunks = [];
    this.lines = []; // vista previa
    this.state = { align: 'left', bold: false, scaleW: 1, scaleH: 1 };
    this.raw([ESC, 0x40]); // inicializar
    if (codepage !== null && codepage !== undefined) this.raw([ESC, 0x74, Number(codepage)]);
  }

  /** Ancho util en caracteres segun la escala horizontal actual. */
  get usableWidth() {
    return Math.max(1, Math.floor(this.width / this.state.scaleW));
  }

  raw(bytes) {
    this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return this;
  }

  align(mode = 'left') {
    const map = { left: 0, center: 1, right: 2 };
    this.state.align = mode;
    return this.raw([ESC, 0x61, map[mode] ?? 0]);
  }

  bold(on = true) {
    this.state.bold = Boolean(on);
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  size(scaleW = 1, scaleH = 1) {
    const w = Math.min(Math.max(scaleW, 1), 8);
    const h = Math.min(Math.max(scaleH, 1), 8);
    this.state.scaleW = w;
    this.state.scaleH = h;
    return this.raw([GS, 0x21, ((w - 1) << 4) | (h - 1)]);
  }

  /** Vuelve al estilo base: izquierda, sin negrita, tamano normal. */
  reset() {
    return this.size(1, 1).bold(false).align('left');
  }

  line(text = '') {
    for (const piece of String(text).split('\n')) {
      this.raw(encodeText(piece, this.encoding));
      this.raw([0x0a]);
      this.lines.push({
        text: piece,
        align: this.state.align,
        bold: this.state.bold,
        scaleW: this.state.scaleW,
        scaleH: this.state.scaleH,
      });
    }
    return this;
  }

  /** Escribe respetando el ancho del papel, cortando por palabras. */
  wrapped(text, { indent = '' } = {}) {
    const width = this.usableWidth - indent.length;
    for (const piece of wrap(text, width)) this.line(indent + piece);
    return this;
  }

  /** Dos columnas: etiqueta a la izquierda, valor pegado a la derecha. */
  cols(left, right) {
    const width = this.usableWidth;
    const rightText = String(right ?? '');
    const leftText = String(left ?? '');
    const space = width - rightText.length;
    if (space <= 0) return this.line(rightText.slice(0, width));
    const head = leftText.length > space - 1 ? leftText.slice(0, Math.max(space - 1, 0)) : leftText;
    return this.line(head + ' '.repeat(Math.max(width - head.length - rightText.length, 0)) + rightText);
  }

  sep(char = '-') {
    return this.line(char.repeat(this.usableWidth));
  }

  feed(lines = 1) {
    if (lines > 0) this.raw([ESC, 0x64, lines]);
    for (let i = 0; i < lines; i += 1) this.lines.push({ text: '', align: 'left', bold: false, scaleW: 1, scaleH: 1 });
    return this;
  }

  cut({ feedLines = 3 } = {}) {
    this.reset();
    this.feed(feedLines);
    return this.raw([GS, 0x56, 0x42, 0x00]); // corte parcial
  }

  drawer() {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  /** Codigo de barras CODE39 (solo 0-9 A-Z y - . $ / + % espacio). */
  barcode(data, { height = 60, width = 2, hri = 2 } = {}) {
    const payload = String(data).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '');
    if (!payload) return this;
    this.raw([GS, 0x68, height]); // altura
    this.raw([GS, 0x77, width]); // ancho de modulo
    this.raw([GS, 0x48, hri]); // texto legible (2 = debajo)
    this.raw([GS, 0x66, 0x00]); // fuente del texto legible
    this.raw([GS, 0x6b, 69, payload.length]);
    this.raw(Buffer.from(payload, 'ascii'));
    this.lines.push({ text: payload, align: this.state.align, bold: false, scaleW: 1, scaleH: 1, barcode: true });
    return this;
  }

  qr(data, { size = 6 } = {}) {
    const payload = Buffer.from(String(data), 'utf8');
    const length = payload.length + 3;
    this.raw([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]); // modelo 2
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size]); // tamano de modulo
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]); // correccion de errores M
    this.raw([GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30]);
    this.raw(payload);
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]); // imprimir
    this.lines.push({ text: String(data), align: this.state.align, bold: false, scaleW: 1, scaleH: 1, qr: true });
    return this;
  }

  /** Imprime el codigo del pedido segun lo configurado. */
  code(value, mode = 'code39') {
    if (!value || mode === 'none') return this;
    this.align('center');
    if (mode === 'qr') this.qr(value);
    else this.barcode(value);
    return this.align('left');
  }

  build() {
    return Buffer.concat(this.chunks);
  }

  /** Texto plano centrado segun el ancho del papel (para vista previa). */
  previewText() {
    return this.lines
      .map((line) => {
        const width = Math.floor(this.width / line.scaleW);
        const text = line.text.slice(0, width);
        if (line.align === 'center') {
          const padding = Math.floor((width - text.length) / 2);
          return ' '.repeat(Math.max(padding, 0)) + text;
        }
        if (line.align === 'right') return ' '.repeat(Math.max(width - text.length, 0)) + text;
        return text;
      })
      .join('\n');
  }
}
