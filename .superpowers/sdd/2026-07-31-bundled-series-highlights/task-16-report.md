# Task 16 report

- XY color samples now resolve by each Y trace's source and local color path.
- Missing source-local color signals leave only that trace uncolored; derived Y traces keep the selected shared color signal.
- Multi-source X/color labels and color chips use local paths; explicit label overrides win.
- XY sample queries include each source's resolved color path and skip derived metadata resolution.

Validation:

- `./scripts/test.sh unit frontend/src/ui/panel.test.ts`
- `./scripts/test.sh frontend`
- `treefmt frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/ui/panel.test.ts`

`./scripts/format.sh --check` also finds a user-untracked, unrelated design document that needs formatting; it was left untouched.
