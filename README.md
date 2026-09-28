# Mis inversiones

Tracker personal de inversiones: registro de movimientos, rentabilidad XIRR y TWR, y comparación contra índices de retorno total.

## Usar

1. `npm install && npm run build`
2. Abre `dist/index.html` en el navegador (doble clic; no necesita servidor).
3. En **Datos**, importa tu respaldo `.json` o carga la demostración.

Los datos se guardan solo en el navegador (IndexedDB). Descarga un respaldo en **Datos** después de cada cierre de mes.

## Desarrollo

`npm run dev` · `npm test` · `npm run test:e2e` · `npm run typecheck`

## Con Claude Code

- `/month-close [AAAA-MM]`: qué falta para cerrar el mes (precios, TRM, valores manuales) y archivos listos para importar, con fuente y fecha.
- `/import-statement [cuenta]`: convierte un extracto en movimientos validados y cuadrados contra los saldos del extracto.
- `/thesis-review [TICKER … | todas]`: calificaciones de foso económico y fundamentales publicados por proveedores, con fecha y enlace.
- Revisor `finance-reviewer`: revisa los cambios de cálculo antes de cada commit.
- Subagentes que hacen el trabajo pesado y devuelven un resumen corto:
  - `market-data`: precios, TRM e índices de cierre, con fuente.
  - `statement-reader`: un extracto convertido en movimientos cuadrados.
  - `moat-researcher`: calificaciones de foso por proveedor.
  - `app-verifier`: pruebas, build y capturas de la app.
- El hook de pre-commit (`npm install` lo activa) impide subir datos personales o claves y código con pruebas en rojo.

En todos los casos trabajas con un respaldo que descargas en **Datos**. Los archivos resultantes se importan en esa misma pantalla y nunca entran al repositorio.
