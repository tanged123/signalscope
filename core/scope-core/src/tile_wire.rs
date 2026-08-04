use crate::bins::BinLevel;
use scope_protocol::tile_binary::BinaryTileSeries;

#[must_use]
pub fn binary_series<'a>(
    signal_id: u64,
    path: &'a str,
    unit: Option<&'a str>,
    level: u32,
    bins: &'a BinLevel,
) -> BinaryTileSeries<'a> {
    BinaryTileSeries {
        signal_id,
        signal_path: path,
        unit,
        level,
        bin_count: bins.len(),
        t0: bins.t0_column(),
        t1: bins.t1_column(),
        first: bins.first_column(),
        last: bins.last_column(),
        min: bins.min_column(),
        max: bins.max_column(),
        sum: bins.sum_column(),
        sum_sq: bins.sum_sq_column(),
        sample_count: bins.sample_count_column(),
        finite_count: bins.finite_count_column(),
        flags: bins.flags_column(),
    }
}

#[cfg(test)]
mod tests {
    use scope_protocol::tile_binary::{decode_tile_response, encode_tile_response};

    use super::*;

    #[test]
    fn tile_binary_series_round_trips_bin_level() {
        let bins = BinLevel::from_wire(&[
            scope_protocol::EnvelopeBin {
                t0: 0.0,
                t1: 1.0,
                first: Some(2.0),
                last: None,
                min: Some(2.0),
                max: Some(2.0),
                sum: 2.0,
                sum_sq: 4.0,
                finite_count: 1,
                sample_count: 2,
                has_gap: true,
            },
            scope_protocol::EnvelopeBin {
                t0: 2.0,
                t1: 2.0,
                first: None,
                last: None,
                min: None,
                max: None,
                sum: 0.0,
                sum_sq: 0.0,
                finite_count: 0,
                sample_count: 1,
                has_gap: true,
            },
        ]);
        let wire = binary_series(7, "run/response", Some("V"), 3, &bins);
        let decoded = decode_tile_response(&encode_tile_response(&[wire])).expect("decode");
        assert_eq!(decoded[0].signal_id, 7);
        assert_eq!(decoded[0].signal_path, "run/response");
        assert_eq!(decoded[0].unit.as_deref(), Some("V"));
        assert_eq!(decoded[0].level, 3);
        assert_eq!(decoded[0].t0, bins.t0_column());
        assert_eq!(decoded[0].t1, bins.t1_column());
        assert_eq!(decoded[0].sample_count, bins.sample_count_column());
        assert_eq!(decoded[0].finite_count, bins.finite_count_column());
        assert_eq!(decoded[0].flags, bins.flags_column());
        assert_eq!(decoded[0].t0.len(), bins.len());
        assert_eq!(decoded[0].first[1].to_bits(), f64::NAN.to_bits());
        assert_eq!(decoded[0].flags, bins.flags_column());
    }
}

#[cfg(test)]
mod fixture_tests {
    use serde::{Deserialize, Serialize};

