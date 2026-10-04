//! Lossless binary column payload for snapshots (ADR 0068).
//!
//! Columns are little-endian, byte-shuffled per element width, deduplicated by
//! content, concatenated into one deflate-raw stream, and base64-encoded.
//! The decompressed stream ends with the column table:
//! `[kind: u8; n] [element count: u32 LE; n] [n: u32 LE]`, where kind is
//! 0 = f64, 1 = u32, 2 = u8. Column offsets follow from table order.

use std::{collections::HashMap, io::Write};

use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::DeflateEncoder};
use scope_protocol::{BakedLevel, BakedLevelEncoding};

use super::SnapshotError;
use crate::bins::{BinLevel, HAS_FIRST, HAS_GAP, HAS_LAST, HAS_MAX, HAS_MIN};

const SAMPLE_FLAGS: u8 = HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX;
const F64: u8 = 0;
const U32: u8 = 1;
const U8: u8 = 2;

pub struct PayloadWriter {
    kinds: Vec<u8>,
    lens: Vec<u32>,
    index: HashMap<Vec<u8>, u32>,
    encoder: DeflateEncoder<Vec<u8>>,
}

impl PayloadWriter {
    pub fn new() -> Self {
        Self {
            kinds: Vec::new(),
            lens: Vec::new(),
            index: HashMap::new(),
            encoder: DeflateEncoder::new(Vec::new(), Compression::default()),
        }
    }

    pub fn f64_column(&mut self, values: &[f64]) -> Result<u32, SnapshotError> {
        let bytes = values.iter().flat_map(|value| value.to_le_bytes());
        self.column(F64, 8, bytes.collect())
    }

    fn u32_column(&mut self, values: &[u32]) -> Result<u32, SnapshotError> {
        let bytes = values.iter().flat_map(|value| value.to_le_bytes());
        self.column(U32, 4, bytes.collect())
    }

    fn u8_column(&mut self, values: &[u8]) -> Result<u32, SnapshotError> {
        self.column(U8, 1, values.to_vec())
    }

    /// Stores non-finite values as NaN, the single "missing" value decoders see.
    pub fn finite_f64_column(&mut self, values: &[f64]) -> Result<u32, SnapshotError> {
        let values = values
            .iter()
            .map(|value| if value.is_finite() { *value } else { f64::NAN })
            .collect::<Vec<_>>();
        self.f64_column(&values)
    }

    fn column(&mut self, kind: u8, width: usize, mut bytes: Vec<u8>) -> Result<u32, SnapshotError> {
        // The kind prefixes the key so equal bytes of different kinds stay apart.
        bytes.insert(0, kind);
        if let Some(index) = self.index.get(&bytes) {
            return Ok(*index);
        }
        let data = &bytes[1..];
        let len = u32::try_from(data.len() / width).map_err(|_| SnapshotError::PayloadTooLarge)?;
        let index = u32::try_from(self.kinds.len()).map_err(|_| SnapshotError::PayloadTooLarge)?;
        self.encoder.write_all(&shuffle(data, width))?;
        self.kinds.push(kind);
        self.lens.push(len);
        self.index.insert(bytes, index);
        Ok(index)
    }

    /// Stores a level as raw `(time, value)` columns when every bin is exactly
    /// the single-sample bin the pyramid derives from that pair; otherwise all
    /// bin columns are stored.
    pub fn level(&mut self, level: &BinLevel) -> Result<BakedLevel, SnapshotError> {
        if is_sample_level(level) {
            let columns = vec![
                self.f64_column(level.t0_column())?,
                self.f64_column(level.first_column())?,
            ];
            return Ok(BakedLevel {
                encoding: BakedLevelEncoding::Samples,
                columns,
            });
        }
        let flags = level.flags_column();
        let present = |values: &[f64], bit: u8| {
            values
                .iter()
                .zip(flags)
                .map(|(value, flag)| if flag & bit == 0 { f64::NAN } else { *value })
                .collect::<Vec<_>>()
        };
        let columns = vec![
            self.f64_column(level.t0_column())?,
            self.f64_column(level.t1_column())?,
            self.f64_column(&present(level.first_column(), HAS_FIRST))?,
            self.f64_column(&present(level.last_column(), HAS_LAST))?,
            self.f64_column(&present(level.min_column(), HAS_MIN))?,
            self.f64_column(&present(level.max_column(), HAS_MAX))?,
            self.f64_column(level.sum_column())?,
            self.f64_column(level.sum_sq_column())?,
            self.u32_column(level.sample_count_column())?,
            self.u32_column(level.finite_count_column())?,
            self.u8_column(flags)?,
        ];
        Ok(BakedLevel {
            encoding: BakedLevelEncoding::Bins,
            columns,
        })
    }

