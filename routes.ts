/**
 * routes.ts — pure route-decision logic for pens-completions.
 *
 * One source of truth: server.ts and server.test.ts both import from here.
 * No I/O, no env reads, no server boot — just the filesystem-registry routing
 * contracts and the reasoning-budget floor.
 */

/** Meta segments that never pick an agent. */
export const META_SEGMENTS = ["pens", "local", "v1", "completions"];

/** Strip a leading pens:// scheme if present. */
export function stripScheme(model: string): string {
	return model.replace(/^pens:\/\//, "");
}

/** Split a model route into its meaningful chain elements. */
export function filterChain(model: string): string[] {
	return stripScheme(model)
		.split(".")
		.filter((p) => p !== "" && !META_SEGMENTS.includes(p));
}

/** The agent/upstream selector: last chain element, defaulting to echo. */
export function pickTarget(chain: string[]): string {
	return chain.at(-1) ?? "echo";
}

/**
 * Reasoning-budget floor (AGENTS.md D-2026-10-23 #1): reasoning and content
 * tokens share ONE ceiling. Below 2500, reasoning models starve content.
 */
export function budgetFloor(maxTokens: number): number {
	return Math.max(2500, maxTokens);
}

/**
 * Resolve the upstream model id for a route. Local canaries map to
 * themselves; `router` maps to the default mesh model; anything else is
 * passed through as an upstream model id (mesh has 500+).
 */
export function normalizeModel(route: string, defaultMeshModel: string): string {
	const chain = filterChain(route);
	const target = pickTarget(chain);
	if (target === "echo" || target === "wtf") return route;
	if (target === "router") return defaultMeshModel;
	return route;
}
