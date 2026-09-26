// Ingreso con codigo: el de cajas lleva a la caja y el de stands a la pantalla del stand.
// El QR impreso trae el codigo en la direccion (#code=...), asi que basta escanearlo.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

init();

async function init() {
  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    tryCode($('code').value);
  });

  const fromQr = new URLSearchParams(location.hash.slice(1)).get('code');
  // el codigo no debe quedar en la barra ni en el historial del navegador
  if (fromQr) history.replaceState(null, '', location.pathname + location.search);
  const saved = localStorage.getItem('accessCode');
  if (fromQr) {
    $('code').value = fromQr;
    await tryCode(fromQr);
  } else if (saved) {
    await tryCode(saved, { silent: true });
  } else {
    await checkRequired();
  }
  $('code').focus();
}

async function ask(code) {
  const response = await fetch('/api/access', { headers: code ? { 'X-Access-Code': code } : {} });
  const data = await response.json().catch(() => ({}));
  if (response.status === 429) throw new Error(data.error || 'Demasiados intentos. Espera unos minutos.');
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  if (data.business) {
    $('business').textContent = data.business;
    document.title = `Entrar - ${data.business}`;
  }
  return data;
}

/** Sin codigos configurados (red local de siempre) o en el PC de la caja no hay nada que pedir. */
async function checkRequired() {
  try {
    const data = await ask('');
    if (!data.required || data.role) go(data.role || 'cashier');
  } catch (err) {
    showError(err.message);
  }
}

async function tryCode(value, { silent = false } = {}) {
  const code = String(value || '').trim();
  if (!code) return;
  $('submit').disabled = true;
  try {
    const data = await ask(code);
    if (!data.required) { go('cashier'); return; }
    if (!data.role) {
      localStorage.removeItem('accessCode');
      if (!silent) showError('Codigo incorrecto. Revisa el ticket o pideselo a quien administra la caja.');
      return;
    }
    localStorage.setItem('accessCode', code);
    go(data.role);
  } catch (err) {
    showError(err.message === 'Failed to fetch' ? 'Sin conexion con la caja' : err.message);
  } finally {
    $('submit').disabled = false;
  }
}

function go(role) {
  if (role === 'stand') { location.replace('/stand.html'); return; }
  // solo rutas internas: un enlace armado no puede mandar a otro sitio
  const next = params.get('next') || '/';
  location.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}
