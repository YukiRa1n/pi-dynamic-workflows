/**
 * `/workflows-models` command handler.
 *
 * Uses Pi's built-in `ctx.ui.select()`, `ctx.ui.confirm()`, and `ctx.ui.notify()`
 * to let users view and manage model tier configuration for workflows.
 *
 * Model selection draws from the host session's shared model registry so users
 * see every provider Pi can reach, including extension-registered providers such
 * as `ollama-cloud`.
 *
 * Each tier holds exactly one model spec string. The string may include Pi
 * CLI-style thinking suffixes, e.g. `openai-codex/gpt-5.5:xhigh`.
 * When editing a tier, users pick a model, then an optional thinking level.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
/**
 * Register the `/workflows-models` command with Pi.
 */
export declare function registerWorkflowModelsCommand(pi: ExtensionAPI): void;
/**
 * Interactive editor for a single tier — scrollable model picker plus optional
 * thinking-level picker.
 *
 * Uses `ctx.ui.custom()` with Pi TUI's `SelectList` for proper scrollable list
 * with limited visible rows (like `/advisor`). The currently selected base
 * model is shown in the dialog title. After choosing the model, users can set
 * a Pi CLI-style thinking suffix or keep the session default.
 *
 * Returns the updated tiers object, or null if nothing changed.
 */
export declare function editSingleTier(ctx: ExtensionCommandContext, tiers: Record<string, string>, tierName: string): Promise<Record<string, string> | null>;
