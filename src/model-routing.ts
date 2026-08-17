/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 */

import { WorkflowError, WorkflowErrorCode } from "./errors.js";

const MAX_PHASE_PATTERN_LENGTH = 200;
// A quantified group whose body contains a quantifier, at any nesting depth:
// (a+)+, ((a+))+, (?:a*)+, (x+){2,}. The body alternation `(?:[^(]|\([^()]*\))*`
// lets one level of nested parentheses inside the group, so shapes hidden in a
// second group still match. These backtrack exponentially on non-matching input.
const NESTED_QUANTIFIER_PATTERN = /\((?:[^(]|\([^()]*\))*[+*{](?:[^(]|\([^()]*\))*\)[+*{]/;
// A quantified group that contains an alternation: (a|b)+, (a|aa)*, (x|y){2,}.
// The alternation branches can match the same input in overlapping ways, which
// is the classic exponential-backtracking shape ((a|aa)+$). Phase routing only
// needs simple patterns, so reject these rather than reason about branch
// ambiguity.
const QUANTIFIED_ALTERNATION_PATTERN = /\((?:[^(]|\([^()]*\))*\|(?:[^(]|\([^()]*\))*\)[+*{]/;

export interface ModelRoute {
  /** Phase name pattern (regex or exact match). */
  phasePattern: string;
  /** Model to use for this phase. */
  model: string;
  /** Whether to use regex matching. */
  useRegex?: boolean;
}

export interface ModelRoutingConfig {
  /** Default model for all phases. */
  defaultModel?: string;
  /** Per-phase model overrides. */
  routes: ModelRoute[];
}

/**
 * Resolve which model to use for a given phase.
 */
export function resolveModelForPhase(phase: string | undefined, config: ModelRoutingConfig): string | undefined {
  for (const route of config.routes) {
    if (route.useRegex) validatePhasePattern(route.phasePattern);
  }
  if (!phase || !config.routes.length) {
    return config.defaultModel;
  }

  for (const route of config.routes) {
    if (route.useRegex) {
      const regex = new RegExp(route.phasePattern, "i");
      if (regex.test(phase)) {
        return route.model;
      }
    } else if (phase === route.phasePattern) {
      // Exact, case-sensitive match — phase titles are author-controlled literals,
      // so fuzzy substring matching only caused mis-routes (e.g. "analyze" matching
      // "analyze-deep" or vice-versa). Use the regex branch for fuzzy needs.
      return route.model;
    }
  }

  return config.defaultModel;
}

function validatePhasePattern(pattern: string): void {
  if (typeof pattern !== "string") {
    throw new WorkflowError(
      `Invalid phasePattern regex ${String(pattern)}: pattern must be a string`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (pattern.length > MAX_PHASE_PATTERN_LENGTH) {
    throw new WorkflowError(
      `Invalid phasePattern regex "${pattern}": pattern exceeds the ${MAX_PHASE_PATTERN_LENGTH}-character limit`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  // The patterns above already match at any nesting depth, so test the raw
  // pattern directly. This stays a heuristic (JS RegExp catastrophic
  // backtracking is undecidable in general), but it closes the common
  // exponential shapes: nested quantifiers and quantified alternation.
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    throw new WorkflowError(
      `Unsafe phasePattern regex "${pattern}": nested quantifiers are not allowed`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (QUANTIFIED_ALTERNATION_PATTERN.test(pattern)) {
    throw new WorkflowError(
      `Unsafe phasePattern regex "${pattern}": quantified alternation groups are not allowed`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  try {
    new RegExp(pattern, "i");
  } catch (error) {
    throw new WorkflowError(
      `Invalid phasePattern regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
}

/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export function parseModelRoutingFromMeta(
  phases?: Array<{ title: string; model?: string }>,
  defaultModel?: string,
): ModelRoutingConfig {
  const routes: ModelRoute[] = [];

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
