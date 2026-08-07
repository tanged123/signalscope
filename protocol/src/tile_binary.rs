use thiserror::Error;

pub const TILE_BINARY_MAGIC: u32 = 0x4254_5353;
pub const HAS_FIRST: u8 = 1 << 0;
pub const HAS_LAST: u8 = 1 << 1;
pub const HAS_MIN: u8 = 1 << 2;
pub const HAS_MAX: u8 = 1 << 3;
pub const HAS_GAP: u8 = 1 << 4;
pub const BREAK_BEFORE: u32 = 1;

#[derive(Debug, Error, PartialEq)]
pub enum TileBinaryError {
    #[error("invalid tile binary magic: {actual:#x}")]
    BadMagic { actual: u32 },
    #[error("unsupported tile binary protocol version {actual}; expected {expected}")]
    Version { expected: u32, actual: u32 },
    #[error("truncated tile binary payload")]
    Truncated,
    #[error("malformed tile binary payload: {0}")]
    Malformed(&'static str),
}

pub struct BinaryTileSeries<'a> {
    pub signal_id: u64,
    pub signal_path: &'a str,
    pub unit: Option<&'a str>,
    pub level: u32,
    pub source_start: u64,
    pub source_end: u64,
    pub origin: f64,
    pub bin_count: usize,
    pub t0: &'a [f64],
    pub t1: &'a [f64],
    pub first: &'a [f64],
    pub last: &'a [f64],
    pub min: &'a [f64],
    pub max: &'a [f64],
    pub sum: &'a [f64],
    pub sum_sq: &'a [f64],
    pub sample_count: &'a [u32],
    pub finite_count: &'a [u32],
    pub flags: &'a [u8],
    pub points: &'a [crate::TilePoint],
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnedBinaryPoint {
    pub time_offset: f32,
    pub value: f32,
    pub flags: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnedBinarySeries {
    pub signal_id: u64,
    pub signal_path: String,
    pub unit: Option<String>,
    pub level: u32,
    pub source_start: u64,
    pub source_end: u64,
    pub origin: f64,
    pub bin_count: usize,
    pub t0: Vec<f64>,
    pub t1: Vec<f64>,
    pub first: Vec<f64>,
    pub last: Vec<f64>,
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub sum: Vec<f64>,
    pub sum_sq: Vec<f64>,
    pub sample_count: Vec<u32>,
    pub finite_count: Vec<u32>,
    pub flags: Vec<u8>,
    pub points: Vec<OwnedBinaryPoint>,
}

#[must_use]
/// Encodes a set of columnar tile series into the native tile framing.
///
/// # Panics
///
/// Panics when a series count, bin count, path, unit, or column length cannot
/// be represented by the binary framing fields.
#[allow(clippy::cast_possible_truncation)]
pub fn encode_tile_response(series: &[BinaryTileSeries<'_>]) -> Vec<u8> {
    let capacity = 16 + series.iter().map(series_bytes).sum::<usize>();
    let mut bytes = Vec::with_capacity(capacity);
    put_u32(&mut bytes, TILE_BINARY_MAGIC);
    put_u32(&mut bytes, crate::PROTOCOL_VERSION);
    put_u32(
        &mut bytes,
        u32::try_from(series.len()).expect("series count fits in u32"),
    );
    put_u32(&mut bytes, 0);

    for item in series {
        validate_series(item);
        put_u64(&mut bytes, item.signal_id);
        put_u32(&mut bytes, item.level);
        put_u32(
            &mut bytes,
            u32::try_from(item.bin_count).expect("bin count fits in u32"),
        );
        put_u32(
            &mut bytes,
            u32::try_from(item.points.len()).expect("point count fits in u32"),
        );
        put_u16(
            &mut bytes,
            u16::try_from(item.signal_path.len()).expect("signal path fits in u16"),
        );
        put_u16(
            &mut bytes,
            item.unit.map_or(u16::MAX, |unit| {
                u16::try_from(unit.len()).expect("unit fits in u16")
            }),
        );
        put_u64(&mut bytes, item.source_start);
        put_u64(&mut bytes, item.source_end);
        put_f64(&mut bytes, item.origin);
        bytes.extend_from_slice(item.signal_path.as_bytes());
        if let Some(unit) = item.unit {
            bytes.extend_from_slice(unit.as_bytes());
        }
        bytes.resize(align8(bytes.len()), 0);

        append_f64_column(&mut bytes, item.t0, None);
        append_f64_column(&mut bytes, item.t1, None);
        append_f64_column(&mut bytes, item.first, Some((item.flags, HAS_FIRST)));
        append_f64_column(&mut bytes, item.last, Some((item.flags, HAS_LAST)));
        append_f64_column(&mut bytes, item.min, Some((item.flags, HAS_MIN)));
        append_f64_column(&mut bytes, item.max, Some((item.flags, HAS_MAX)));
        append_f64_column(&mut bytes, item.sum, None);
        append_f64_column(&mut bytes, item.sum_sq, None);
        for value in item.sample_count {
            put_u32(&mut bytes, *value);
        }
        for value in item.finite_count {
            put_u32(&mut bytes, *value);
        }
        bytes.extend_from_slice(item.flags);
        bytes.resize(align8(bytes.len()), 0);
        for point in item.points {
            let offset = (point.time - item.origin) as f32;
            let value = point.value as f32;
            assert!(
                point.time.is_finite()
                    && point.value.is_finite()
                    && offset.is_finite()
                    && value.is_finite(),
                "tile point is not representable as finite f32"
            );
            bytes.extend_from_slice(&offset.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
            put_u32(
                &mut bytes,
                if point.break_before { BREAK_BEFORE } else { 0 },
            );
            put_u32(&mut bytes, 0);
        }
        bytes.resize(align8(bytes.len()), 0);
    }
    debug_assert_eq!(bytes.len(), capacity);
    bytes
}

/// Decodes a native columnar tile response.
///
/// # Errors
///
/// Returns a [`TileBinaryError`] when the header, series metadata, columns, or
/// padding is malformed or truncated.
#[allow(clippy::too_many_lines)]
pub fn decode_tile_response(bytes: &[u8]) -> Result<Vec<OwnedBinarySeries>, TileBinaryError> {
    if bytes.len() < 16 {
        return Err(TileBinaryError::Truncated);
    }
    let mut at = 0;
    let magic = read_u32(bytes, &mut at)?;
    if magic != TILE_BINARY_MAGIC {
        return Err(TileBinaryError::BadMagic { actual: magic });
    }
    let version = read_u32(bytes, &mut at)?;
    if version != crate::PROTOCOL_VERSION {
        return Err(TileBinaryError::Version {
            expected: crate::PROTOCOL_VERSION,
            actual: version,
        });
    }
    let series_count = usize::try_from(read_u32(bytes, &mut at)?)
        .map_err(|_| TileBinaryError::Malformed("series count overflow"))?;
    if series_count > (bytes.len() - 16) / 48 {
        return Err(TileBinaryError::Malformed("series count exceeds payload"));
    }
    if read_u32(bytes, &mut at)? != 0 {
        return Err(TileBinaryError::Malformed("reserved header is nonzero"));
    }

    let mut decoded = Vec::with_capacity(series_count);
    for _ in 0..series_count {
        let signal_id = read_u64(bytes, &mut at)?;
        let level = read_u32(bytes, &mut at)?;
        let bin_count = usize::try_from(read_u32(bytes, &mut at)?)
            .map_err(|_| TileBinaryError::Malformed("bin count overflow"))?;
        let point_count = usize::try_from(read_u32(bytes, &mut at)?)
            .map_err(|_| TileBinaryError::Malformed("point count overflow"))?;
        let path_len = usize::from(read_u16(bytes, &mut at)?);
        let unit_len = read_u16(bytes, &mut at)?;
        let source_start = read_u64(bytes, &mut at)?;
        let source_end = read_u64(bytes, &mut at)?;
        let origin = read_f64(bytes, &mut at)?;
        if source_start > source_end || !origin.is_finite() {
            return Err(TileBinaryError::Malformed("invalid tile source range"));
        }
        let path = String::from_utf8(take(bytes, &mut at, path_len)?.to_vec())
            .map_err(|_| TileBinaryError::Malformed("signal path is not utf8"))?;
        let unit = if unit_len == u16::MAX {
            None
        } else {
            Some(
                String::from_utf8(take(bytes, &mut at, usize::from(unit_len))?.to_vec())
                    .map_err(|_| TileBinaryError::Malformed("unit is not utf8"))?,
            )
        };
        at = align8(at);

        let t0 = read_f64s(bytes, &mut at, bin_count)?;
        let t1 = read_f64s(bytes, &mut at, bin_count)?;
        let first = read_f64s(bytes, &mut at, bin_count)?;
        let last = read_f64s(bytes, &mut at, bin_count)?;
        let min = read_f64s(bytes, &mut at, bin_count)?;
        let max = read_f64s(bytes, &mut at, bin_count)?;
        let sum = read_f64s(bytes, &mut at, bin_count)?;
        let sum_sq = read_f64s(bytes, &mut at, bin_count)?;
        let sample_count = read_u32s(bytes, &mut at, bin_count)?;
        let finite_count = read_u32s(bytes, &mut at, bin_count)?;
        let flags = take(bytes, &mut at, bin_count)?.to_vec();
        if flags
            .iter()
            .any(|flags| *flags & !(HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX | HAS_GAP) != 0)
        {
            return Err(TileBinaryError::Malformed("unknown bin flags"));
        }
        at = align8(at);
        let points = (0..point_count)
            .map(|_| {
                let time_offset = read_f32(bytes, &mut at)?;
                let value = read_f32(bytes, &mut at)?;
                if !time_offset.is_finite() || !value.is_finite() {
                    return Err(TileBinaryError::Malformed("non-finite tile point data"));
                }
                let flags = read_u32(bytes, &mut at)?;
                if flags & !BREAK_BEFORE != 0 {
                    return Err(TileBinaryError::Malformed("unknown point flags"));
                }
                if read_u32(bytes, &mut at)? != 0 {
                    return Err(TileBinaryError::Malformed("nonzero point reserved word"));
                }
                Ok(OwnedBinaryPoint {
                    time_offset,
                    value,
                    flags,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        at = align8(at);
        decoded.push(OwnedBinarySeries {
            signal_id,
            signal_path: path,
            unit,
            level,
            source_start,
            source_end,
            origin,
            bin_count,
            t0,
            t1,
            first,
            last,
            min,
            max,
            sum,
            sum_sq,
            sample_count,
            finite_count,
            flags,
            points,
        });
    }
    if at != bytes.len() {
        return Err(TileBinaryError::Malformed("trailing bytes"));
    }
    Ok(decoded)
}

fn series_bytes(series: &BinaryTileSeries<'_>) -> usize {
    validate_series(series);
    48 + align8(series.signal_path.len() + series.unit.map_or(0, str::len))
        + align8(series.bin_count * 73)
        + align8(series.points.len() * 16)
}

fn validate_series(series: &BinaryTileSeries<'_>) {
    assert!(u16::try_from(series.signal_path.len()).is_ok());
    assert!(
        series
            .unit
            .is_none_or(|unit| u16::try_from(unit.len()).is_ok())
    );
    assert_eq!(series.bin_count, series.t0.len());
    assert_eq!(series.bin_count, series.t1.len());
    assert_eq!(series.bin_count, series.first.len());
    assert_eq!(series.bin_count, series.last.len());
    assert_eq!(series.bin_count, series.min.len());
    assert_eq!(series.bin_count, series.max.len());
    assert_eq!(series.bin_count, series.sum.len());
    assert_eq!(series.bin_count, series.sum_sq.len());
    assert_eq!(series.bin_count, series.sample_count.len());
    assert_eq!(series.bin_count, series.finite_count.len());
    assert_eq!(series.bin_count, series.flags.len());
    assert!(series.source_start <= series.source_end);
    assert!(series.origin.is_finite());
    assert_eq!(series.bin_count, series.t0.len());
}

fn append_f64_column(bytes: &mut Vec<u8>, values: &[f64], optional: Option<(&[u8], u8)>) {
    for (index, value) in values.iter().copied().enumerate() {
        let value = optional
            .filter(|(flags, flag)| flags[index] & *flag == 0)
            .map_or(value, |_| f64::NAN);
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

fn put_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn put_f64(bytes: &mut Vec<u8>, value: f64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn align8(value: usize) -> usize {
    value.checked_add(7).expect("tile payload size overflow") & !7
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], TileBinaryError> {
    let end = at
        .checked_add(len)
        .ok_or(TileBinaryError::Malformed("offset overflow"))?;
    let output = bytes.get(*at..end).ok_or(TileBinaryError::Truncated)?;
    *at = end;
    Ok(output)
}

fn read_u16(bytes: &[u8], at: &mut usize) -> Result<u16, TileBinaryError> {
    Ok(u16::from_le_bytes(
        take(bytes, at, 2)?.try_into().expect("length checked"),
    ))
}

fn read_u32(bytes: &[u8], at: &mut usize) -> Result<u32, TileBinaryError> {
    Ok(u32::from_le_bytes(
        take(bytes, at, 4)?.try_into().expect("length checked"),
    ))
}

fn read_u64(bytes: &[u8], at: &mut usize) -> Result<u64, TileBinaryError> {
    Ok(u64::from_le_bytes(
        take(bytes, at, 8)?.try_into().expect("length checked"),
    ))
}

fn read_f32(bytes: &[u8], at: &mut usize) -> Result<f32, TileBinaryError> {
    Ok(f32::from_le_bytes(
        take(bytes, at, 4)?.try_into().expect("length checked"),
    ))
}

fn read_f64(bytes: &[u8], at: &mut usize) -> Result<f64, TileBinaryError> {
    Ok(f64::from_le_bytes(
        take(bytes, at, 8)?.try_into().expect("length checked"),
    ))
}

fn read_f64s(bytes: &[u8], at: &mut usize, count: usize) -> Result<Vec<f64>, TileBinaryError> {
    take(
        bytes,
        at,
        count
            .checked_mul(8)
            .ok_or(TileBinaryError::Malformed("column size overflow"))?,
    )?
    .chunks_exact(8)
    .map(|chunk| {
        Ok(f64::from_le_bytes(
            chunk.try_into().expect("length checked"),
        ))
    })
    .collect()
}

fn read_u32s(bytes: &[u8], at: &mut usize, count: usize) -> Result<Vec<u32>, TileBinaryError> {
    take(
        bytes,
        at,
        count
            .checked_mul(4)
            .ok_or(TileBinaryError::Malformed("column size overflow"))?,
    )?
    .chunks_exact(4)
    .map(|chunk| {
        Ok(u32::from_le_bytes(
            chunk.try_into().expect("length checked"),
        ))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series() -> [BinaryTileSeries<'static>; 2] {
        [
            BinaryTileSeries {
                signal_id: 9_007_199_254_740_993,
                signal_path: "run/response",
                unit: None,
                level: 3,
                source_start: 0,
                source_end: 3,
                origin: 0.0,
                bin_count: 3,
                t0: &[0.0, 1.0, 2.0],
                t1: &[0.5, 1.5, 2.5],
                first: &[1.0, f64::NAN, 3.0],
                last: &[1.0, f64::NAN, f64::NAN],
                min: &[1.0, f64::NAN, f64::NAN],
                max: &[1.0, f64::NAN, f64::NAN],
                sum: &[1.0, 0.0, 3.0],
                sum_sq: &[1.0, 0.0, 9.0],
                sample_count: &[1, 2, 1],
                finite_count: &[1, 0, 1],
                flags: &[HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX, HAS_GAP, HAS_FIRST],
                points: &[],
            },
            BinaryTileSeries {
                signal_id: 4,
                signal_path: "temperature",
                unit: Some("degC"),
                level: 0,
                source_start: 4,
                source_end: 5,
                origin: 4.0,
                bin_count: 1,
                t0: &[4.0],
                t1: &[4.0],
                first: &[4.0],
                last: &[4.0],
                min: &[4.0],
                max: &[4.0],
                sum: &[4.0],
                sum_sq: &[16.0],
                sample_count: &[1],
                finite_count: &[1],
                flags: &[HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX],
                points: &[],
            },
        ]
    }

    #[allow(clippy::float_cmp)]
    #[test]
    fn round_trip_preserves_series_and_aligns_float_columns() {
        let series = series();
        let bytes = encode_tile_response(&series);
        let decoded = decode_tile_response(&bytes).expect("decode");
        assert_eq!(decoded.len(), series.len());
        for (actual, expected) in decoded.iter().zip(series.iter()) {
            assert_eq!(actual.signal_id, expected.signal_id);
            assert_eq!(actual.signal_path, expected.signal_path);
            assert_eq!(actual.unit.as_deref(), expected.unit);
            assert_eq!(actual.level, expected.level);
            assert_eq!(actual.source_start, expected.source_start);
            assert_eq!(actual.source_end, expected.source_end);
            assert_eq!(actual.origin, expected.origin);
            assert!(actual.points.is_empty());
            assert_f64s(&actual.t0, expected.t0);
            assert_f64s(&actual.t1, expected.t1);
            assert_f64s(&actual.first, expected.first);
            assert_f64s(&actual.last, expected.last);
            assert_f64s(&actual.min, expected.min);
            assert_f64s(&actual.max, expected.max);
            assert_f64s(&actual.sum, expected.sum);
            assert_f64s(&actual.sum_sq, expected.sum_sq);
            assert_eq!(actual.sample_count, expected.sample_count);
            assert_eq!(actual.finite_count, expected.finite_count);
            assert_eq!(actual.flags, expected.flags);
        }

        let mut at = 16;
        for expected in &series {
            at += 48;
            at = align8(at + expected.signal_path.len() + expected.unit.map_or(0, str::len));
            for _ in 0..8 {
                assert_eq!(at % 8, 0);
                at += expected.bin_count * 8;
            }
            at += expected.bin_count * 4 * 2 + expected.bin_count;
            at = align8(at);
            at += expected.points.len() * 16;
            at = align8(at);
        }
        assert_eq!(at, bytes.len());
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
