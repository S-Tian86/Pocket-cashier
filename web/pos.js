// Pantalla de caja: catalogo, carro y cobro.
import { api, loadConfig, state, money, parseAmount, el, toast, openModal, renderTopbar, getCashier, refreshPrinterStatus } from './common.js';

const cart = new Map(); // productId -> { product, qty, note }
let category = 'TODOS';

const $ = (id) => document.getElementById(id);

init().catch((err) => {
  document.body.innerHTML = `<main class="card"><h2>No se pudo iniciar la caja</h2><p>${err.message}</p></main>`;
});

async function init() {
  await loadConfig();
  document.title = `Caja - ${state.config.business.name}`;
  renderTopbar('caja');
  restoreCart();
  renderTabs();
  renderProducts();
  renderCart();

  $('search').addEventListener('input', renderProducts);
  $('search').addEventListener('keydown', onSearchKey);
  $('btn-clear').addEventListener('click', () => clearCart({ confirm: true }));
  $('btn-charge').addEventListener('click', openChargeDialog);
  $('btn-charge-2').addEventListener('click', openChargeDialog);
  $('btn-charge-3').addEventListener('click', openChargeDialog);
  $('bar-detail').addEventListener('click', () => document.querySelector('.cart').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.addEventListener('keydown', onGlobalKey);
  setInterval(refreshPrinterStatus, 60000);
  $('search').focus();
}

// ------------------------------------------------------------------ catalogo

function activeProducts() {
  return state.config.products
    .filter((product) => product.active !== false)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
}

function categories() {
  const found = new Set(activeProducts().map((product) => product.category || 'Otros'));
  return ['TODOS', ...[...found].sort()];
}

function stationName(product) {
  return state.config.stations.find((station) => station.id === product.stationId)?.name || 'RETIRO';
}

function renderTabs() {
  const list = categories();
  $('tabs').replaceChildren(...list.map((name) => el('button', {
    class: `tab ${name === category ? 'active' : ''}`,
    text: name === 'TODOS' ? 'Todos' : name,
    onclick: () => { category = name; renderTabs(); renderProducts(); },
  })));
  $('tabs').style.display = list.length > 2 ? '' : 'none';
}

function normalize(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function visibleProducts() {
  const raw = $('search').value.trim();
  const term = /^\d+$/.test(raw) ? '' : normalize(raw); // solo digitos = cantidad
  return activeProducts().filter((product) => {
    const matchesCategory = category === 'TODOS' || (product.category || 'Otros') === category;
    const matchesTerm = !term || normalize(product.name).includes(term);
    return matchesCategory && matchesTerm;
  });
}

function renderProducts() {
  const products = visibleProducts();
  const grid = $('grid');
  if (!products.length) {
    grid.replaceChildren(el('p', { class: 'muted', text: 'No hay productos que coincidan. Agregalos en Ajustes.' }));
    return;
  }
  grid.replaceChildren(...products.map((product) => {
    const inCart = cart.get(product.id);
    return el('div', {
      class: `product ${inCart ? 'in-cart' : ''}`,
      role: 'button',
      tabindex: '0',
      onclick: () => addToCart(product),
      onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); addToCart(product); } },
    }, [
      el('span', { class: 'name', text: product.name }),
      el('span', { class: 'meta' }, [
        el('span', { class: 'price', text: money(product.price) }),
        inCart
          // ya esta en el pedido: se ajusta la cantidad aqui mismo, sin abrir el teclado
          ? el('span', { class: 'stepper' }, [
            stepButton('-', 'Quitar uno', () => setQty(product.id, inCart.qty - 1)),
            el('span', { class: 'badge', text: `${inCart.qty}` }),
            stepButton('+', 'Agregar uno', () => setQty(product.id, inCart.qty + 1)),
          ])
          : el('span', { class: 'station', text: stationName(product) }),
      ]),
    ]);
  }));
}

