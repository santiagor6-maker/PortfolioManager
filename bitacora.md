# Bitácora del proyecto

Registro de lo que vamos haciendo en el tracker de inversiones: decisiones, entregas y pendientes. La entrada más reciente va primero.

**Sin cifras personales.** Aquí no van saldos, valores, rentabilidades reales ni posiciones. Esas cifras viven en tus respaldos, fuera del repositorio. La bitácora cuenta qué se hizo y por qué, y enlaza los commits.

## Estado

| Fase | Qué es | Estado |
|---|---|---|
| 0 | Auditoría de los archivos de Excel | Hecha |
| 1 | Registro único de movimientos y migración | Hecha |
| 2 | Motor de cálculo con pruebas (XIRR, TWR, PME) | Hecha |
| 3 | App local en un solo HTML | Hecha y en uso |
| — | Skills, subagentes y hooks de Claude Code | Hecho |
| 4 | Precios y TRM automáticos (función de Netlify) | Sin empezar |
| 5 | Publicar en Netlify y sincronizar con Supabase | Requiere tu aprobación |

Pruebas: 122 unitarias y 16 e2e, todas en verde.

## Pendientes

**Tuyos**
- Valores manuales de fin de mes de jul–sep 2026: copy portfolios, fondo e inmueble. El cierre de julio de 2026 solo espera estos datos.
- Certificado de dividendos de las acciones en COP, para reemplazar los dividendos estimados.
- Extractos de eToro: valores mensuales de los copy portfolios y el efectivo sin explicar desde ene-2021.
- Verificar con el exchange la compra de XRP de 2020, cuyo precio implícito no cuadra.

**De desarrollo** (cuando los pidas)
- Fase 4: precios y TRM automáticos.
- Fundamentales en Indicadores, con fuente y fecha.
- Cierre del mes: cuando faltan varios meses, el aviso de TRM nombra el primer mes pendiente y no el que se está cerrando, y los chips de "sin cerrar" no muestran todos los meses.
- Fase 5: despliegue. Necesita tu aprobación y las cuentas de Netlify y Supabase.

## Cómo trabajamos

- Tus datos viven solo en el navegador (IndexedDB). Para cualquier tarea con datos reales, descargas un respaldo en **Datos**. Claude prepara archivos validados y tú los importas en esa misma pantalla.
- Skills: `/month-close`, `/import-statement` y `/thesis-review`.
- Subagentes:
  - `finance-reviewer` revisa los cambios de cálculo;
  - `market-data`, `statement-reader`, `moat-researcher` y `app-verifier` hacen el trabajo pesado y devuelven resúmenes cortos.
- El hook de pre-commit impide subir datos personales, claves o código con pruebas en rojo.

## Registro

### 2026-09-28 — Subagentes y cierre de julio
- `/month-close 2026-07`: los precios, las tasas y los índices al 31 de julio están completos. Solo faltan 4 valores manuales, que tienes que dar tú.
- Cuatro subagentes nuevos, cada uno con su propio contexto, para que la conversación principal no se llene de páginas, extractos y logs:
  - `market-data`: precios de cierre, TRM e índices, con fuente;
  - `statement-reader`: extractos convertidos en movimientos cuadrados;
  - `moat-researcher`: calificaciones de foso por proveedor;
  - `app-verifier`: pruebas, build y capturas.

  Los skills les delegan ese trabajo (8820b6a).
- Prueba con datos sintéticos:
  - `market-data` trajo la TRM real del 31 de agosto de 2026 desde datos.gov.co, y no inventó el precio de un ticker ficticio.
  - `app-verifier` dejó todo en verde.
  - `statement-reader` dejó como pregunta una línea ambigua del extracto y detectó que un valor de mitad de mes taparía el de cierre.

  Las instrucciones quedaron ajustadas (e0bf832, 0f0c790).
- El repositorio `Prueba1` pasó a llamarse `PortfolioManager` en GitHub. Es el mismo repositorio, con esta rama y su historial. El remoto local ya apunta al nombre nuevo.
- Se creó esta bitácora.

### 2026-09-27 — Seguimiento, Precios, Indicadores y automatización
- Vista **Seguimiento**: grilla mes a mes por activo y por clase, con subtotal sin inmobiliario y total. Y **Cierre del mes** guiado en 5 pasos, que guarda la foto del cierre y avisa si las cifras cambian después (a774367).
- Vista **Precios** (entrada promedio, rango de 52 semanas, objetivo y ventas cerradas) y selector claro/oscuro (310d407).
- Vista **Indicadores** (pesos, composición, potencial a objetivos) y Resumen modular por clases (e257f0a).
- Foso económico por proveedor, Morningstar y GuruFocus, con fecha y enlace, en lugar de una calificación propia (4d942d6).
- `scripts/checks.ts` valida los archivos preparados fuera de la app. Llegaron los skills, el revisor `finance-reviewer` y los hooks: pre-commit, anti `--no-verify` y verificación al terminar (946cff2).
- El revisor encontró 12 hallazgos y todos quedaron corregidos: TRM vieja reportada como "listo", transferencias sueltas, pares FX en 0 y activos nuevos sin validar, entre otros (68b9cab).

### 2026-09-26 — Auditoría y rediseño
- Auditoría de resultados de la app contra el Excel: opinión favorable, con salvedades por los dividendos estimados y el inmueble valorado a precio de lista.
- Se permite una valoración de fin de mes en 0 para un activo sin valor (5dc4fe2).
- Rediseño visual: gráfica de valor, barra de asignación y tarjetas por clase contra su índice (4fa8bee).

### 2026-09-25 — App local (Fase 3)
- App Preact en un solo HTML que abre desde disco, con los datos en IndexedDB. Pantallas: Resumen, Activos, Comparación, Movimientos con formulario validado, Cierre mensual y Datos (579a458).
- El formulario de activo nuevo usa tickers de ejemplo neutros (2fe9f2a).

### 2026-09-24 — Auditoría, migración y motor (Fases 0–2)
- Fase 0: auditoría de los dos Excel.
  - Hallazgos: dividendos en USD registrados como aportes, venta reinvertida, compras en COP que pertenecen al portafolio USD, y una compra de XRP que no cuadra.
- Decisiones:
  - Los dividendos en COP que llegan al banco cuentan como salida del portafolio.
  - El efectivo del bróker sí entra en el valor de la cuenta; la caja bancaria no.
  - El inmueble se valora cada mes a precio de lista, marcado como estimado.
  - Protección se trata como fondo de inversión.
- Fase 1: registro único de movimientos migrado desde los dos Excel, con dividendos estimados marcados como tales y conciliado contra los cierres mensuales del Excel.
- Fase 2: motor de cálculo en TypeScript (costo promedio, FX, XIRR, TWR, PME y KS-PME), con validación de movimientos nuevos y muestra sintética. Coincide con la referencia independiente en 9 portafolios (8c0543e).
- `CLAUDE.md` con las reglas de trabajo y de dominio (42c3546).
