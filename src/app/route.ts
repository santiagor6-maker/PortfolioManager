/** Reads `name` from the hash query, e.g. `#/activos?clase=fondos`. */
export function queryParam(name: string): string | undefined {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(name) ?? undefined : undefined;
}
