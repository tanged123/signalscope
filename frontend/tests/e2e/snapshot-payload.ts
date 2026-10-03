import { deflateRawSync } from "node:zlib";
import type { BakedSignal, SignalSummary } from "../../src/generated/protocol";

/**
 * Encodes raw samples as ADR 0068 `samples` levels: byte-shuffled f64
 * columns, then the trailing column table, deflated and base64-encoded.
 */
export function bakeSampleSignals(
  series: { summary: SignalSummary; time: number[]; values: number[] }[],
): { payload: string; signals: BakedSignal[] } {
  const columns: Buffer[] = [];
  const lengths: number[] = [];
  const column = (values: number[]): number => {
    const raw = Buffer.from(Float64Array.from(values).buffer);
    const shuffled = Buffer.alloc(raw.length);
    for (let index = 0; index < values.length; index += 1) {
      for (let byte = 0; byte < 8; byte += 1) {
        shuffled[byte * values.length + index] = raw[index * 8 + byte] ?? 0;
      }
    }
    columns.push(shuffled);
    lengths.push(values.length);
    return columns.length - 1;
  };
  const signals = series.map(({ summary, time, values }) => ({
    summary,
    levels: [
      { encoding: "samples" as const, columns: [column(time), column(values)] },
    ],
  }));
  const table = Buffer.alloc(lengths.length * 5 + 4);
  lengths.forEach((length, index) => {
    table.writeUInt32LE(length, lengths.length + index * 4);
  });
  table.writeUInt32LE(lengths.length, lengths.length * 5);
  return {
    payload: deflateRawSync(Buffer.concat([...columns, table])).toString(
      "base64",
    ),
    signals,
  };
}
