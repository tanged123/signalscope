import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/session-conformance.json";
import parserCases from "../../../protocol/testdata/session-parser-cases.json";
import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { parseBakedSession } from "./baked-session";
import { emptySession } from "./workspace";

const fixture = parseBakedSession(JSON.stringify(fixtureJson));

describe("session conformance", () => {
  it("validates the Rust fixture through the snapshot parser", () => {
    expect(fixture.app).toBe("signalscope");
    expect(fixture.schema_version).toBe(SESSION_SCHEMA_VERSION);
    expect(fixture.derived[0]?.expr).toBe("hypot('imu/vx', 'imu/vy')");
    expect(fixture.sources[0]?.path).toBe("/data/run.csv");
  });

  it.each(parserCases.cases)("runtime parser: $name", (testCase) => {
    const input = {
      ...fixtureJson,
      ...testCase.session,
      tabs: [
        {
          ...fixtureJson.tabs[0],
          panels: [{ ...parserCases.panel, ...testCase.panel }],
        },
      ],
    };
    const parse = (): unknown => parseBakedSession(JSON.stringify(input));
    if (testCase.valid) {
      expect(parse).not.toThrow();
      const session = parseBakedSession(JSON.stringify(input));
      expect(parseBakedSession(JSON.stringify(session))).toEqual(session);
      for (const annotation of session.tabs[0]?.panels[0]?.annotations ?? []) {
        expect(annotation.pinned_x).toBeNull();
      }
    } else {
      expect(parse).toThrow();
    }
  });

  it("emits every key the Rust fixture carries", () => {
    expect(Object.keys(emptySession()).sort()).toEqual(
      Object.keys(fixture).sort(),
    );
  });
});
