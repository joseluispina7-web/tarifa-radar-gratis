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

Booking, Google Hotels, Agoda, Trip.com y Bluepillow pueden activarse juntos o
por separado dentro de cada búsqueda guardada. Booking y Google Hotels se
consultan con Playwright. Agoda y Trip.com se consultan mediante la API
anónima gratuita de Bluepillow, que devuelve precios vivos por agencia y
fechas; Bluepillow también puede elegirse como comparador general. La clave
anónima identifica un cupo gratuito y no está asociada a facturación.

En Google Hotels solo se publica el total de la estancia cuando la tarjeta lo
indica o cuando un proveedor de Google expone un total final con impuestos en
EUR para exactamente esas fechas. Las ofertas obtenidas mediante Bluepillow
solo se aceptan cuando el importe total y el precio por noche son coherentes,
la moneda es EUR, hay disponibilidad y el enlace conserva las fechas exactas.

- destino verificado con coordenadas;
- fechas exactas o flexibles;
- noches mínimas y máximas;
- presupuesto total y por noche;
- alojamientos con o sin estrellas;
- valoración, distancia, cancelación y régimen;
- tipo de alojamiento y servicios visibles en la ficha;
- adultos, niños, habitaciones y frecuencia.

Los demás comparadores aparecen como enlaces manuales desde el panel.
Skyscanner requiere una API aprobada o muestra CAPTCHA a la automatización,
por lo que no se presenta como vigilancia automática. Google Hotels automático
admite por ahora una habitación para dos adultos sin niños; Booking y
Bluepillow mantienen los controles de viajeros. No se intenta evitar CAPTCHA
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
