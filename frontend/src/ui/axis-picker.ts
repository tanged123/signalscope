import type { Catalog, CatalogSeries } from "../app/catalog";
import { axisRefs } from "../app/line-bindings";
import { parseSelector, seriesMatches } from "../app/selector";
import type {
  NamedSet,
  SeriesRef,
  SampleAxisSource,
} from "../generated/session";
import { showPanelMenu, type MenuOption } from "./panel-menu";

export function xAxisLabel(axis: SampleAxisSource, catalog: Catalog): string {
  if (axis.kind === "time") return "time";
  if (axis.kind === "signal")
    return (
      catalog.get(axis.ref)?.path ??
      `${axis.ref.source_key}/${axis.ref.channel}`
    );
  const channels = [...new Set(axis.refs.map((ref) => ref.channel))];
  return `${channels.length === 1 ? (channels[0] ?? "bundle") : "bundle"} · ${String(axis.refs.length)} runs`;
}

export function showAxisPicker(
  container: HTMLElement,
  anchor: HTMLElement,
  axis: "x" | "y" | "c",
  current: SampleAxisSource,
  catalog: Catalog,
  sets: readonly NamedSet[],
  selectX: (axis: SampleAxisSource) => void,
  addY: (paths: string[]) => void,
  clearColor?: () => void,
  colorActive = false,
  addYSet?: (id: string) => void,
): () => void {
  const refFor = (series: CatalogSeries): SeriesRef => ({
    source_key: series.sourceKey,
    channel: series.channel,
  });
  const choose = (refs: SeriesRef[]): void => {
    if (refs.length === 0) return;
    if (axis === "y") {
      addY(
        refs.flatMap((ref) => {
          const series = catalog.get(ref);
          return series === undefined ? [] : [series.path];
        }),
      );
    } else {
      selectX(
        refs.length === 1
          ? { kind: "signal", ref: refs[0] as SeriesRef }
          : { kind: "bundle", refs },
      );
    }
  };
  const options: MenuOption[] =
    axis !== "y"
      ? [
          {
            label: axis === "c" ? "time · source anchor" : "time · linked",
            active: current.kind === "time" && (axis !== "c" || colorActive),
            run: () => selectX({ kind: "time" }),
          },
        ]
      : [];
  if (axis === "c")
    options.unshift({
      label: "none · categorical line colors",
      active: !colorActive,
      run: () => clearColor?.(),
    });
  const all = catalog.allSeries();
  const activeRefs = new Set(
    axisRefs(current).map((ref) => catalog.refKey(ref)),
  );
  for (const channel of catalog.channels()) {
    if (channel.sourceKeys.length < 2) continue;
    const refs = channel.sourceKeys.map((source_key) => ({
      source_key,
      channel: channel.name,
    }));
    options.push({
      label: `${channel.name} · bundle · ${String(refs.length)} runs`,
      active:
        axis !== "y" &&
        current.kind === "bundle" &&
        JSON.stringify(current.refs) === JSON.stringify(refs),
      run: () => choose(refs),
    });
  }
  for (const set of sets) {
    const selector = parseSelector(set.selector ?? "");
    const refs =
      set.kind === "pick"
        ? set.refs
        : selector.ok
          ? all
              .filter((series) => seriesMatches(selector.selector, series))
              .map(refFor)
          : [];
    if (refs.length > 0 || axis === "y")
      options.push({
        label: `${set.name} · set · ${String(refs.length)} signals`,
        active: false,
        run: () => (axis === "y" ? addYSet?.(set.id) : choose(refs)),
      });
  }
  for (const series of all) {
    const ref = refFor(series);
    options.push({
      label: series.path,
      active: axis !== "y" && activeRefs.has(catalog.refKey(ref)),
      run: () => choose([ref]),
    });
  }
  return showPanelMenu(
    container,
    anchor,
    axis === "y"
      ? "ADD Y SIGNALS"
      : `${axis.toUpperCase()} AXIS · bundles pair by source`,
    options,
    true,
  );
}
