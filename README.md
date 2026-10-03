# Pocket Cashier

Caja rápida para bingos, kermeses, ferias y beneficios: se toma el pedido en pantalla,
se cobra y la impresora térmica de 58 mm saca **un ticket de venta para el cliente** y **un ticket
de retiro por cada stand** donde tenga que ir a buscar la comida.

Al final del día entrega el **cierre de caja** con todo lo vendido.

- Todo funciona en una red local: el PC con la impresora levanta el servidor y los demás
  equipos (otro PC, un notebook, un celular) entran por el navegador y cobran.
- **Sin dependencias**: solo Node.js. Nada de `npm install`, ni base de datos, ni internet.
- Los datos quedan en archivos JSON dentro de `data/`, fáciles de respaldar (o copiar a un pendrive).

---

## 1. Poner en marcha

1. Instalar [Node.js](https://nodejs.org) (versión 18 o superior) en el PC donde está la impresora.
2. Copiar esta carpeta a ese PC.
3. Iniciar:
   - **Windows**: doble clic en `start.bat`
   - **Linux / Mac**: `./start.sh`
   - o desde la terminal: `node server.js`

La consola muestra las direcciones para abrir la caja:

```
  En este PC:      http://localhost:8080
  En la red:       http://192.168.1.20:8080
```

4. En el otro PC (o en un celular conectado al mismo WiFi) abrir esa dirección de red.

> Si el otro equipo no puede entrar, casi siempre es el **firewall de Windows**: la primera vez
> que se ejecuta pregunta si se permite Node.js en redes privadas; hay que decir que **sí**.

Para cambiar el puerto: `node server.js --port 9000`.

### Entrar desde internet (sin compartir la red)

Si no hay una red para todos, la caja se puede publicar en internet con un túnel de Cloudflare
(gratis, sin cuenta). Así **solo el PC de la impresora necesita internet** (por ejemplo, compartido
desde un celular) y el resto entra con sus datos móviles.

1. Instalar cloudflared una vez: `winget install --id Cloudflare.cloudflared`
2. Iniciar con **`start-tunnel.bat`** (o `node server.js --tunnel`). La consola muestra la
   dirección (`https://algo-al-azar.trycloudflare.com`) y los códigos.
3. En **Ajustes → Acceso remoto**, imprimir **Acceso cajas** y **Acceso stands**: cada ticket trae
   un QR que entra directo con su código, y el código escrito por si no hay cámara.

Con códigos hay tres roles:

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| Stand | código de stands | ver la cola de su stand y marcar entregas |
| Caja | código de cajas | además cobrar, ver pedidos, reimprimir y cierre |
| Administrador | el PC de la impresora, o caja + PIN | además Ajustes y anular pedidos |

- Si se inicia el túnel sin códigos, se crean solos: la caja nunca queda abierta a cualquiera.
- Sin PIN de administrador, Ajustes solo se abre en el PC de la impresora.
- Tras 10 códigos equivocados, esa conexión espera 10 minutos.
- Cambiar un código en Ajustes desconecta a quienes entraron con el anterior.
- **La dirección cambia cada vez que se inicia el túnel**: hay que reimprimir los accesos. Si el
  internet del PC se corta un buen rato, Cloudflare da de baja la dirección: la caja lo detecta
  (prueba su dirección cada minuto) y a los ~3 minutos abre un túnel nuevo. La dirección nueva
  aparece en la consola y en Ajustes → Acceso remoto; hay que reimprimir los accesos.
- Todo sigue pasando por el PC: si se apaga o pierde internet, los celulares no pueden cobrar.
- El túnel usa HTTP/2 (TCP): en redes de celular QUIC suele no conectar. Si algo falla, el
  registro de cloudflared queda en `data/cloudflared.log`.

## 2. Configurar la impresora

Todo se configura desde la pestaña **Ajustes** (o editando `config.json`). Hay cuatro formas de conectarla:

| Cómo está conectada | Qué poner |
|---|---|
| **Por red / WiFi** (la impresora tiene su propia IP) | IP `192.168.1.87` y puerto `9100` |
| **Puerto directo** | Linux: `/dev/usb/lp0` · Windows: `COM3` (impresoras USB que se ven como puerto serie) |
| **Por el sistema** (impresora ya instalada en el PC) | Linux/Mac: `lp -d NOMBRE -o raw {file}` · Windows: `cmd /c copy /b {file} \\localhost\NOMBRE` (compartiendo la impresora con ese nombre) |
| **Archivo** | Guarda los bytes en `data/spool.bin`, útil para probar sin impresora |

Después de guardar, usar **Imprimir prueba**: sale un ticket con acentos, el ancho del papel y
un código de barras. Si los acentos salen raros, cambiar el *juego de caracteres* (CP850 suele
funcionar; algunas impresoras chinas usan CP437) y volver a probar.

Si los acentos salen como **letras chinas** y cambiar el juego de caracteres no hace ninguna
diferencia, la impresora está en modo chino (GB18030) e ignora el cambio de codepage: marcar
**Desactivar modo chino** en Ajustes.

En Linux, si aparece "sin permisos" para `/dev/usb/lp0`:

```sh
sudo usermod -aG lp $USER   # y volver a iniciar sesión
```

El indicador verde/rojo de la barra superior muestra si la impresora está respondiendo.

## 3. Usar la caja

**Pantalla Caja**

1. Tocar los productos para armar el pedido (tocar de nuevo suma otra unidad).
2. Una vez agregado, la tarjeta muestra **`−  2  +`** para subir o bajar la cantidad ahí mismo,
   sin bajar al carro y sin abrir el teclado del celular.
3. Atajo de teclado: escribir la cantidad (`3`) y tocar el producto la carga de una vez.
4. En el carro, **Nota** en cada producto agrega una indicación (`sin mayo`, `1 sin tomate`) que
   sale bajo ese producto en el ticket de venta, en el del stand y en la pantalla Stand. La
   *Nota del pedido* de la ventana de cobro es para todo el pedido (`para llevar`).
5. Botón **Cobrar** (o `F2`): elegir medio de pago, escribir con cuánto paga y confirmar.
6. Se imprimen el ticket de venta y los de retiro, y la pantalla muestra el **vuelto** en grande.

En celular y tablet hay una **barra fija abajo** con el total y el botón Cobrar siempre a la
vista; tocando el total se salta al detalle del pedido. Los botones `−` / `+` miden 44 px
(el mínimo recomendado para dedos).

| Atajo | Acción |
|---|---|
| `F2` | Cobrar |
| `F3` | Ir al buscador |
| `Enter` en el buscador | Agrega el primer producto que coincide |
| `Supr` | Vaciar el pedido |
| `Esc` | Cerrar la ventana abierta |

El nombre de la caja (`Caja 1`, `Caja 2`...) se escribe arriba y queda guardado en ese equipo;
así el cierre muestra cuánto vendió cada una.

**Stands: color y qué tickets imprimen**

En **Ajustes → Stands de retiro** cada stand tiene:

- **Color**: pinta suave el fondo de sus productos en caja (y su línea en el carro), para ver de
  un vistazo de qué stand es cada cosa. Los stands nuevos traen uno; una promo toma el color
  solo si todo lo que incluye sale del mismo stand.
- **Ticket venta** y **Ticket retiro**: desmarcados, lo de ese stand se cobra y suma en el cierre, pero no
  imprime. Pensado para lo que solo se registra para la cuadratura, como las entradas que
  controla portería. Un pedido solo de entradas no imprime nada; si se mezcla con comida, la
  ticket de venta sale completo (para que el total cuadre con lo pagado) y solo hay ticket para la
  cocina. Desde **Pedidos** se puede reimprimir igual a mano.

**Stock**

Cada producto puede llevar stock (en **Ajustes → Productos**). Vacío = se vende sin límite.

- La tarjeta muestra **Quedan N** (en rojo desde 5), descontando lo que ya está en el carro.
  Sin stock queda gris con **Agotado** y no se puede agregar.
- El stock lo valida el servidor al cobrar: si dos cajas venden la última unidad a la vez,
  la segunda recibe "Solo quedan N" y no se cobra nada. Las cajas se actualizan cada 15 s.
- **Reponer** suma unidades a lo que quede (o descuenta mermas con un número negativo), sin
  pisar lo que se vende mientras tanto. Escribir en la casilla fija la cantidad exacta.
- **Anular** un pedido devuelve al stock lo que ese pedido descontó.

**Promos y packs**

Se crean en **Ajustes → Promos y packs**: nombre, precio y los productos que incluye
(`3 Sopaipilla`, o `1 Completo + 1 Bebida lata`).

- En la caja son **un producto más** con su propio precio: no se aplican solas. Se puede
  vender 3 sopaipillas sueltas de $400 y además una promo 3x$1.000: $2.200.
- Descuentan el stock de lo que incluyen, y muestran cuántas quedan según ese stock.
- En el ticket de venta sale la promo con su detalle; cada producto sale en el **ticket de su stand**
  (el completo en COCINA y la bebida en BAR), con el nombre de la promo para cuadrar.
- En el cierre, la promo cuenta como un producto; en *ventas por stand* su precio se reparte
  según el precio normal de lo que incluye.
- No se puede borrar un producto que está en una promo (primero hay que quitarlo de ella).

**Pantalla Pedidos**

Lista del día con búsqueda por número, cliente o producto. Desde ahí se puede:

- **Reimprimir** todo, solo el ticket de venta o el de un stand (si se atascó el papel).
- **Anular** un pedido cobrado por error: deja de sumar en el cierre pero queda registrado.
- **Marcar entregado** cada stand, tocando su etiqueta (queda verde). Sirve para que el stand
  lleve el control de lo que ya despachó.
- **Ver** el ticket tal como sale impreso, con la opción de imprimirlo desde el navegador
  (respaldo si la impresora térmica falla).

**Pantalla Stand**

Para el celular o tablet de cada stand, conectado a la misma red (o al hotspot) que la caja.
Cada stand ve **solo sus pedidos** y marca lo que entrega.

1. Abrir `http://<ip-de-la-caja>:8080/stand.html` y tocar el stand (COCINA, BAR...). Queda
   guardado en ese equipo; se cambia con **Cambiar stand** arriba. También está en la
   pestaña **Stand** de la caja.
2. Para dejar un enlace fijo por stand: `http://<ip>:8080/stand.html?station=<id>` (el `id`
   del stand, o `none` para los productos sin stand, que salen como *Retiro*).
3. Cada pedido pendiente es una tarjeta con el **número tal como sale en el ticket** (`0024`),
   solo los productos de ese stand (`2x Completo`, con su nota debajo) y cuánto lleva esperando.
   Los que pasan de 10 minutos se marcan en naranjo; los nuevos se destacan y el celular vibra.
4. Botón **Entregado**: la tarjeta desaparece al tiro y abajo aparece **Deshacer** por 5
   segundos, por si fue un error.
5. **Últimos entregados** (abajo, plegado): tocar uno lo devuelve a pendientes.

Se actualiza sola cada 3 segundos y el punto de arriba indica si hay conexión con la caja.
Las entregas son las mismas que se marcan en **Pedidos**: se ven en ambas pantallas.

**Pantalla Cierre**

Totales del día, ranking de productos, ventas por stand, por caja, por hora y por medio de pago.
Se puede imprimir en la térmica, imprimir la página completa o descargar un CSV para Excel.

> Si el evento sigue después de medianoche, las ventas se siguen contando en el mismo día:
> el día comercial cambia a las 05:00 (configurable en Ajustes).

## 4. Qué sale impreso

```
      BINGO SOLIDARIO             ← nombre del negocio
       Stand de comidas
================================
        PEDIDO 0042               ← correlativo del día, grande
        TICKET DE VENTA
--------------------------------
Fecha           07-09-2026 20:15
Caja                      Caja 1
Cliente                     Juan
--------------------------------
Completo
  2 x $2.500              $5.000
Bebida lata
  1 x $1.200              $1.200
--------------------------------
TOTAL                     $6.200
Efectivo                 $10.000
Vuelto                    $3.800
Articulos                      3
--------------------------------
RETIRA EN 2 STANDS:
 1. COCINA
 2. BAR
      Gracias por su compra!
        ||| 0042 |||             ← código de barras (o QR)
```

Y en seguida, un ticket por stand con el mismo número de pedido, precedido por la inicial del
stand (si dos stands empiezan con la misma letra, el nombre arriba del ticket los distingue).
Es compacto porque sale uno por stand en cada pedido: no lleva el pie del negocio, y el
"1 de 2" solo aparece cuando el pedido se retira en más de un stand:

```
         C-0042
--------------------------------
Retira en: COCINA
--------------------------------
2 x Completo
--------------------------------
Cliente: Juan
Caja: Caja 1 - 20:15 - 1 de 2
        ||| 0042 |||             ← solo si hay código de barras o QR
```

El número de pedido es correlativo por día (`0001`, `0002`, ...) y va también como código de
barras o QR, por si más adelante se quiere marcar la entrega escaneando el ticket.

## 5. Configuración

`config.json` (se crea a partir de `config.example.json`). Lo habitual se edita desde **Ajustes**:

- `business`: nombre, subtítulo, línea extra y mensaje final del ticket.
- `printer`: modo de conexión, ancho (`32` para 58 mm, `42`/`48` para 80 mm), juego de
  caracteres, corte de papel, cajón de dinero y tipo de código.
- `tickets`: si se imprime el ticket de venta, los de retiro y cuántas copias de cada uno.
- `adminPin`: PIN opcional para entrar a Ajustes y anular pedidos.
- `businessDayStartHour`: hora en que empieza el día comercial.
- `currency`: símbolo y separadores (por defecto pesos chilenos, sin decimales).

Variables de entorno útiles:

- `POCKET_CASHIER_DATA=/ruta/datos` — guardar los datos en otra carpeta (por ejemplo un pendrive).
- `POCKET_CASHIER_CONFIG=/ruta/config.json` — usar otro archivo de configuración.

## 6. Respaldo y datos

```
data/
  catalog.json          productos y stands
  days/2026-09-07.json  todos los pedidos de ese día
```

Copiar la carpeta `data/` es respaldo suficiente. Son archivos de texto: se pueden abrir y leer.

## 7. Desarrollo

```sh
npm test        # 48 pruebas: tickets, ESC/POS, correlativos, cierre, stock, promos, cola del stand, acceso y API
node server.js  # levanta la caja
```

```
server.js          arranque del servidor
src/config.js      configuración
src/store.js       persistencia en JSON (catálogo y pedidos del día)
src/escpos.js      generador de comandos ESC/POS + vista previa en texto
src/printer.js     envío a la impresora (red, dispositivo, comando, archivo)
src/tickets.js     diseño de tickets de venta y de retiro, y del cierre
src/reports.js     resumen del día
src/queue.js       cola de retiro de un stand (GET /api/stations/:id/queue)
src/lines.js       lo que entrega cada stand (abre las promos) y lo que descuenta del stock
src/access.js      roles y codigos de acceso, bloqueo por intentos fallidos
src/tunnel.js      tunel de Cloudflare para entrar desde internet
src/api.js         endpoints JSON
web/               interfaz (caja, pedidos, stand, cierre, ajustes)
```

## 8. Ideas para más adelante

- Marcar el retiro escaneando el código de barras del ticket con un lector.
- Propinas, descuentos o combos.