/** Boton +/- dentro de la tarjeta: no debe disparar el click de la tarjeta. */
function stepButton(label, title, action) {
  return el('button', {
    class: 'qty-btn',
    title,
    'aria-label': title,
    onclick: (event) => { event.stopPropagation(); action(); },
  }, [label]);
}

// --------------------------------------------------------------------- carro

function pendingQty() {
  const raw = $('search').value.trim();
  return /^\d+$/.test(raw) ? Math.min(Number.parseInt(raw, 10), 99) : 1;
}

function addToCart(product, qty = pendingQty()) {
  const entry = cart.get(product.id) || { product, qty: 0, note: '' };
  entry.product = product;
  entry.qty += qty;
  cart.set(product.id, entry);
  if (/^\d+$/.test($('search').value.trim())) $('search').value = '';
  saveCart();
  renderCart();
  renderProducts();
}

function setQty(productId, qty) {
  const entry = cart.get(productId);
  if (!entry) return;
  if (qty <= 0) cart.delete(productId);
  else entry.qty = qty;
  saveCart();
  renderCart();
  renderProducts();
}

/** Nota de una linea (ej: "sin mayo"): sale bajo el producto en la boleta y en el ticket del stand. */
function editNote(productId) {
  const entry = cart.get(productId);
  if (!entry) return;
  // 40 es el largo que guarda el servidor por producto
  const input = el('input', { placeholder: 'Ej: sin mayo, 1 sin tomate', maxlength: 40, value: entry.note || '' });
  const save = () => {
    entry.note = input.value.trim();
    saveCart();
    renderCart();
    close();
  };
  const { close } = openModal([
    el('h2', { text: `Nota para ${entry.product.name}` }),
    el('p', { class: 'sub', text: `Aplica a las ${entry.qty} unidades. Si solo es para algunas, indicalo (ej: 1 sin mayo).` }),
    el('div', { class: 'field' }, [input]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn ghost', onclick: () => close() }, ['Cancelar']),
      el('button', { class: 'btn', onclick: save }, ['Guardar']),
    ]),
  ]);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
  setTimeout(() => input.focus(), 30);
}

function cartTotal() {
  return [...cart.values()].reduce((sum, entry) => sum + entry.product.price * entry.qty, 0);
}

function cartCount() {
  return [...cart.values()].reduce((sum, entry) => sum + entry.qty, 0);
}

function renderCart() {
  const items = $('cart-items');
  if (!cart.size) {
    items.replaceChildren(el('p', { class: 'empty', text: 'Toca un producto para agregarlo al pedido.' }));
  } else {
    items.replaceChildren(...[...cart.values()].map((entry) => el('div', { class: 'line' }, [
      el('span', { class: 'name', text: entry.product.name }),
      el('span', { class: 'total', text: money(entry.product.price * entry.qty) }),
      entry.note ? el('span', { class: 'note', text: entry.note }) : null,
      el('span', { class: 'sub' }, [
        el('button', { class: 'qty-btn', title: 'Quitar uno', onclick: () => setQty(entry.product.id, entry.qty - 1) }, ['-']),
        el('span', { class: 'qty', text: String(entry.qty) }),
        el('button', { class: 'qty-btn', title: 'Agregar uno', onclick: () => setQty(entry.product.id, entry.qty + 1) }, ['+']),
        el('span', { text: `${money(entry.product.price)} c/u` }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'link-btn neutral', onclick: () => editNote(entry.product.id) }, [entry.note ? 'Editar nota' : 'Nota']),
        el('button', { class: 'link-btn', onclick: () => setQty(entry.product.id, 0) }, ['Quitar']),
      ]),
    ])));
  }
  $('cart-total').textContent = money(cartTotal());
  $('cart-count').textContent = `${cartCount()} art.`;
  $('bar-total').textContent = money(cartTotal());
  $('bar-count').textContent = `${cartCount()} art.`;
  const disabled = cart.size === 0;
  $('btn-charge').disabled = disabled;
  $('btn-charge-2').disabled = disabled;
  $('btn-charge-3').disabled = disabled;
}

