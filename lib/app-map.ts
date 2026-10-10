import { appUrl } from "@/lib/app-url";

import screens from "./app-map.json";

// The app's screens (generated from each page's `// @map` line on every
// build: scripts/app-map.mjs), so the Chief of Staff can send people straight
// to the right one, with the link and where it is in the menus.

export type Screen = { path: string; title: string; where: string; what: string };

export const SCREENS: Screen[] = screens;

/** The screens as the Chief of Staff reads them: a full link (with {placeholders} to fill in), where it is, what's there. */
export function appMapLines(): string {
  return SCREENS.map((s) => `- ${s.title}: ${appUrl(s.path === "/" ? "/" : s.path)} (${s.where}). ${s.what}`).join("\n");
}
