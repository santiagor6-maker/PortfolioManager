# Bitácora

Traza de lo que se ha hecho, con lo más reciente arriba. Cada evento lleva unos pocos bullets y su commit. No incluye cifras personales.

## Estado
- Terminado:
  - Fases 0–3: auditoría, registro de movimientos, motor de cálculo y app local.
  - Skills, subagentes y hooks.
  - Visualizaciones de análisis: Resumen modular, puente de ganancia, mapa mensual, riesgo, peso vs potencial.
  - Pestaña Dividendos (inspirada en getquin).
  - Pestaña Mi plan (antes Orientación): plan de acción contra el perfil del usuario y contra los índices. Pestañas renombradas y ordenadas por uso (10).
- Plan acordado:
  1. Netlify.
  2. Supabase con datos cifrados en el navegador.
  3. Precios del cierre automáticos (Yahoo + TRM): hecho.
  4. Fundamentales mensuales desde SEC EDGAR al abrir la app: hecho; falta que el usuario ponga `SEC_USER_AGENT` en Netlify.
- Netlify `portfoliomanager-sr` publica esta rama en cada push.
- Sincronización con correo + contraseña funcionando (proyecto Supabase propio del usuario, creado por él).
- «Traer precios del cierre» (etapa 3) con Yahoo vía la función `/api/quotes` de Netlify y la TRM oficial: probado por el usuario en el sitio, Yahoo responde desde Netlify.
- Decisión pendiente: el historial tiene las tasas EUR/CAD de horario de verano británico fechadas un día antes (mismo valor, fecha −1); se corrige en los datos si el usuario quiere.
- Pendiente del usuario:
  - valores manuales de jul–sep 2026; el cierre de julio 2026 solo espera esto;
  - certificado de dividendos COP;
  - extractos de eToro;
  - verificar la compra de XRP de 2020.
- Estilo visual alineado con getquin; su tablero personal (requiere cuenta) no se pudo ver.
- Mejora anotada: el aviso de TRM del Cierre nombra el primer mes pendiente, no el mes que se está cerrando.

## Registro

**2026-10-08 — Pestañas renombradas y fusionadas (11 → 10)**
- El usuario aprobó la propuesta: Resumen · Inversiones (Activos + Precios, con subvistas Posiciones y Precios y objetivos) · Mes a mes (Seguimiento) · Dividendos · Contra el mercado (Comparación) · Tesis (Indicadores) · Mi plan (Orientación) · Cierre del mes · Movimientos · Datos. Orden por frecuencia de uso.
- Los enlaces viejos (`#/activos`, `#/precios`, `#/seguimiento`…) redirigen a la pestaña nueva; textos, skills y CLAUDE.md actualizados.

**2026-10-08 — Composición en Seguimiento, compras por cantidad × precio** (9f84c59)
- Seguimiento abre con «Composición del portafolio»: columnas 100 % por clase mes a mes (clic = ese mes), clases del mes y posiciones de la clase elegida (% de la clase y del total), con o sin inmobiliario. Paleta validada con el validador de dataviz (claro y oscuro).
- Movimientos: compra y venta se registran con cantidad, precio por unidad y comisión; la app calcula el total al centavo y muestra el cierre guardado del día como referencia. Se puede escribir el total del extracto (muestra el precio implícito). En COP, «2.345» es dos mil trescientos cuarenta y cinco.
- `finance-reviewer` (3 rondas): venta con comisión mayor que el bruto rechazada, miles en pesos, edición que nunca cambia el monto (campos con coma decimal), posiciones negativas aparte.
- Nombres de pestañas: dos subagentes (inventario de pestañas y cómo nombran otras apps) → propuesta al usuario, pendiente de su decisión.

