import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/preferences-conformance.json";
import type { Preferences } from "../generated/preferences";
import { PREFERENCES_SCHEMA_VERSION } from "../generated/preferences";
import { defaultPreferences } from "./preferences";

const fixture = fixtureJson as Preferences;

describe("preferences conformance", () => {
  it("parses the Rust fixture as the generated Preferences type", () => {
    expect(fixture.schema_version).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(fixture.ui_font_family).toBe("inter");
  });

  it("emits the Rust fixture defaults", () => {
    expect(defaultPreferences()).toEqual(fixture);
  });
});
