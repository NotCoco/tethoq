export type TethoqEnvironmentName = `TETHOQ_${string}`;

/**
 * Read a public Tethoq setting while preserving the legacy UAR_* name for
 * existing installations. The canonical TETHOQ_* value always wins.
 */
export function tethoqEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: TethoqEnvironmentName,
): string | undefined {
  const canonical = environment[name];
  if (canonical !== undefined) return canonical;
  return environment[`UAR_${name.slice("TETHOQ_".length)}`];
}

export function tethoqEnvironmentFlag(
  environment: NodeJS.ProcessEnv,
  name: TethoqEnvironmentName,
): boolean {
  return tethoqEnvironmentValue(environment, name) === "1";
}
