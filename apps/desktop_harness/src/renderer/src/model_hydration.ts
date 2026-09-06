import type { ModelOption } from "./types";

export function beginModelHydration(
  generations: Map<string, number>,
  providerIds: readonly string[],
): ReadonlyMap<string, number> {
  const started = new Map<string, number>();
  for (const providerId of new Set(providerIds)) {
    const generation = (generations.get(providerId) ?? 0) + 1;
    generations.set(providerId, generation);
    started.set(providerId, generation);
  }
  return started;
}

/**
 * Apply only successful catalogues from the newest request for each provider.
 * A missing property is a failed probe; an explicit empty array is a successful
 * provider response and deliberately clears that provider's choices.
 */
export function mergeLatestModelCatalogues(
  current: Record<string, ModelOption[]>,
  availableProviderIds: ReadonlySet<string>,
  loaded: Record<string, ModelOption[]>,
  started: ReadonlyMap<string, number>,
  latest: ReadonlyMap<string, number>,
): Record<string, ModelOption[]> {
  let next = current;
  for (const [providerId, generation] of started) {
    if (latest.get(providerId) !== generation) continue;
    if (!availableProviderIds.has(providerId) || !Object.hasOwn(loaded, providerId)) continue;
    if (next === current) next = { ...current };
    next[providerId] = loaded[providerId]!;
  }
  return next;
}
