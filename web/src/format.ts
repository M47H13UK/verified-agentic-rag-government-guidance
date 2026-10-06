// Small helpers that turn numbers and dates into the text the page shows.
import type { Setup } from "../../src/types";

/** "31 October 2024", the way GOV.UK writes dates. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "6 Oct 2026, 13:00". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** "13:00:05". Tool calls are seconds apart, so the seconds are shown. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB");
}

/** 0.864 becomes "86%". Pass `digits` to keep decimals, for rates where 2% and 3% differ. */
export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** One answer costs a cent or less, so amounts under a dollar keep three decimals. */
export function formatUsd(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** 21200 becomes "21.2 s". */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 14200 becomes "14,200". */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-GB");
}

/** "H1 (claude-haiku-4-5, verifier on)". */
export function setupLabel(setup: Setup): string {
  const effort = setup.effort ? `, ${setup.effort} effort` : "";
  return `${setup.id} (${setup.model}${effort}, verifier ${setup.verifier ? "on" : "off"})`;
}

/** "personal_judgement" becomes "personal judgement". */
export function categoryLabel(category: string): string {
  return category.replaceAll("_", " ");
}
