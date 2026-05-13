# Correo Argentino Tracker

Extensión de Chrome para trackear tus pedidos de Correo Argentino desde una página completa tipo dashboard.

## Instalación

1. Abrí Chrome y andá a `chrome://extensions`
2. Activá **"Modo desarrollador"** (toggle arriba a la derecha)
3. Hacé click en **"Cargar sin empaquetar"**
4. Seleccioná esta carpeta (`correo-tracker`)
5. Clickeá el ícono 📦 en la barra de Chrome → se abre la página de tracking

## Requisitos

- Estar **logueado** en [correoargentino.com.ar](https://www.correoargentino.com.ar/mis-envios) para que la extensión cargue automáticamente tus envíos activos.
- Sin sesión activa, igual podés agregar números de tracking manualmente.

## Uso

| Acción | Cómo |
|--------|------|
| Ver pedidos automáticos | Iniciá sesión en Correo Argentino, la extensión los carga al abrir |
| Agregar tracking manual | Botón **"+ Agregar tracking"** → ingresá el número |
| Renombrar un pedido | Clickeá sobre el nombre del card y editalo |
| Actualizar estados | Botón **"↻ Actualizar todos"** |
| Eliminar un pedido | Botón **✕** en la esquina del card |

## Estados

| Badge | Descripción |
|-------|-------------|
| 🟢 LISTO PARA RETIRAR | Disponible en sucursal |
| 🟡 EN CAMINO | En distribución / reparto |
| 🔵 PREPARANDO | En preparación / admitido |
| ⚪ EN PROCESO | Estado genérico |
| 🔴 CANCELADO | Cancelado o devuelto |

## Ajuste de endpoints API

Si los pedidos automáticos no cargan, la API de Correo Argentino puede haber cambiado.
Para encontrar el endpoint correcto:

1. Andá a [correoargentino.com.ar/mis-envios](https://www.correoargentino.com.ar/mis-envios) logueado
2. Abrí DevTools → **Network** → filtrá por **XHR/Fetch**
3. Recargá la página y buscá el request que devuelve la lista de envíos
4. Copiá la URL y actualizá `ENDPOINTS.myShipments` en `app.js`

## Permisos usados

- `storage` — guardar nombres personalizados y trackings manuales
- `cookies` — acceder a la sesión de correoargentino.com.ar
- `tabs` — abrir la página al clickear el ícono
- `host_permissions` — hacer requests a la API de Correo Argentino