    const BINARY_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/tile-binary-conformance.bin"
    );
    const JSON_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/tile-binary-conformance.json"
    );

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct Fixture {
        request_id: String,
        series: Vec<scope_protocol::SignalTile>,
    }

    fn fixture_data() -> (
        Vec<scope_protocol::tile_binary::OwnedBinarySeries>,
        Fixture,
        Vec<u8>,
    ) {
        let time: Vec<f64> = (0..500).map(f64::from).collect();
        let values: Vec<f64> = time
            .iter()
            .enumerate()
            .map(|(index, time)| {
                if (97..=103).contains(&index) {
                    f64::NAN
                } else {
                    (time * 1.3).sin() * 10.0 + time * 0.5
                }
            })
            .collect();
        let pyramid = crate::pyramid::Pyramid::from_samples(&time, &values);
        let windows = [(0.0, 499.0, 400_u32), (0.0, 499.0, 100), (90.0, 120.0, 64)];
        let queries: Vec<_> = windows
            .iter()
            .map(|&(t0, t1, pixel_width)| pyramid.query(t0, t1, pixel_width))
            .collect();
        let series: Vec<_> = queries
            .iter()
            .enumerate()
            .map(|(index, query)| {
                crate::tile_wire::binary_series(
                    u64::try_from(index + 1).expect("fixture id"),
                    "run/response",
                    Some("V"),
                    query.level,
                    &query.bins,
                )
            })
            .collect();
        let bytes = scope_protocol::tile_binary::encode_tile_response(&series);
        let expected = Fixture {
            request_id: "tile-binary-fixture".into(),
            series: queries
                .iter()
                .enumerate()
                .map(|(index, query)| scope_protocol::SignalTile {
                    signal_id: u64::try_from(index + 1).expect("fixture id"),
                    signal_path: "run/response".into(),
                    unit: Some("V".into()),
                    level: query.level,
                    bins: query.bins.to_wire_vec(),
                })
                .collect(),
        };
        let decoded = scope_protocol::tile_binary::decode_tile_response(&bytes)
            .expect("fixture encoding decodes");
        (decoded, expected, bytes)
    }

    #[test]
    fn tile_binary_conformance_fixture() {
        let (current_binary, current_json, bytes) = fixture_data();
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(BINARY_FIXTURE_PATH, bytes).expect("binary fixture written");
            std::fs::write(
                JSON_FIXTURE_PATH,
                serde_json::to_string_pretty(&current_json).expect("json fixture serializes"),
            )
            .expect("json fixture written");
            return;
        }
        let binary = std::fs::read(BINARY_FIXTURE_PATH)
            .expect("fixture exists; regenerate with REGENERATE_FIXTURES=1");
        assert_eq!(binary, bytes);
        let stored_binary = scope_protocol::tile_binary::decode_tile_response(&binary)
            .expect("stored binary fixture decodes");
        assert_owned_series_equal(&stored_binary, &current_binary);
        let json_text = std::fs::read_to_string(JSON_FIXTURE_PATH)
            .expect("json fixture exists; regenerate with REGENERATE_FIXTURES=1");
        let stored_json: Fixture = serde_json::from_str(&json_text).expect("json fixture parses");
        assert_eq!(stored_json.request_id, current_json.request_id);
        assert_eq!(stored_json.series.len(), current_json.series.len());
        for (index, (stored, current)) in stored_json
            .series
            .iter()
            .zip(&current_json.series)
            .enumerate()
        {
            assert_eq!(stored.signal_id, current.signal_id, "series {index}");
            assert_eq!(stored.signal_path, current.signal_path, "series {index}");
            assert_eq!(stored.unit, current.unit, "series {index}");
            assert_eq!(stored.level, current.level, "series {index}");
            assert_eq!(stored.bins.len(), current.bins.len(), "series {index}");
            for (bin_index, (stored_bin, current_bin)) in
                stored.bins.iter().zip(&current.bins).enumerate()
            {
                assert_close(stored_bin.t0, current_bin.t0, index, bin_index);
                assert_close(stored_bin.t1, current_bin.t1, index, bin_index);
                assert_option_close(stored_bin.first, current_bin.first, index, bin_index);
                assert_option_close(stored_bin.last, current_bin.last, index, bin_index);
                assert_option_close(stored_bin.min, current_bin.min, index, bin_index);
                assert_option_close(stored_bin.max, current_bin.max, index, bin_index);
                assert_close(stored_bin.sum, current_bin.sum, index, bin_index);
                assert_close(stored_bin.sum_sq, current_bin.sum_sq, index, bin_index);
                assert_eq!(stored_bin.finite_count, current_bin.finite_count);
                assert_eq!(stored_bin.sample_count, current_bin.sample_count);
                assert_eq!(stored_bin.has_gap, current_bin.has_gap);
            }
        }
    }

    fn assert_option_close(stored: Option<f64>, current: Option<f64>, series: usize, bin: usize) {
        match (stored, current) {
            (Some(stored), Some(current)) => assert_close(stored, current, series, bin),
            (None, None) => {}
            (stored, current) => panic!("series {series} bin {bin}: {stored:?} != {current:?}"),
        }
    }

    fn assert_close(stored: f64, current: f64, series: usize, bin: usize) {
        let tolerance = stored.abs().max(current.abs()).max(1.0) * 1e-12;
        assert!(
            (stored - current).abs() <= tolerance,
            "series {series} bin {bin}: {stored:?} != {current:?}"
        );
    }

    fn assert_owned_series_equal(
        actual: &[scope_protocol::tile_binary::OwnedBinarySeries],
        expected: &[scope_protocol::tile_binary::OwnedBinarySeries],
    ) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.signal_id, expected.signal_id);
            assert_eq!(actual.signal_path, expected.signal_path);
            assert_eq!(actual.unit, expected.unit);
            assert_eq!(actual.level, expected.level);
            assert_eq!(actual.bin_count, expected.bin_count);
            assert_f64s(&actual.t0, &expected.t0);
            assert_f64s(&actual.t1, &expected.t1);
            assert_f64s(&actual.first, &expected.first);
            assert_f64s(&actual.last, &expected.last);
            assert_f64s(&actual.min, &expected.min);
            assert_f64s(&actual.max, &expected.max);
            assert_f64s(&actual.sum, &expected.sum);
            assert_f64s(&actual.sum_sq, &expected.sum_sq);
            assert_eq!(actual.sample_count, expected.sample_count);
            assert_eq!(actual.finite_count, expected.finite_count);
            assert_eq!(actual.flags, expected.flags);
        }
    }

    fn assert_f64s(actual: &[f64], expected: &[f64]) {
        assert_eq!(
            actual
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>()
        );
    }
}
