export const maximumUiSearchCharacters = 160;

/** Normalizes only an in-memory UI query; it never resolves paths or starts external search. */
export function normalizeUiSearchQuery(value: string, maximum = maximumUiSearchCharacters): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase()
    .slice(0, Math.max(0, maximum));
}
