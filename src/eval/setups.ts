import type { Setup } from "../types";
import { VERIFIER_MODEL } from "../verify/verifier";

// The verifier model is defined next to the verifier. It is exported from here too, so the eval
// names all three roles in one place.
export { VERIFIER_MODEL };

/** The model that grades answers in the eval. It never sees which setup wrote an answer. */
export const JUDGE_MODEL = "claude-opus-5-5";

/**
 * The 10 setups the eval compares. Five ways of answering, each with the verifier off (0) and on (1).
 * The order here is the order of the rows in the results table.
 * H5 is Haiku 5.5. It was added on 8 October 2026, soon after it came out and before any run was graded.
 */
export const SETUPS: Setup[] = [
  { id: "H0", model: "claude-haiku-4-5", verifier: false },
  { id: "H1", model: "claude-haiku-4-5", verifier: true },
  { id: "H5-0", model: "claude-haiku-5-5", verifier: false },
  { id: "H5-1", model: "claude-haiku-5-5", verifier: true },
  { id: "S0", model: "claude-sonnet-5-5", verifier: false },
  { id: "S1", model: "claude-sonnet-5-5", verifier: true },
  { id: "OM0", model: "claude-opus-5-5", effort: "medium", verifier: false },
  { id: "OM1", model: "claude-opus-5-5", effort: "medium", verifier: true },
  { id: "OX0", model: "claude-opus-5-5", effort: "xhigh", verifier: false },
  { id: "OX1", model: "claude-opus-5-5", effort: "xhigh", verifier: true },
];

/** Returns the setups with these IDs, in table order. With no IDs it returns all 10. */
export function getSetups(ids?: string[]): Setup[] {
  if (!ids || ids.length === 0) return SETUPS;

  const known = SETUPS.map((setup) => setup.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown setup ${unknown.join(", ")}. The setups are ${known.join(", ")}.`);
  }
  return SETUPS.filter((setup) => ids.includes(setup.id));
}

/**
 * Returns the setup that differs only by the verifier, so H1 gives H0 and H0 gives H1.
 * Returns null for a setup that is not in the list.
 */
export function twinOf(setup: Setup): Setup | null {
  const twin = SETUPS.find(
    (other) =>
      other.model === setup.model &&
      other.effort === setup.effort &&
      other.verifier !== setup.verifier,
  );
  return twin ?? null;
}
