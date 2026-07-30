import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/session-conformance.json";
import type { Session } from "../generated/session";
import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { emptySession } from "./workspace";

const fixture = fixtureJson as Session;

describe("session conformance", () => {
  it("parses the Rust fixture as the generated Session type", () => {
    expect(fixture.app).toBe("signalscope");
    expect(fixture.schema_version).toBe(SESSION_SCHEMA_VERSION);
    expect(fixture.derived[0]?.expr).toBe("hypot('imu/vx', 'imu/vy')");
    expect(fixture.sources[0]?.path).toBe("/data/run.csv");
  });

  it("emits every key the Rust fixture carries", () => {
    expect(Object.keys(emptySession()).sort()).toEqual(
      Object.keys(fixture).sort(),
    );
  });
});
