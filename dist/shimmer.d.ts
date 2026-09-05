import type { Theme } from "@earendil-works/pi-coding-agent";
type ShimmerTheme = Pick<Theme, "bold" | "fg">;
/** Test hook: drop cached palettes (theme identity is by function reference). */
export declare function clearShimmerPaletteCache(): void;
/**
 * Apply OMP-style moving light to a short live label. Adjacent cells with the
 * same intensity tier are styled as one run, keeping ANSI output compact.
 */
export declare function shimmerText(text: string, theme: ShimmerTheme, now?: number): string;
export {};
