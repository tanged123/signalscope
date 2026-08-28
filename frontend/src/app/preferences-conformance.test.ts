import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/preferences-conformance.json";
import type { Preferences } from "../generated/preferences";
import { PREFERENCES_SCHEMA_VERSION } from "../generated/preferences";
import { defaultPreferences, parsePreferences } from "./preferences";

const fixture = fixtureJson as Preferences;

describe("preferences conformance", () => {
  it("parses the Rust fixture as the generated Preferences type", () => {
    expect(fixture.schema_version).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(fixture.ui_font_family).toBe("inter");
  });

  it("emits the Rust fixture defaults", () => {
    expect(defaultPreferences()).toEqual(fixture);
  });

  it("repairs malformed and zero presentation budgets to Auto", () => {
    const parsed = parsePreferences(
      JSON.stringify({
        ...fixture,
        presentation_cpu_bytes: "0",
        presentation_gpu_bytes: "not-a-number",
      }),
    );
    expect(parsed?.presentation_cpu_bytes).toBeNull();
    expect(parsed?.presentation_gpu_bytes).toBeNull();
  });

  it("preserves positive decimal presentation budgets", () => {
    const parsed = parsePreferences(
      JSON.stringify({
        ...fixture,
        presentation_cpu_bytes: "268435456",
        presentation_gpu_bytes: "536870912",
      }),
    );
    expect(parsed?.presentation_cpu_bytes).toBe("268435456");
    expect(parsed?.presentation_gpu_bytes).toBe("536870912");
  });
});