function clearCart({ confirm = false } = {}) {
  if (confirm && cart.size && !window.confirm('Vaciar el pedido actual?')) return;
  cart.clear();
  saveCart();
  renderCart();
  renderProducts();
  $('search').value = '';
  $('search').focus();
}

function saveCart() {
  const data = [...cart.values()].map((entry) => ({ id: entry.product.id, qty: entry.qty, note: entry.note || '' }));
  localStorage.setItem('cart', JSON.stringify(data));
}

function restoreCart() {
  try {
    for (const row of JSON.parse(localStorage.getItem('cart') || '[]')) {
      const product = state.config.products.find((item) => item.id === row.id && item.active !== false);
      if (product) cart.set(product.id, { product, qty: row.qty, note: row.note || '' });
    }
  } catch { /* carro invalido: se ignora */ }
}

// -------------------------------------------------------------------- teclado

function onSearchKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    const raw = $('search').value.trim();
    if (/^\d+$/.test(raw) || !raw) { openChargeDialog(); return; }
    const [first] = visibleProducts();
    if (first) { addToCart(first); $('search').value = ''; renderProducts(); }
  }
  if (event.key === 'Escape') { $('search').value = ''; renderProducts(); }
}

function onGlobalKey(event) {
  if (document.querySelector('.modal-backdrop')) return;
  if (event.key === 'F2') { event.preventDefault(); openChargeDialog(); }
  if (event.key === 'Delete' && event.target === document.body) { event.preventDefault(); clearCart({ confirm: true }); }
  if (event.key === 'F3') { event.preventDefault(); $('search').focus(); $('search').select(); }
}

// --------------------------------------------------------------------- cobro

function openChargeDialog() {
  if (!cart.size) { toast('El pedido esta vacio'); return; }
  const total = cartTotal();
  let method = 'efectivo';
  let paying = true;

  const amountInput = el('input', { class: 'amount-big', inputmode: 'numeric', autocomplete: 'off', value: '' });
  const changeBox = el('div', { class: 'change-box' }, [
    el('span', { class: 'label', text: 'Vuelto' }),
    el('span', { class: 'value', id: 'change-value', text: money(0) }),
  ]);
  const cashArea = el('div', {}, [
    el('div', { class: 'cash-buttons' }, cashSuggestions(total).map((amount) => el('button', {
      class: 'btn ghost small',
      onclick: () => { amountInput.value = String(amount); updateChange(); amountInput.focus(); },
    }, [amount === total ? 'Justo' : money(amount)]))),
    el('div', { class: 'field' }, [el('label', { text: 'Paga con' }), amountInput]),
    changeBox,
  ]);

  const customerInput = el('input', { placeholder: 'Opcional (para llamar el pedido)', maxlength: 24 });
  // nota de todo el pedido; lo de cada producto va en su propia nota desde el carro
  const noteInput = el('input', { placeholder: 'Opcional (ej: para llevar)', maxlength: 80 });

  const methodButtons = state.config.paymentMethods.map((item) => el('button', {
    class: `choice ${item.key === method ? 'active' : ''}`,
    'data-method': item.key,
    onclick: (event) => {
      method = item.key;
      for (const node of event.target.parentElement.children) node.classList.toggle('active', node === event.target);
      cashArea.style.display = method === 'efectivo' ? '' : 'none';
      updateChange();
    },
  }, [item.label]));

  const confirmButton = el('button', { class: 'btn ok', onclick: () => confirm() }, ['Cobrar e imprimir']);

  function updateChange() {
    const paid = parseAmount(amountInput.value);
    const change = paid - total;
    changeBox.classList.toggle('negative', method === 'efectivo' && paid > 0 && change < 0);
    document.getElementById('change-value').textContent = method === 'efectivo' && paid ? money(Math.max(change, 0)) : money(0);
    if (method === 'efectivo' && paid > 0 && change < 0) {
      document.getElementById('change-value').textContent = `Faltan ${money(-change)}`;
    }
  }

  const { close } = openModal([
    el('h2', { text: `Cobrar ${money(total)}` }),
    el('p', { class: 'sub', text: `${cartCount()} articulos - ${describeStations()}` }),
    el('div', { class: 'choices' }, methodButtons),
    cashArea,
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Cliente' }), customerInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Nota del pedido' }), noteInput]),
    ]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn ghost', onclick: () => close() }, ['Cancelar (Esc)']),
      confirmButton,
    ]),
  ]);

  amountInput.addEventListener('input', updateChange);
  amountInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } });
  customerInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } });
  noteInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } });
  setTimeout(() => amountInput.focus(), 30);

  async function confirm() {
    if (!paying) return;
    const paid = method === 'efectivo' ? (parseAmount(amountInput.value) || total) : total;
    if (method === 'efectivo' && paid < total) {
      toast('El monto recibido es menor al total', { type: 'bad' });
      amountInput.focus();
      return;
    }
    paying = false;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Imprimiendo...';
    try {
      const payload = {
        items: [...cart.values()].map((entry) => ({ productId: entry.product.id, qty: entry.qty, note: entry.note || '' })),
        paymentMethod: method,
        amountPaid: paid,
        cashier: getCashier(),
        customer: customerInput.value,
        note: noteInput.value,
      };
      const result = await api('/api/orders', { method: 'POST', body: payload });
      close();
      clearCart();
      showResult(result.order, result.print);
      refreshPrinterStatus();
    } catch (err) {
      paying = true;
      confirmButton.disabled = false;
      confirmButton.textContent = 'Cobrar e imprimir';
      toast('No se pudo registrar el pedido', { detail: err.message, type: 'bad' });
    }
  }
}