**2026-10-05 — Orientación: plan de acción del portafolio** (87115a0)
- El usuario pidió un módulo de recomendación «como un experto de Wall Street», autoevaluado hasta 4,9/5. `advice.ts` + pestaña Orientación: perfil del inversionista (plantillas editables, fondo de emergencia, fuente y fecha del saldo del inmueble), cada activo contra el índice de su clase con el mismo dinero (las brechas suman la de la clase), reserva en pesos para el saldo antes de invertir, mezcla con bandas 5/25 y plan de aportes sin vender, concentración, efectivo, riesgo (peor caída propia y escenario de crisis con supuestos declarados) y notas tributarias de Colombia. Decide en pesos; no pronostica ni recomienda acciones nuevas.
- Rúbrica de 8 criterios (corrección, evidencia, idoneidad, accionabilidad, prioridad, riesgo, comunicación, cumplimiento) con un estratega independiente: 3,2 → 4,1 → 4,5 → 4,7 → 4,8 → 4,85 → 4,9. Se rehizo alrededor del pasivo del inmueble, el riesgo en pesos y la idoneidad; luego hipoteca y arriendo, presupuesto, orden por urgencia y «Qué vender primero» clase por clase con el costo fiscal en pesos.
- `finance-reviewer`: seis rondas, todos los hallazgos corregidos, aprobado. 262 unitarias y 39 e2e.

**2026-10-01 — Efecto cambiario separado en el cierre**
- El usuario vio el cierre de septiembre distinto en el celular: era la moneda del reporte (USD allá, COP en el PC; se guarda por dispositivo). La devaluación del peso en septiembre hacía ver el inmueble como pérdida en dólares.
- `tracking.ts` separa cada ganancia mensual en «de la inversión» y «efecto cambiario» (cambio de la tasa de la moneda en que se valora cada tenencia, sobre el valor inicial y cada flujo desde su fecha); suman exacto la ganancia. Columnas nuevas en Cierre del mes y métrica en Seguimiento; una tasa faltante solo deja el efecto en «—».
- Validado: casos a mano (fondo COP en USD, venta a mitad de mes, valor manual en otra moneda, compra y venta en el mes) y la identidad exacta con el respaldo real. `finance-reviewer`: dos pasadas, aprobado.

**2026-09-30 — Fundamentales de la SEC en Indicadores**
- Etapa 4: la función `/api/fundamentals` trae de EDGAR companyfacts solo los conceptos necesarios (contacto en `SEC_USER_AGENT`); `src/data/sec.ts` arma 12 meses (anual + año corrido − año anterior) y exige que cada cifra llegue al último periodo, o queda faltante con el motivo. Se guardan en `Asset.sec`, aparte de lo copiado a mano; Indicadores las muestra encima, con la fuente en cada celda. Se leen solas una vez al mes.
- Validado con datos reales de las 20 acciones de EE. UU. y extranjeras del usuario; el 10-K de Microsoft cuadra línea por línea. Las extranjeras (20-F) no muestran cifras por acción ni con precio (ADR ≠ acción local).
- `finance-reviewer`: tres pasadas. Corregidos el P/E de un 20-F en USD, el EPS tras un split (y cuando no se puede verificar), la taxonomía tras pasar a IFRS, conceptos con arrendamientos o caja restringida, la fecha de corte pasada y la fuente por cifra. 211 unit + 37 e2e.

**2026-09-30 — Entrar con correo y contraseña**
- Los enlaces por correo fallaban: los registros de Supabase muestran que un revisor de correo usaba cada enlace segundos antes del clic del usuario. Se reemplazan por correo + contraseña, con una sola contraseña: Supabase recibe un secreto derivado (PBKDF2 con sal por correo) y los datos se cifran con otra clave derivada, así que la nube sigue sin poder leerlos.
- Un dispositivo vacío ya no crea la primera copia en la nube (así se creó la copia vacía del celular). Un dispositivo que solo perdió la clave retoma sin conflicto.
- `finance-reviewer`: dos pasadas. Corregidos: rechazar copias con sal o iteraciones ajenas (evita que la clave de datos sea igual al secreto de login), el bloqueo tras un fallo de red al entrar, la escritura atómica de la marca de cambios, un vector fijo del secreto y la detección de red caída. 196 unit + 35 e2e.

