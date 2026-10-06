import { describe, expect, it } from "vitest";
import { getSetups, SETUPS, twinOf } from "../../src/eval/setups";

describe("setups", () => {
  it("lists the 8 setups in table order", () => {
    expect(SETUPS.map((setup) => setup.id)).toEqual([
      "H0",
      "H1",
      "S0",
      "S1",
      "OM0",
      "OM1",
      "OX0",
      "OX1",
    ]);
  });

  it("returns the asked setups in table order, and all of them when none are asked for", () => {
    expect(getSetups(["S1", "H0"]).map((setup) => setup.id)).toEqual(["H0", "S1"]);
    expect(getSetups()).toHaveLength(8);
  });

  it("rejects an unknown setup ID and lists the valid ones", () => {
    expect(() => getSetups(["H0", "ZZ"])).toThrow(/Unknown setup ZZ.*H0, H1, S0/);
  });

  it("pairs every setup with the one that differs only by the verifier", () => {
    const pairs = SETUPS.map((setup) => `${setup.id} ${twinOf(setup)?.id}`);
    expect(pairs).toEqual([
      "H0 H1",
      "H1 H0",
      "S0 S1",
      "S1 S0",
      "OM0 OM1",
      "OM1 OM0",
      "OX0 OX1",
      "OX1 OX0",
    ]);
  });

  it("gives no twin to a setup that is not in the list", () => {
    expect(twinOf({ id: "X1", model: "some-other-model", verifier: true })).toBeNull();
  });
});
