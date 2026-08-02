import type { SignalSummary } from "../generated/protocol";
import type { SeriesRef } from "../generated/session";

export const DERIVED_SOURCE_KEY = "derived";

export interface CatalogSeries {
  sourceKey: string;
  channel: string;
  path: string;
  summary: SignalSummary;
}

export interface CatalogChannel {
  name: string;
  sourceKeys: readonly string[];
  unit: string | null;
}

function refKeyOf(sourceKey: string, channel: string): string {
  return `${sourceKey}\u0000${channel}`;
}

export class Catalog {
  private constructor(
    private readonly byRef: Map<string, CatalogSeries>,
    private readonly byAlias: Map<string, CatalogSeries>,
    private readonly byPath: Map<string, CatalogSeries>,
    private readonly channelList: CatalogChannel[],
  ) {}

  static empty(): Catalog {
    return new Catalog(new Map(), new Map(), new Map(), []);
  }

  static build(signals: readonly SignalSummary[]): Catalog {
    const byRef = new Map<string, CatalogSeries>();
    const byAlias = new Map<string, CatalogSeries>();
    const byPath = new Map<string, CatalogSeries>();
    const channels = new Map<
      string,
      { sourceKeys: string[]; unit: string | null }
    >();
    for (const summary of signals) {
      const derived = summary.path.startsWith("derived/");
      const sourceKey = derived ? DERIVED_SOURCE_KEY : summary.source_key;
      const channel = derived ? summary.path.slice(8) : summary.local_path;
      const series: CatalogSeries = {
        sourceKey,
        channel,
        path: summary.path,
        summary,
      };
      byRef.set(refKeyOf(sourceKey, channel), series);
      const separator = summary.path.indexOf("/");
      if (separator !== -1) {
        byAlias.set(
          refKeyOf(summary.path.slice(0, separator), channel),
          series,
        );
      }
      byPath.set(summary.path, series);
      const entry = channels.get(channel) ?? {
        sourceKeys: [],
        unit: summary.unit ?? null,
      };
      if (!entry.sourceKeys.includes(sourceKey))
        entry.sourceKeys.push(sourceKey);
      if (entry.unit === null && summary.unit !== null)
        entry.unit = summary.unit;
      channels.set(channel, entry);
    }
    const channelList = [...channels.entries()]
      .map(([name, entry]) => ({
        name,
        sourceKeys: entry.sourceKeys,
        unit: entry.unit,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return new Catalog(byRef, byAlias, byPath, channelList);
  }

  channels(): readonly CatalogChannel[] {
    return this.channelList;
  }

  allSeries(): readonly CatalogSeries[] {
    return [...this.byPath.values()];
  }

  get(ref: SeriesRef): CatalogSeries | undefined {
    return (
      this.byRef.get(refKeyOf(ref.source_key, ref.channel)) ??
      this.byAlias.get(refKeyOf(ref.source_key, ref.channel))
    );
  }

  refFromPath(path: string): SeriesRef | undefined {
    const series = this.byPath.get(path);
    return series === undefined
      ? undefined
      : { source_key: series.sourceKey, channel: series.channel };
  }

  refKey(ref: SeriesRef): string {
    return refKeyOf(ref.source_key, ref.channel);
  }
}
