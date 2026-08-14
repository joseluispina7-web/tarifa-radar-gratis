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

En Google Hotels solo se publica el total de la estancia cuando la tarjeta o
la fila del proveedor muestran un total final con impuestos en EUR para
exactamente esas fechas. Las ofertas obtenidas mediante Bluepillow solo se
publican cuando el enlace acredita que el total incluye impuestos, conserva
las fechas exactas y el endpoint `/validate` confirma de nuevo disponibilidad
y precio justo antes de generar la alerta.

El barrido funciona en dos fases. Agoda, Trip.com y Bluepillow descubren
fechas candidatas con rapidez; Booking usa además ventanas flexibles de hasta
15 entradas y Google Hotels se reserva para candidatos prometedores o pruebas
periódicas. Cada fuente conserva un estado de salud. Después de varios fallos
se pausa durante un intervalo corto sin detener el avance del resto del
barrido. Las fechas que quedan fuera del calendario fiable de Google se marcan
como limitadas, no como errores de precio.

- destino verificado con coordenadas;
- fechas exactas o flexibles;
- noches mínimas y máximas;
- presupuesto total y por noche;
- alojamientos con o sin estrellas;
- valoración, distancia, cancelación y régimen;
- tipo de alojamiento y servicios visibles en la ficha;
- adultos, niños, habitaciones y frecuencia.

Cada ciclo calcula una referencia de precio por noche con los alojamientos
observados para la misma estancia. Las ofertas verificadas reciben una
puntuación de posible tarifa error según su descuento respecto a esa
referencia, una bajada real y la coincidencia entre varios proveedores. El
panel agrupa el mismo hotel y muestra sus tarifas juntas, además del porcentaje
de cobertura y la salud de cada buscador.

Telegram envía todas las alertas, separadas por ubicación y ordenadas por
probabilidad de tarifa error. Cada mensaje identifica fechas, total, precio
por noche, calidad, proveedor real y método de verificación.

## Ubicaciones detalladas

Las sugerencias globales de ciudades, barrios, estaciones, lugares y calles
utilizan [Photon](https://github.com/komoot/photon), con datos de OpenStreetMap,
una pausa entre consultas y caché local. La ciudad ya seleccionada se usa para
priorizar resultados cercanos, incluso cuando la calle está escrita en otro
idioma. Open-Meteo permanece como respaldo para ciudades.

La lupa o Enter realizan una búsqueda más exhaustiva con Nominatim. Esas
consultas explícitas se limitan a una por segundo y se guardan durante 30 días
en el navegador. No se usa Nominatim como autocompletado automático, de acuerdo
con su [política de uso](https://operations.osmfoundation.org/policies/nominatim/).

Una ubicación detallada conserva sus coordenadas y la ciudad a la que
pertenece. El escáner aplica un radio implícito de 1 km para direcciones, 2 km
para calles y 3 km para barrios o zonas. Los comparadores que solo admiten
ciudades usan la ciudad matriz y después filtran los alojamientos por esas
coordenadas.

El panel solo presenta los buscadores con una integración operativa.
Tripadvisor requiere aprobación comercial para su Hotel Pricing API y Super.com
no publica una API abierta de tarifas hoteleras, por lo que no aparecen como
fuentes independientes. Una tarifa de Super.com sí puede llegar cuando Google
Hotels la muestre como proveedor. Google Hotels automático admite por ahora
una habitación para dos adultos sin niños; Booking y Bluepillow mantienen los
controles de viajeros. No se intenta evitar CAPTCHA ni otras protecciones del
sitio.

## Ejecución local

```powershell
npm install
npm test
node src/cli.cjs --config config/madrid-test.json --headed
node src/repository-scan.cjs
```

GitHub puede retrasar alguna ejecución programada. El cron de cinco minutos es
la frecuencia solicitada, no una garantía de hora exacta.

El escáner publica ofertas, estado y cursor en un único commit atómico por
ciclo. Si la configuración cambia durante la publicación, vuelve a leer la
rama y reintenta sin sobrescribir la búsqueda recién guardada.
