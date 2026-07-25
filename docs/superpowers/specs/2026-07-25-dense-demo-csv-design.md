# Dense bundled demo CSV design

## Goal

Make the bundled native CSV useful in FFT mode. Its current 41 samples cannot
meet the accepted 64-sample transform minimum, even when the complete 0–20 s
record is visible.

## Data design

Keep the existing 41 rows as authoritative keyframes and add samples on a
uniform 0.1 s grid, yielding 201 data rows over the same inclusive 0–20 s
extent.

- Linearly interpolate continuous numeric telemetry between keyframes.
- Hold boolean, discrete-state, target, and throttle fields at their preceding
  keyframe value until the next authored transition.
- Emit every original 0.5 s keyframe exactly as authored.
- Preserve the existing empty cells at their exact keyframe timestamps so the
  demo continues to exercise gap handling.
- Retain the existing comments, header, signal names, and column order.

This adds sample density without changing the flight trajectory, event timing,
or ingest/protocol behavior.

## Verification

Strengthen the existing Rust ingest regression to require 201 rows, 16 signals,
the original 0–20 s bounds, and the existing GPS gap count. Run the core suite,
then the repository-wide quality gate because the shared example is consumed
by native ingest tests and user-facing workflows.
