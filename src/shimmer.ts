import type { Theme } from "@earendil-works/pi-coding-agent";

type ShimmerTheme = Pick<Theme, "bold" | "fg">;

// Match OMP's live subagent sweep: a fixed-speed highlight keeps the motion
// smooth and consistent regardless of label length.
const SPEED_CELLS_PER_SECOND = 30;
const EDGE_PADDING = 10;
const BAND_HALF_WIDTH = 6;
const HIGH_INTENSITY = 0.65;
const MID_INTENSITY = 0.22;
/** Palette cache size cap; themes rarely exceed a handful per process. */
const MAX_PALETTE_CACHE = 16;

type Tier = "low" | "mid" | "high";

function intensityAt(now: number, index: number, length: number): number {
  const period = length + EDGE_PADDING * 2;
  const position = ((now / 1000) * SPEED_CELLS_PER_SECOND) % period;
  const distance = Math.abs(index + EDGE_PADDING - position);
  if (distance >= BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / BAND_HALF_WIDTH));
}

function tierAt(intensity: number): Tier {
  if (intensity >= HIGH_INTENSITY) return "high";
  if (intensity >= MID_INTENSITY) return "mid";
  return "low";
}

/**
 * Per-theme compiled style palette (OMP's palette/ANSI compile cache).
 *
 * `theme.fg("accent", …)` etc. allocate a fresh ANSI-wrapped string per call;
 * at 30 FPS across several shimmering labels that is the hottest allocation in
 * the panel loop. Compiling the three tier stylers once per theme identity and
 * reusing them turns per-frame work into plain string concatenation.
 */
interface ShimmerPalette {
  style(text: string, tier: Tier): string;
}

const paletteCache = new Map<ShimmerTheme, ShimmerPalette>();

function resolvePalette(theme: ShimmerTheme): ShimmerPalette {
  const cached = paletteCache.get(theme);
  if (cached) return cached;
  const palette: ShimmerPalette = {
    style(text: string, tier: Tier): string {
      if (tier === "high") return theme.bold(theme.fg("accent", text));
      if (tier === "mid") return theme.bold(text);
      return text;
    },
  };
  if (paletteCache.size >= MAX_PALETTE_CACHE) {
    // Drop the oldest entry (insertion order); themes are long-lived, so this
    // only triggers on pathological theme churn.
    const oldest = paletteCache.keys().next().value;
    if (oldest !== undefined) paletteCache.delete(oldest);
  }
  paletteCache.set(theme, palette);
  return palette;
}

/** Test hook: drop cached palettes (theme identity is by function reference). */
export function clearShimmerPaletteCache(): void {
  paletteCache.clear();
}

/**
 * Apply OMP-style moving light to a short live label. Adjacent cells with the
 * same intensity tier are styled as one run, keeping ANSI output compact.
 */
export function shimmerText(text: string, theme: ShimmerTheme, now = Date.now()): string {
  const cells = Array.from(text);
  if (cells.length === 0) return "";

  const palette = resolvePalette(theme);
  let output = "";
  let run = cells[0];
  let runTier = tierAt(intensityAt(now, 0, cells.length));

  for (let index = 1; index < cells.length; index++) {
    const tier = tierAt(intensityAt(now, index, cells.length));
    if (tier === runTier) {
      run += cells[index];
      continue;
    }
    output += palette.style(run, runTier);
    run = cells[index];
    runTier = tier;
  }

  return output + palette.style(run, runTier);
}
