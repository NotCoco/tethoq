/** Full paths identify projects across harnesses; labels never establish identity. */
export function normalizeProjectDirectory(value: string | undefined): string {
  const trimmed = (value?.trim() ?? "").replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\(?=[a-z]:)/iu, "");
  if (!trimmed) return "";
  const windows = /^[a-z]:[\\/]/iu.test(trimmed) || /^[\\/]{2}/u.test(trimmed);
  const unc = /^[\\/]{2}/u.test(trimmed);
  const separator = windows ? "\\" : "/";
  let normalized = trimmed.replace(/[\\/]+/gu, separator);
  if (unc) normalized = `\\\\${normalized.replace(/^\\+/u, "")}`;
  if (!/^[a-z]:\\$/iu.test(normalized) && normalized !== "/") normalized = normalized.replace(/[\\/]+$/u, "");
  return windows ? normalized.toLocaleLowerCase() : normalized;
}

export function normalizeSavedProjectDirectories(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const directories = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const directory = item.trim();
    if (!/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/iu.test(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) continue;
    const key = normalizeProjectDirectory(directory);
    if (!directories.has(key)) directories.set(key, directory);
  }
  return [...directories.values()];
}