    pub fn finish(mut self) -> Result<String, SnapshotError> {
        let count = u32::try_from(self.kinds.len()).map_err(|_| SnapshotError::PayloadTooLarge)?;
        self.encoder.write_all(&self.kinds)?;
        for len in &self.lens {
            self.encoder.write_all(&len.to_le_bytes())?;
        }
        self.encoder.write_all(&count.to_le_bytes())?;
        Ok(STANDARD.encode(self.encoder.finish()?))
    }
}

fn shuffle(data: &[u8], width: usize) -> Vec<u8> {
    let count = data.len() / width;
    let mut shuffled = vec![0; data.len()];
    for (index, element) in data.chunks_exact(width).enumerate() {
        for (byte, value) in element.iter().enumerate() {
            shuffled[byte * count + index] = *value;
        }
    }
    shuffled
}

/// Mirrors `pyramid::synthesize` level zero bit for bit, so decoders can
/// rebuild every bin from `(time, value)` alone.
fn is_sample_level(level: &BinLevel) -> bool {
    let value = level.first_column();
    (0..level.len()).all(|index| {
        let v = value[index];
        let same = |column: &[f64], expected: f64| column[index].to_bits() == expected.to_bits();
        let finite = v.is_finite();
        let (sum, sum_sq) = if finite { (v, v * v) } else { (0.0, 0.0) };
        same(level.t1_column(), level.t0_column()[index])
            && level.sample_count_column()[index] == 1
            && level.finite_count_column()[index] == u32::from(finite)
            && level.flags_column()[index] == if finite { SAMPLE_FLAGS } else { HAS_GAP }
            && same(level.sum_column(), sum)
            && same(level.sum_sq_column(), sum_sq)
            && (!finite
                || (same(level.last_column(), v)
                    && same(level.min_column(), v)
                    && same(level.max_column(), v)))
    })
}

#[cfg(test)]
pub mod decode {
    //! Reference decoder used by tests; the browser decoder follows the same
    //! rules.

    use base64::{Engine, engine::general_purpose::STANDARD};
    use flate2::read::DeflateDecoder;
    use scope_protocol::{BakedLevel, BakedLevelEncoding, EnvelopeBin, SnapshotManifest};
    use std::io::Read;

    use crate::bins::{HAS_FIRST, HAS_GAP, HAS_LAST, HAS_MAX, HAS_MIN};

    pub struct Decoded {
        /// Byte offset and element count per column.
        columns: Vec<(usize, usize)>,
        bytes: Vec<u8>,
    }

    impl Decoded {
        pub fn new(manifest: &SnapshotManifest) -> Self {
            let compressed = STANDARD.decode(&manifest.payload).unwrap();
            let mut bytes = Vec::new();
            DeflateDecoder::new(compressed.as_slice())
                .read_to_end(&mut bytes)
                .unwrap();
            let read_u32 = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let count = read_u32(bytes.len() - 4) as usize;
            let kinds_at = bytes.len() - 4 - count * 5;
            let mut offset = 0;
            let columns = (0..count)
                .map(|index| {
                    let width = [8, 4, 1][usize::from(bytes[kinds_at + index])];
                    let len = read_u32(kinds_at + count + index * 4) as usize;
                    let column = (offset, len);
                    offset += len * width;
                    column
                })
                .collect();
            bytes.truncate(kinds_at);
            Self { columns, bytes }
        }

        pub fn column_count(&self) -> usize {
            self.columns.len()
        }

        pub fn data_len(&self) -> usize {
            self.bytes.len()
        }

        fn raw(&self, index: u32, width: usize) -> Vec<u8> {
            let (offset, count) = self.columns[index as usize];
            let data = &self.bytes[offset..][..count * width];
            let mut bytes = vec![0; data.len()];
            for element in 0..count {
                for byte in 0..width {
                    bytes[element * width + byte] = data[byte * count + element];
                }
            }
            bytes
        }

        pub fn f64s(&self, index: u32) -> Vec<f64> {
            self.raw(index, 8)
                .chunks_exact(8)
                .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
                .collect()
        }

        fn u32s(&self, index: u32) -> Vec<u32> {
            self.raw(index, 4)
                .chunks_exact(4)
                .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
                .collect()
        }

        pub fn optional_f64s(&self, index: u32) -> Vec<Option<f64>> {
            self.f64s(index)
                .into_iter()
                .map(|value| value.is_finite().then_some(value))
                .collect()
        }

