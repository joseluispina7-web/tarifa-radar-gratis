# Tarifa Radar - scraper gratuito

Primera fuente: Booking, consultada con un navegador Playwright sin API,
cuenta de afiliado ni credenciales.

## Ejecutar una prueba

```powershell
node src/cli.cjs --config config/madrid-test.json --headed
```

La salida incluye todos los alojamientos visibles, los que cumplen el
presupuesto y el precio más barato observado.

## Alcance inicial

- Destino y fechas exactas.
- Adultos, niños y habitaciones.
- Presupuesto total o por noche.
- Estrellas, valoración y cancelación gratuita.
- Exclusión de camas y dormitorios compartidos (activada por defecto).
- Precio total, precio por noche, puntuación y enlace de reserva.

No se intenta evitar CAPTCHA ni otras protecciones del sitio. Si Booking
bloquea la consulta, la ejecución falla de forma visible y no genera una
oferta falsa.

## Ejecución gratuita

Esta carpeta es un repositorio independiente: no hace falta publicar el panel
ni ningún proyecto de Google Cloud. El flujo
`.github/workflows/free-hotel-scan.yml` está preparado para un repositorio
público de GitHub. Se ejecuta aproximadamente cada cinco minutos en el
contenedor oficial de Playwright y usa un navegador con pantalla virtual.
GitHub puede retrasar alguna ejecución programada; no es un servicio con horario
garantizado.

La búsqueda real debe guardarse como el secreto `SEARCH_CONFIG_JSON`. El
repositorio solo contiene una configuración de prueba, no credenciales.
