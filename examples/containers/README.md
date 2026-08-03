# Container examples

Sample files for the non-CSV formats, all describing the same synthetic
60-second launch (1,200 samples at 20 Hz). Load one with `Open…`, `Ctrl+Shift+O`
for the whole folder, or by dropping it on the window.

| File | Format | What it exercises |
| --- | --- | --- |
| `flight_run.h5` + `.scope.toml` | HDF5 | Nested groups, one shared timebase, units read from HDF5 attributes |
| `sweep.parquet` + `.scope.toml` | Parquet | Flat columns, one column as the timebase, units declared in the recipe |
| `flight_run.mcap` | MCAP | Three JSON topics flattened into signal paths, including a boolean |
| `flight_run_no_recipe.h5` | HDF5 | No sidecar, so the import wizard opens and writes a recipe for you |

CSV needs no recipe — see `../demo_flight.csv` and `../monte_carlo/`.

## What loads without help

CSV and MCAP are self-describing, so SignalScope reads them directly.

HDF5 and Parquet are containers: they hold arbitrary datasets with no
convention for which one is time or what a signal is called. They need a
**recipe** — a `.scope.toml` file naming the datasets to read, where their time
comes from, and what to call them. Open `flight_run_no_recipe.h5` to watch the
import wizard build one.

A recipe is resolved from `<data file>.scope.toml` beside the data first, then
from the recipe directory in preferences. It is data and only data: unknown
keys are a hard parse error at every level, so a recipe can never name a
program, plugin, or path outside its own container.

## Writing a recipe by hand

Both `.scope.toml` files here are commented. Three things are easy to trip over:

- **`*` matches exactly one whole path segment.** There are no partial
  wildcards — `*_deg` matches nothing. Use `**` to match any depth.
- **The timebase is not excluded automatically.** A pattern that also matches
  the time dataset plots time against itself. `flight_run.h5.scope.toml` selects
  `run/vehicle/*` and `run/propulsion/*` rather than `run/**` for that reason.
- **Units come from `unit = "m/s"` or `unit_attribute = "units"`**, the second
  reading the value from the dataset's own attribute.

Editing a recipe changes its content digest, which invalidates the cached
columns for that source and asks you to reconfirm it on reopen.

## Regenerating

These files are generated, not hand-authored. `flight_run_no_recipe.h5` is a
byte-identical copy of `flight_run.h5` with no sidecar beside it.
