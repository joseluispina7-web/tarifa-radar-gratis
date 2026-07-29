# Tarifa Radar

Panel independiente y escáner gratuito de tarifas de hoteles.

## Arquitectura

- `docs/`: panel estático publicado con GitHub Pages.
- `config/searches.json`: búsquedas creadas desde el panel.
- `src/repository-scan.cjs`: escáner automático.
- `docs/data/`: estado y ofertas visibles en el panel.
- `.github/workflows/free-hotel-scan.yml`: ciclo programado.

El panel usa una clave de GitHub limitada a este repositorio para leer y
guardar la configuración. La clave permanece en el navegador del usuario. No
depende de una cuenta de ChatGPT ni de Google Cloud.

## Búsqueda automática

Booking y Google Hotels pueden activarse juntos o por separado dentro de cada
búsqueda guardada. El escáner usa Playwright sin API, cuenta de afiliado ni
credenciales de los buscadores. En Google Hotels solo publica el total de la
estancia cuando la tarjeta indica que incluye impuestos y tasas.

- destino verificado con coordenadas;
- fechas exactas o flexibles;
- noches mínimas y máximas;
- presupuesto total y por noche;
- alojamientos con o sin estrellas;
- valoración, distancia, cancelación y régimen;
- tipo de alojamiento y servicios visibles en la ficha;
- adultos, niños, habitaciones y frecuencia.

Los demás comparadores aparecen como enlaces manuales desde el panel. Google
Hotels automático admite por ahora una habitación para dos adultos sin niños;
Booking mantiene todos los controles de viajeros. No se intenta evitar CAPTCHA
ni otras protecciones del sitio.

## Ejecución local

```powershell
npm install
npm test
node src/cli.cjs --config config/madrid-test.json --headed
node src/repository-scan.cjs
```

GitHub puede retrasar alguna ejecución programada. El cron de cinco minutos es
la frecuencia solicitada, no una garantía de hora exacta.
