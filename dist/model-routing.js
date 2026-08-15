/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 */
/**
 * Resolve which model to use for a given phase.
 */
export function resolveModelForPhase(phase, config) {
    if (!phase || !config.routes.length) {
        return config.defaultModel;
    }
    for (const route of config.routes) {
        if (route.useRegex) {
            try {
                const regex = new RegExp(route.phasePattern, "i");
                if (regex.test(phase)) {
                    return route.model;
                }
            }
            catch {
                // Invalid regex, skip
            }
        }
        else if (phase === route.phasePattern) {
            // Exact, case-sensitive match — phase titles are author-controlled literals,
            // so fuzzy substring matching only caused mis-routes (e.g. "analyze" matching
            // "analyze-deep" or vice-versa). Use the regex branch for fuzzy needs.
            return route.model;
        }
    }
    return config.defaultModel;
}
/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export function parseModelRoutingFromMeta(phases, defaultModel) {
    const routes = [];
    if (phases) {
        for (const phase of phases) {
            if (phase.model) {
                routes.push({
                    phasePattern: phase.title,
                    model: phase.model,
                });
            }
        }
    }
    return { defaultModel, routes };
}
