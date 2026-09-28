# Bitácora

Traza de lo que se ha hecho, con lo más reciente arriba. Cada evento lleva unos pocos bullets y su commit. No incluye cifras personales.

## Estado
- Terminado:
  - Fases 0–3: auditoría, registro de movimientos, motor de cálculo y app local.
  - Skills, subagentes y hooks.
  - Visualizaciones de análisis: Resumen modular, puente de ganancia, mapa mensual, riesgo, peso vs potencial.
- Fase 4 (precios y TRM automáticos): sin empezar.
- Fase 5 (Netlify y Supabase): pendiente de aprobación.
- Pendiente del usuario:
  - valores manuales de jul–sep 2026; el cierre de julio 2026 solo espera esto;
  - certificado de dividendos COP;
  - extractos de eToro;
  - verificar la compra de XRP de 2020.
- Mejora anotada: el aviso de TRM del Cierre nombra el primer mes pendiente, no el mes que se está cerrando.

## Registro

**2026-09-28 — Comparación con getquin** (sin commit de código)
- getquin.com bloqueado por la red del entorno; funciones tomadas de sus páginas vía buscador.
- Ya cubrimos su analítica Premium (TWR, XIRR, benchmark, máxima caída, mapas de calor).
- Propuestas priorizadas: dividendos (calendario y proyección), reporte para declaración de renta, costos (comisiones, retenciones, TER), rayos X de ETFs, Sharpe. Pendiente elección del usuario.

**2026-09-28 — Visualizaciones de análisis** (51c8de6)
- Resumen modular: cada bloque se muestra, oculta o reordena ("Personalizar el resumen"), guardado en el navegador.
- Bloques nuevos: ¿De dónde viene tu ganancia? (puente valor inicial → aportes → ganancia por clase → valor final, más las posiciones que más sumaron/restaron), mapa de calor de rentabilidad mensual por año, y riesgo (volatilidad, máxima caída, mejor/peor mes, curva de caídas).
- Comparación: volatilidad y caídas del portafolio frente al índice. Indicadores: dispersión peso vs potencial al objetivo.
- Revisión de `finance-reviewer`: meses con flujos grandes frente al capital (Modified Dietz poco fiable) se marcan ≈ y salen de las cifras de riesgo; inmueble a plazos = n. c.; estimados marcados.

**2026-09-28 — Regla de bitácora** (b880d64 y siguiente)
- `CLAUDE.md` exige registrar cada avance en esta bitácora.
- Formato: un evento con fecha, 2–4 bullets y su commit.

**2026-09-28 — Repo renombrado** (47be66b)
- El repo Prueba1 ahora se llama PortfolioManager en GitHub. Es el mismo repo, con la misma rama e historial.
- El remoto local apunta al nombre nuevo.
- Se borró la copia duplicada que se había clonado.

**2026-09-28 — Subagentes** (8820b6a, e0bf832, 0f0c790)
- Se agregaron `market-data`, `statement-reader`, `moat-researcher` y `app-verifier`. Trabajan en su propio contexto y devuelven un resumen corto.
- Los skills les delegan el trabajo pesado y vuelven a validar con `checks.ts` lo que entregan.
- Prueba con datos sintéticos:
  - trajeron la TRM real;
  - no inventaron el precio de un ticker ficticio;
  - dejaron como pregunta una línea ambigua de un extracto.
- Regla nueva: un valor de mitad de mes no se registra como VALUATION, porque taparía el valor de cierre.

**2026-09-28 — Cierre de julio 2026** (sin commit)
- `/month-close 2026-07`: precios, tasas e índices al 31 de julio completos.
- Faltan 4 valores manuales, que debe dar el usuario: 2 copy portfolios, el fondo y el inmueble.

**2026-09-27 — Automatización con Claude Code** (946cff2, 68b9cab)
- `scripts/checks.ts` valida estado del cierre, movimientos, precios, tasas y activos contra un respaldo.
- Skills: `month-close`, `import-statement` y `thesis-review`. Revisor: `finance-reviewer`.
- Hooks: pre-commit contra datos personales y secretos, bloqueo de `--no-verify` y pruebas al terminar el turno.
- El revisor encontró 12 hallazgos y se corrigieron todos (TRM vieja, transferencias sueltas, pares FX en 0…).

**2026-09-27 — Precios, Indicadores y foso** (310d407, e257f0a, 4d942d6)
- Vista Precios: entrada promedio, rango de 52 semanas, objetivo y ventas cerradas. Tema claro/oscuro.
- Vista Indicadores: pesos, composición y potencial a objetivos. El Resumen permite elegir las clases que suma.
- Foso económico según los proveedores (Morningstar, GuruFocus), con fecha y enlace.

**2026-09-27 — Seguimiento y Cierre del mes** (a774367)
- Grilla mes a mes por activo y clase, con subtotal sin inmobiliario y total.
- Cierre guiado en 5 pasos. Guarda la foto del cierre y avisa si las cifras cambian después.

**2026-09-26 — Auditoría y rediseño** (5dc4fe2, 4fa8bee)
- Auditoría de la app contra el Excel. Opinión favorable, con salvedades: dividendos estimados e inmueble a precio de lista.
- Se permite una valoración de 0 para un activo sin valor.
- Rediseño: gráfica de valor, barra de asignación y tarjetas por clase frente a su índice.

**2026-09-25 — App local, Fase 3** (579a458, 2fe9f2a)
- App Preact en un solo HTML que abre desde disco. Los datos quedan en IndexedDB.
- Pantallas: Resumen, Activos, Comparación, Movimientos, Cierre mensual y Datos.

**2026-09-24 — Motor de cálculo, Fase 2** (8c0543e)
- Costo promedio, FX, XIRR, TWR, PME y KS-PME, con pruebas verificadas a mano.
- Valida movimientos nuevos. Incluye una muestra sintética.
- Coincide con la referencia independiente en 9 portafolios.

**2026-09-24 — Auditoría y migración, Fases 0–1** (fuera del repo)
- Hallazgos en el Excel:
  - dividendos USD registrados como aportes;
  - compras en COP que pertenecen al portafolio USD;
  - una compra de XRP que no cuadra.
- Decisiones:
  - los dividendos COP que llegan al banco cuentan como salida;
  - el efectivo del bróker cuenta, la caja bancaria no;
  - el inmueble se valora a precio de lista y va marcado como estimado.
- Registro único de movimientos conciliado contra los cierres mensuales del Excel.
- `CLAUDE.md` inicial (42c3546).