function describeStations() {
  const names = new Set([...cart.values()].map((entry) => stationName(entry.product)));
  return names.size > 1 ? `${names.size} tickets de retiro: ${[...names].join(', ')}` : `Retiro en ${[...names][0]}`;
}

function cashSuggestions(total) {
  const notes = [1000, 2000, 5000, 10000, 20000];
  const options = new Set([total]);
  for (const note of notes) {
    if (note >= total) options.add(note);
  }
  const rounded = Math.ceil(total / 1000) * 1000;
  if (rounded > total) options.add(rounded);
  return [...options].sort((a, b) => a - b).slice(0, 5);
}

function showResult(order, print) {
  const failed = print && print.ok === false;
  const { close } = openModal([
    el('h2', { text: `Pedido N\u00b0 ${order.code} registrado` }),
    el('p', { class: 'sub', text: `${order.items.length} lineas - Total ${money(order.total)}` }),
    order.paymentMethod === 'efectivo' && order.change > 0
      ? el('div', { class: 'change-box' }, [
        el('span', { class: 'label', text: 'VUELTO' }),
        el('span', { class: 'value', text: money(order.change) }),
      ])
      : null,
    el('p', {
      class: failed ? 'sub' : 'sub',
      text: failed ? `La impresora fallo: ${print.error}` : `Impreso: ${(print?.printed || []).map((doc) => doc.title).join(' + ') || 'sin impresion'}`,
    }),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn ghost', onclick: () => reprint(order.id) }, ['Reimprimir']),
      el('button', { class: 'btn', onclick: () => { close(); location.href = `/pedidos.html#${order.id}`; } }, ['Ver pedido']),
      el('button', { class: 'btn ok', id: 'result-ok', onclick: () => close() }, ['Listo (Enter)']),
    ]),
  ]);
  setTimeout(() => document.getElementById('result-ok')?.focus(), 30);
  if (!failed) setTimeout(() => close(), 9000);
}

async function reprint(orderId) {
  try {
    const result = await api(`/api/orders/${orderId}/print`, { method: 'POST', body: { what: 'all' } });
    if (result.print.ok) toast('Reimpreso', { type: 'ok' });
    else toast('No se pudo imprimir', { detail: result.print.error, type: 'bad' });
  } catch (err) {
    toast('No se pudo imprimir', { detail: err.message, type: 'bad' });
  }
}
