# Pocket Cashier

Caja rápida para bingos, kermeses, ferias y beneficios: se toma el pedido en pantalla,
se cobra y la impresora térmica de 58 mm saca **una boleta para el cliente** y **un ticket
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
4. Botón **Cobrar** (o `F2`): elegir medio de pago, escribir con cuánto paga y confirmar.
5. Se imprimen la boleta y los tickets de retiro, y la pantalla muestra el **vuelto** en grande.

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

**Pantalla Pedidos**

Lista del día con búsqueda por número, cliente o producto. Desde ahí se puede:

- **Reimprimir** todo, solo la boleta o el ticket de un stand (si se atascó el papel).
- **Anular** un pedido cobrado por error: deja de sumar en el cierre pero queda registrado.
- **Marcar entregado** cada stand, tocando su etiqueta (queda verde). Sirve para que el stand
  lleve el control de lo que ya despachó.
- **Ver** el ticket tal como sale impreso, con la opción de imprimirlo desde el navegador
  (respaldo si la impresora térmica falla).

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
        BOLETA DE VENTA
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

Y en seguida, un ticket por stand con el mismo número de pedido:

```
         COCINA
       TICKET DE RETIRO
================================
        PEDIDO 0042
         Ticket 1 de 2
             20:15
--------------------------------
2 x Completo
--------------------------------
Cliente: Juan
Caja: Caja 1
        ||| 0042 |||
```

El número de pedido es correlativo por día (`0001`, `0002`, ...) y va también como código de
barras o QR, por si más adelante se quiere marcar la entrega escaneando el ticket.

## 5. Configuración

`config.json` (se crea a partir de `config.example.json`). Lo habitual se edita desde **Ajustes**:

- `business`: nombre, subtítulo, línea extra y mensaje final del ticket.
- `printer`: modo de conexión, ancho (`32` para 58 mm, `42`/`48` para 80 mm), juego de
  caracteres, corte de papel, cajón de dinero y tipo de código.
- `tickets`: si se imprime la boleta, los tickets de retiro y cuántas copias de cada uno.
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
npm test        # 24 pruebas: tickets, ESC/POS, correlativos, cierre y API
node server.js  # levanta la caja
```

```
server.js          arranque del servidor
src/config.js      configuración
src/store.js       persistencia en JSON (catálogo y pedidos del día)
src/escpos.js      generador de comandos ESC/POS + vista previa en texto
src/printer.js     envío a la impresora (red, dispositivo, comando, archivo)
src/tickets.js     diseño de boleta, tickets de retiro y cierre
src/reports.js     resumen del día
src/api.js         endpoints JSON
web/               interfaz (caja, pedidos, cierre, ajustes)
```

## 8. Ideas para más adelante

- Marcar el retiro escaneando el código de barras del ticket con un lector.
- Pantalla para el stand, con la cola de pedidos pendientes.
- Propinas, descuentos o combos.