**2026-09-30 — Primer uso de «Traer precios del cierre»**
- Funcionó en el sitio publicado, sin series fallidas. El usuario preguntó si solo trae cierres de mes: trae cada día hábil que falte, porque el historial es diario (PME en la fecha de cada flujo, rango de 52 semanas, drawdowns); basta oprimirlo una vez después de fin de mes.
- La tarjeta ahora lo dice, separa la fecha de los precios de la de la TRM (que rige desde el día siguiente a publicarse) y nombra las series pendientes (hasta 3) y cuándo la fuente aún no tiene un cierre nuevo.

**2026-09-29 — Precios del cierre desde Yahoo**
- El usuario solo necesita cierres de mes y preguntó cómo se validaron antes Colombia, Londres y París: el historial viene de Yahoo. Se reemplazan Twelve Data y CoinGecko por Yahoo vía la función `netlify/functions/quotes.mts`, sin clave; la TRM sigue oficial.
- Verificado en vivo con los símbolos reales: 361/361 cierres de acciones, cripto e índices idénticos a lo guardado. Las tasas EUR/CAD coinciden en valor, pero el historial las tiene un día antes en verano; las nuevas quedan con la fecha correcta.
- `finance-reviewer`: dos pasadas. Corregidos la sesión abierta, los splits, los símbolos compartidos, el dividendo tardío en índices encadenados, la validación y la función solo para la app. 192 unit + 33 e2e.

**2026-09-29 — Actualizar precios**
- Botón en Datos y en el paso 2 del Cierre: acciones y ETF de EE. UU. y tasas EUR/CAD (Twelve Data, clave guardada solo en el navegador), TRM oficial (datos.gov.co, mismo formato que la serie guardada: verificado) y XRP/BTC (CoinGecko).
- Solo agrega días posteriores al último guardado, nunca reemplaza, pasa por las mismas revisiones que un archivo importado y corta una serie en la primera fila rechazada. Respeta el límite de 8 consultas por minuto.
- Sin fuente gratuita (quedan con el skill de cierre): Colombia, Londres, París, Alemania, Toronto y los índices de retorno total.
- `finance-reviewer`: aprobado; corregidos sus 5 menores (límite diario, motivos, conteo por serie, una sola corrida, pruebas de bordes). 189 unit + 31 e2e.

**2026-09-29 — Entrar con el enlace del correo**
- En el plan gratuito Supabase no deja editar las plantillas sin SMTP propio, así que el correo solo trae un enlace, sin código de 6 dígitos.
- `sync.ts` ahora acepta el enlace: vuelve a la página con la sesión en el hash, auth-js la lee y la borra, y la pestaña que lo pidió también avanza. Un enlace vencido lo avisa. El campo de código queda por si el correo lo trae.
- Hace falta que en Supabase → URL Configuration la Site URL sea el sitio de Netlify. e2e nuevo del enlace válido y del vencido (29 e2e).

**2026-09-29 — Variables de Supabase en Netlify**
- La tarjeta de Sincronización no salía: el sitio no tenía `VITE_SUPABASE_URL` ni `VITE_SUPABASE_KEY`. La operación `manage-env-vars` del conector de Netlify respondía "upserted" sin guardar nada.
- El usuario las creó en la interfaz de Netlify y volvió a publicar; el conector ya las lista. Regla: después de cambiar variables, verificarlas con `getAllEnvVars`.