        pub fn bins(&self, level: &BakedLevel) -> Vec<EnvelopeBin> {
            let c = &level.columns;
            if level.encoding == BakedLevelEncoding::Samples {
                let time = self.f64s(c[0]);
                return self
                    .f64s(c[1])
                    .into_iter()
                    .zip(time)
                    .map(|(v, t)| {
                        let finite = v.is_finite();
                        let some = finite.then_some(v);
                        EnvelopeBin {
                            t0: t,
                            t1: t,
                            first: some,
                            last: some,
                            min: some,
                            max: some,
                            sum: if finite { v } else { 0.0 },
                            sum_sq: if finite { v * v } else { 0.0 },
                            finite_count: u64::from(finite),
                            sample_count: 1,
                            has_gap: !finite,
                        }
                    })
                    .collect();
            }
            let f = |i: usize| self.f64s(c[i]);
            let (t0, t1, first, last, min, max, sum, sum_sq) =
                (f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7));
            let (samples, finite) = (self.u32s(c[8]), self.u32s(c[9]));
            let flags = self.raw(c[10], 1);
            (0..t0.len())
                .map(|i| {
                    let opt = |values: &[f64], bit: u8| (flags[i] & bit != 0).then_some(values[i]);
                    EnvelopeBin {
                        t0: t0[i],
                        t1: t1[i],
                        first: opt(&first, HAS_FIRST),
                        last: opt(&last, HAS_LAST),
                        min: opt(&min, HAS_MIN),
                        max: opt(&max, HAS_MAX),
                        sum: sum[i],
                        sum_sq: sum_sq[i],
                        finite_count: u64::from(finite[i]),
                        sample_count: u64::from(samples[i]),
                        has_gap: flags[i] & HAS_GAP != 0,
                    }
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use scope_protocol::{BakedLevelEncoding, EnvelopeBin, SnapshotManifest};

    use super::{PayloadWriter, decode::Decoded};
    use crate::bins::BinLevel;

    fn manifest(writer: PayloadWriter) -> SnapshotManifest {
        SnapshotManifest {
            session_json: String::new(),
            preferences_json: None,
            payload: writer.finish().unwrap(),
            signals: Vec::new(),
            line2d: None,
            histograms: None,
        }
    }

    fn sample(t: f64, v: f64) -> EnvelopeBin {
        let finite = v.is_finite();
        EnvelopeBin {
            t0: t,
            t1: t,
            first: finite.then_some(v),
            last: finite.then_some(v),
            min: finite.then_some(v),
            max: finite.then_some(v),
            sum: if finite { v } else { 0.0 },
            sum_sq: if finite { v * v } else { 0.0 },
            finite_count: u64::from(finite),
            sample_count: 1,
            has_gap: !finite,
        }
    }

    #[test]
    fn sample_levels_store_two_columns_and_round_trip_exactly() {
        let wire = [
            sample(0.0, 1.5),
            sample(0.1, f64::NAN),
            sample(0.2, -0.0),
            sample(0.3, f64::INFINITY),
            sample(0.4, 1e300),
        ];
        let mut writer = PayloadWriter::new();
        let level = writer.level(&BinLevel::from_wire(&wire)).unwrap();
        assert_eq!(level.encoding, BakedLevelEncoding::Samples);
        assert_eq!(level.columns.len(), 2);
        let decoded = Decoded::new(&manifest(writer));
        let bins = decoded.bins(&level);
        assert_eq!(bins.len(), wire.len());
        for (actual, expected) in bins.iter().zip(&wire) {
            assert_eq!(actual.sum.to_bits(), expected.sum.to_bits());
            assert_eq!(actual.sum_sq.to_bits(), expected.sum_sq.to_bits());
        }
        assert_eq!(bins, wire);
    }

    #[test]
    fn merged_levels_keep_every_bin_column() {
        let wire = [
            EnvelopeBin {
                t0: 0.0,
                t1: 1.0,
                first: Some(2.0),
                last: None,
                min: Some(-1.0),
                max: Some(2.0),
                sum: 1.0,
                sum_sq: 5.0,
                finite_count: 2,
                sample_count: 3,
                has_gap: true,
            },
            sample(2.0, 4.0),
        ];
        let mut writer = PayloadWriter::new();
        let level = writer.level(&BinLevel::from_wire(&wire)).unwrap();
        assert_eq!(level.encoding, BakedLevelEncoding::Bins);
        assert_eq!(Decoded::new(&manifest(writer)).bins(&level), wire);
    }

    #[test]
    fn identical_columns_are_stored_once() {
        let mut writer = PayloadWriter::new();
        let time = [0.0, 1.0, 2.0];
        let a = writer.f64_column(&time).unwrap();
        let b = writer.f64_column(&[5.0, 6.0, 7.0]).unwrap();
        let c = writer.f64_column(&time).unwrap();
        assert_eq!(a, c);
        assert_ne!(a, b);
        let decoded = Decoded::new(&manifest(writer));
        assert_eq!(decoded.column_count(), 2);
        assert_eq!(decoded.data_len(), 48);
        assert_eq!(decoded.f64s(b), vec![5.0, 6.0, 7.0]);
    }

    #[test]
    fn finite_columns_store_non_finite_values_as_nan() {
        let mut writer = PayloadWriter::new();
        let index = writer
            .finite_f64_column(&[1.0, f64::INFINITY, -2.0])
            .unwrap();
        assert_eq!(
            Decoded::new(&manifest(writer)).optional_f64s(index),
            vec![Some(1.0), None, Some(-2.0)]
        );
    }

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/snapshot-payload-conformance.json"
    );

    /// Rust-encoded snapshot plus the JSON-era bins it must decode to; the
    /// browser decoder test reads the same file.
    #[derive(serde::Deserialize, serde::Serialize)]
    struct Fixture {
        snapshot: scope_protocol::Envelope<SnapshotManifest>,
        levels: Vec<Vec<EnvelopeBin>>,
        line_x: Vec<Option<f64>>,
        line_y: Vec<Option<f64>>,
    }

    fn fixture() -> Fixture {
        let time: Vec<f64> = (0..40).map(|index| f64::from(index) * 0.25).collect();
        let values: Vec<f64> = time
            .iter()
            .enumerate()
            .map(|(index, time)| match index {
                7..=9 => f64::NAN,
                20 => f64::INFINITY,
                _ => (time * 1.7).sin() * 3.0 + 0.1,
            })
            .collect();
        let doubled: Vec<f64> = values.iter().map(|value| value * 2.0).collect();
        let pyramid = crate::pyramid::Pyramid::from_samples(&time, &values);
        let mut writer = PayloadWriter::new();
        let levels = (0..pyramid.level_count())
            .map(|index| {
                writer
                    .level(&pyramid.level_window(index, None).unwrap())
                    .unwrap()
            })
            .collect();
        let line = scope_protocol::BakedLine2DLevel {
            level: 0,
            anchor: writer.f64_column(&time).unwrap(),
            x: writer.finite_f64_column(&values).unwrap(),
            ys: vec![writer.finite_f64_column(&doubled).unwrap()],
        };
        let mut manifest = manifest(writer);
        manifest.session_json = "{}".to_owned();
        manifest.signals = vec![scope_protocol::BakedSignal {
            summary: scope_protocol::SignalSummary {
                signal_id: 1,
                source_id: 1,
                source_key: "00000000-0000-0000-0000-000000000001".to_owned(),
                local_path: "response".to_owned(),
                path: "run/response".to_owned(),
                unit: Some("V".to_owned()),
                point_count: 40,
                t_min: 0.0,
                t_max: 9.75,
                last_value: values.last().copied(),
            },
            levels,
        }];
        manifest.line2d = Some(vec![scope_protocol::BakedLine2D {
            x_signal_id: 1,
            y_signal_ids: vec![1],
            levels: vec![line],
        }]);
        let finite = |values: &[f64]| {
            values
                .iter()
                .map(|value| value.is_finite().then_some(*value))
                .collect()
        };
        Fixture {
            snapshot: scope_protocol::Envelope::new(manifest),
            levels: (0..pyramid.level_count())
                .map(|index| pyramid.level(index).unwrap())
                .collect(),
            line_x: finite(&values),
            line_y: finite(&doubled),
        }
    }

    #[test]
    fn snapshot_payload_conformance_fixture() {
        let current = fixture();
        let decoded = Decoded::new(&current.snapshot.payload);
        for (level, expected) in current.snapshot.payload.signals[0]
            .levels
            .iter()
            .zip(&current.levels)
        {
            assert_eq!(&decoded.bins(level), expected);
        }
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            let text = serde_json::to_string_pretty(&current).unwrap() + "\n";
            std::fs::write(FIXTURE_PATH, text).unwrap();
            return;
        }
        // serde_json float parsing may differ by an ULP, so compare the encoded
        // bytes and column references; every expected value derives from them.
        let stored: Fixture = serde_json::from_str(
            &std::fs::read_to_string(FIXTURE_PATH)
                .expect("fixture exists; regenerate with REGENERATE_FIXTURES=1"),
        )
        .unwrap();
        let (stored, current) = (&stored.snapshot.payload, &current.snapshot.payload);
        assert_eq!(stored.payload, current.payload);
        assert_eq!(stored.signals[0].levels, current.signals[0].levels);
        assert_eq!(stored.line2d, current.line2d);
    }

    #[test]
    fn payload_bytes_are_deterministic() {
        let build = || {
            let mut writer = PayloadWriter::new();
            writer.f64_column(&[1.0, 2.0, 3.0]).unwrap();
            writer
                .level(&BinLevel::from_wire(&[sample(0.0, 1.0)]))
                .unwrap();
            writer.finish().unwrap()
        };
        assert_eq!(build(), build());
    }
}
