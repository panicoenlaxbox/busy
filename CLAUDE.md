# Busy

PWA de control de jornada (empezar, pausar, reanudar, finalizar) en JavaScript plano, sin dependencias ni paso de build.

- `index.html`: estructura de las tres pestañas (Hoy, Resumen, Ajustes) y la hoja de motivos.
- `app.js`: toda la lógica. Los datos viven en `localStorage` con claves `busy.*` (eventos, horario, días libres, motivos, tema).
- `styles.css`: estilos con tema claro/oscuro.
- `sw.js`: service worker network-first con caché para uso sin conexión.

## Desplegar

Hacer push a `main` despliega en GitHub Pages (`panicoenlaxbox.com/busy/`). El repo es público y Pages publica todos los ficheros.

**Si el despliegue cambia algún fichero de la app (los de `ASSETS` en `sw.js`: `index.html`, `app.js`, `styles.css`, `manifest.json`, iconos), subir la versión en los dos sitios y con el mismo número:**

- `VERSION` en `app.js`, que es la que se muestra en Ajustes.
- `CACHE = 'busy-vN'` en `sw.js`.

Si solo cambian ficheros que no son de la app (como este `CLAUDE.md`), no hace falta subirla. Si `sw.js` no cambia, el navegador no detecta la versión nueva y no sale el aviso «Hay una versión nueva · Actualizar». Si solo cambia `sw.js`, la app se actualiza pero muestra el número antiguo.

## Comprobar cambios

No hay tests: los cambios se comprueban en el navegador.

- Servir con `python -m http.server <puerto>` y abrir `http://localhost:<puerto>/`.
- Preparar escenarios escribiendo eventos en `localStorage` (`busy.events`) y recargando.
- Al terminar, borrar los datos de prueba y desregistrar el service worker de ese origen.

## Convenciones

- Interfaz, comentarios y mensajes de commit en español.
- Horas en 24 h y fechas `dd/mm/yyyy`, independientes de la configuración del dispositivo.
- Los datos guardados deben seguir siendo compatibles: los campos nuevos de los eventos son opcionales (p. ej. `paid` en las pausas).