**2026-09-28 — Sincronización cifrada con Supabase**
- Esquema en `supabase/migrations/`: tabla `datasets` que solo guarda texto cifrado y versión, con RLS; lista de correos permitidos en el esquema `private`; guardado optimista por versión. Probado contra el proyecto real con usuarios sintéticos, ya borrados; el advisor de seguridad quedó sin advertencias.
- App (`src/data/crypto.ts`, `src/app/sync.ts`): comprime (gzip) y cifra en el navegador (PBKDF2 + AES-GCM). Entra con código por correo. Nunca fusiona: en conflicto se elige una copia y la otra se guarda y se descarga. Estado visible en el encabezado.
- `finance-reviewer`, dos pasadas: corregidas una edición perdida durante una descarga, la nube que retrocede, la marca de cambios sin subir que no sobrevivía una recarga y la clave olvidada al abrir sin conexión. Todo con e2e contra un Supabase simulado.

**2026-09-28 — Netlify desde GitHub**
- El 404 venía de que Netlify publicaba `main`, que solo tiene `CLAUDE.md`. El usuario eligió publicar la rama de trabajo, sin pull request.
- `netlify.toml` omite el build cuando un push solo cambia `bitacora.md`. Construye siempre en el primer deploy y en los manuales.
- Como cada push se publica, antes de subir código se corren build y e2e.

**2026-09-28 — Netlify** (061ab77)
- `netlify.toml`: build `npm run build`, publica `dist/`.
- El build genera `dist/_headers` con una CSP estricta que solo permite el script propio, por hash, más `X-Frame-Options`, `nosniff` y `no-referrer`. Verificado en Chromium con el ejemplo: sin errores.
- Sitio `portfoliomanager-sr` creado en el equipo del usuario. El deploy desde esta sesión fue bloqueado por permisos, porque el comando lleva una credencial.

**2026-09-28 — Plan de la siguiente etapa** (sin commit de código)
- Orden:
  1. publicar en Netlify;
  2. sincronización con Supabase, cifrada en el navegador con una frase del usuario (AES-GCM);
  3. botón de precios con Twelve Data, TRM oficial y CoinGecko;
  4. fundamentales mensuales desde SEC EDGAR.
- Fiscal.ai Pro (vía eToro) es solo la terminal; su API y MCP se pagan aparte. Se usa SEC EDGAR, que es gratis y oficial, con una función de Netlify porque `data.sec.gov` no permite CORS. Se actualiza al abrir la app en un mes nuevo, en un campo aparte que no pisa los datos manuales.
- Descartados: reporte de renta, costos, Sharpe y rayos X de ETFs.

**2026-09-28 — Estilo getquin** (1e7e0f7)
- Con acceso a app.getquin.com se extrajeron sus tokens reales: gris #f9f9f9, tarjetas blancas con borde #f2f2f2, radio 4px, sin sombras, azul #253bbd, verde #5bc87c y rojo #ef5343, más su modo oscuro.
- Aplicado a toda la app: barra superior blanca con pestañas subrayadas, botones negros, cifras en fuente monoespaciada y etiquetas tipo píldora (Pagado, Estimado, Proyección).
- Mapa de calor con su escala rojo/verde. Gráfico por año como el de getquin: proyección rayada, promedio punteado y cifras bajo cada año.
- Fuentes libres similares (Inter Tight y Geist Mono) incluidas en el HTML. No se pudo ver: www.getquin.com sigue bloqueado y el tablero personal pide iniciar sesión.

**2026-09-28 — Pestaña Dividendos** (55f80cc)
- `src/app/dividends.ts`: dividendos netos por mes, año y activo, a la tasa de cada fecha; últimos 12 meses frente a los 12 anteriores y año corrido, con la parte estimada.
- Proyección de 12 meses: repite los pagos de los últimos 12 meses de lo que sigue en cartera, escalada a las unidades de hoy (en fondos, al capital). Incluye calendario y rentabilidad neta sobre valor y sobre costo.
- Revisión de `finance-reviewer`: unidades al inicio del día del pago, fondos con retiro parcial, 29 de febrero, rentabilidad sin precio, estimados marcados, crecimiento solo con años completos. Todo corregido y con prueba.
- Estilo getquin: no se pudo ver, porque la red bloquea getquin.com, tiendas de apps y reseñas.

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
