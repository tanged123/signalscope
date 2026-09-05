//! Versioned binary transport for correspondence-preserving `Line2D` samples.
//!
//! The payload is little-endian and columnar. Each row in the shared anchor,
//! X, and Y columns comes from one source index; columns are never joined or
//! reduced independently.

use thiserror::Error;

/// Little-endian bytes `SS L2`, identifying a `Line2D` response.
pub const LINE_BINARY_MAGIC: u32 = 0x324c_5353;
/// Version of the `Line2D` binary framing, independent of the JSON protocol.
pub const LINE_BINARY_VERSION: u32 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LineBinaryError {
    #[error("invalid Line2D binary magic: {actual:#x}")]
    BadMagic { actual: u32 },
    #[error("unsupported Line2D binary version {actual}; expected {expected}")]
    Version { expected: u32, actual: u32 },
    #[error("truncated Line2D binary payload")]
    Truncated,
    #[error("malformed Line2D binary payload: {0}")]
    Malformed(&'static str),
}

/// Metadata and values for one `Line2D` column.
#[derive(Clone, Debug, PartialEq)]
pub struct BinaryLineColumn<'a> {
    pub signal_id: u64,
    pub signal_path: &'a str,
    pub unit: Option<&'a str>,
    pub values: &'a [f64],
}

/// A `Line2D` response. `ys` preserves the request's Y signal order.
#[derive(Clone, Debug, PartialEq)]
pub struct BinaryLineResponse<'a> {
    pub level: u32,
    pub anchor: &'a [f64],
    pub x: BinaryLineColumn<'a>,
    pub ys: &'a [BinaryLineColumn<'a>],
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnedBinaryLineColumn {
    pub signal_id: u64,
    pub signal_path: String,
    pub unit: Option<String>,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnedBinaryLineResponse {
    pub level: u32,
    pub anchor: Vec<f64>,
    pub x: OwnedBinaryLineColumn,
    pub ys: Vec<OwnedBinaryLineColumn>,
}

/// Encodes a versioned, little-endian `Line2D` response.
///
/// Wire layout:
///
/// ```text
/// header: magic u32, version u32, level u32, y_count u32,
///         row_count u32, reserved u32
/// metadata: X then each Y: signal_id u64, path_len u16, unit_len u16,
///           reserved u32, UTF-8 path, optional UTF-8 unit, 8-byte padding
/// columns: source anchor f64[row_count], X f64[row_count],
///          then each Y f64[row_count]
/// ```
///
/// # Errors
///
/// Returns an error when response columns or metadata exceed the binary
/// framing limits, have mismatched lengths, or the response has no Y columns.
pub fn encode_line_response(response: &BinaryLineResponse<'_>) -> Result<Vec<u8>, LineBinaryError> {
    validate_response(response)?;
    let row_count = response.anchor.len();
    let mut bytes = Vec::with_capacity(response_bytes(response)?);
    put_u32(&mut bytes, LINE_BINARY_MAGIC);
    put_u32(&mut bytes, LINE_BINARY_VERSION);
    put_u32(&mut bytes, response.level);
    put_u32(
        &mut bytes,
        u32::try_from(response.ys.len()).unwrap_or(u32::MAX),
    );
    put_u32(&mut bytes, u32::try_from(row_count).unwrap_or(u32::MAX));
    put_u32(&mut bytes, 0);

    append_metadata(&mut bytes, &response.x);
    for column in response.ys {
        append_metadata(&mut bytes, column);
    }
    append_f64s(&mut bytes, response.anchor);
    append_f64s(&mut bytes, response.x.values);
    for column in response.ys {
        append_f64s(&mut bytes, column.values);
    }
    Ok(bytes)
}

/// Decodes a versioned, little-endian `Line2D` response.
///
/// # Errors
///
/// Returns an error when the framing, metadata, padding, or column lengths are
/// malformed or use an unsupported binary version.
pub fn decode_line_response(bytes: &[u8]) -> Result<OwnedBinaryLineResponse, LineBinaryError> {
    if bytes.len() < 24 {
        return Err(LineBinaryError::Truncated);
    }
    let mut at = 0;
    let magic = read_u32(bytes, &mut at)?;
    if magic != LINE_BINARY_MAGIC {
        return Err(LineBinaryError::BadMagic { actual: magic });
    }
    let version = read_u32(bytes, &mut at)?;
    if version != LINE_BINARY_VERSION {
        return Err(LineBinaryError::Version {
            expected: LINE_BINARY_VERSION,
            actual: version,
        });
    }
    let level = read_u32(bytes, &mut at)?;
    let y_count = usize::try_from(read_u32(bytes, &mut at)?)
        .map_err(|_| LineBinaryError::Malformed("Y column count overflow"))?;
    if y_count == 0 {
        return Err(LineBinaryError::Malformed("missing Y columns"));
    }
    if y_count > (bytes.len() - 24) / 16 {
        return Err(LineBinaryError::Malformed("Y column count exceeds payload"));
    }
    let row_count = usize::try_from(read_u32(bytes, &mut at)?)
        .map_err(|_| LineBinaryError::Malformed("row count overflow"))?;
    if read_u32(bytes, &mut at)? != 0 {
        return Err(LineBinaryError::Malformed("reserved header is nonzero"));
    }

    let x = read_metadata(bytes, &mut at)?;
    let mut ys = Vec::with_capacity(y_count);
    for _ in 0..y_count {
        ys.push(read_metadata(bytes, &mut at)?);
    }
    let anchor = read_f64s(bytes, &mut at, row_count)?;
    let x_values = read_f64s(bytes, &mut at, row_count)?;
    let mut y_values = Vec::with_capacity(y_count);
    for _ in 0..y_count {
        y_values.push(read_f64s(bytes, &mut at, row_count)?);
    }
    if at != bytes.len() {
        return Err(LineBinaryError::Malformed("trailing bytes"));
    }

    let x = OwnedBinaryLineColumn {
        signal_id: x.signal_id,
        signal_path: x.signal_path,
        unit: x.unit,
        values: x_values,
    };
    let ys = ys
        .into_iter()
        .zip(y_values)
        .map(|(metadata, values)| OwnedBinaryLineColumn {
            signal_id: metadata.signal_id,
            signal_path: metadata.signal_path,
            unit: metadata.unit,
            values,
        })
        .collect();
    Ok(OwnedBinaryLineResponse {
        level,
        anchor,
        x,
        ys,
    })
}

fn response_bytes(response: &BinaryLineResponse<'_>) -> Result<usize, LineBinaryError> {
    let metadata = response
        .ys
        .iter()
        .try_fold(metadata_bytes(&response.x)?, |total, column| {
            total
                .checked_add(metadata_bytes(column)?)
                .ok_or(LineBinaryError::Malformed("Line2D payload size overflow"))
        })?;
    let columns = response
        .anchor
        .len()
        .checked_mul(8 + 8 * (1 + response.ys.len()))
        .ok_or(LineBinaryError::Malformed("Line2D column size overflow"))?;
    24usize
        .checked_add(metadata)
        .and_then(|size| size.checked_add(columns))
        .ok_or(LineBinaryError::Malformed("Line2D payload size overflow"))
}

fn validate_response(response: &BinaryLineResponse<'_>) -> Result<(), LineBinaryError> {
    if response.ys.is_empty() {
        return Err(LineBinaryError::Malformed(
            "Line2D requires at least one Y column",
        ));
    }
    if u32::try_from(response.ys.len()).is_err() {
        return Err(LineBinaryError::Malformed("Y column count exceeds u32"));
    }
    if u32::try_from(response.anchor.len()).is_err() {
        return Err(LineBinaryError::Malformed("row count exceeds u32"));
    }
    if response.anchor.len() != response.x.values.len() {
        return Err(LineBinaryError::Malformed("X column length mismatch"));
    }
    if u16::try_from(response.x.signal_path.len()).is_err() {
        return Err(LineBinaryError::Malformed("signal path exceeds u16"));
    }
    if response
        .x
        .unit
        .is_some_and(|unit| unit.len() >= usize::from(u16::MAX))
    {
        return Err(LineBinaryError::Malformed("unit exceeds u16"));
    }
    for column in response.ys {
        if u16::try_from(column.signal_path.len()).is_err() {
            return Err(LineBinaryError::Malformed("signal path exceeds u16"));
        }
        if column
            .unit
            .is_some_and(|unit| unit.len() >= usize::from(u16::MAX))
        {
            return Err(LineBinaryError::Malformed("unit exceeds u16"));
        }
        if response.anchor.len() != column.values.len() {
            return Err(LineBinaryError::Malformed("Y column length mismatch"));
        }
    }
    Ok(())
}

fn metadata_bytes(column: &BinaryLineColumn<'_>) -> Result<usize, LineBinaryError> {
    let payload = column
        .signal_path
        .len()
        .checked_add(column.unit.map_or(0, str::len))
        .and_then(|size| size.checked_add(7))
        .ok_or(LineBinaryError::Malformed("Line2D metadata size overflow"))?
        & !7;
    16usize
        .checked_add(payload)
        .ok_or(LineBinaryError::Malformed("Line2D metadata size overflow"))
}

fn append_metadata(bytes: &mut Vec<u8>, column: &BinaryLineColumn<'_>) {
    put_u64(bytes, column.signal_id);
    put_u16(
        bytes,
        u16::try_from(column.signal_path.len()).expect("signal path fits in u16"),
    );
    put_u16(
        bytes,
        column.unit.map_or(u16::MAX, |unit| {
            u16::try_from(unit.len()).expect("unit fits in u16")
        }),
    );
    put_u32(bytes, 0);
    bytes.extend_from_slice(column.signal_path.as_bytes());
    if let Some(unit) = column.unit {
        bytes.extend_from_slice(unit.as_bytes());
    }
    bytes.resize(align8(bytes.len()), 0);
}

struct Metadata {
    signal_id: u64,
    signal_path: String,
    unit: Option<String>,
}

fn read_metadata(bytes: &[u8], at: &mut usize) -> Result<Metadata, LineBinaryError> {
    let signal_id = read_u64(bytes, at)?;
    let path_len = usize::from(read_u16(bytes, at)?);
    let unit_len = read_u16(bytes, at)?;
    if read_u32(bytes, at)? != 0 {
        return Err(LineBinaryError::Malformed(
            "reserved metadata field is nonzero",
        ));
    }
    let signal_path = String::from_utf8(take(bytes, at, path_len)?.to_vec())
        .map_err(|_| LineBinaryError::Malformed("signal path is not utf8"))?;
    let unit = if unit_len == u16::MAX {
        None
    } else {
        Some(
            String::from_utf8(take(bytes, at, usize::from(unit_len))?.to_vec())
                .map_err(|_| LineBinaryError::Malformed("unit is not utf8"))?,
        )
    };
    let aligned = align8_checked(*at, bytes.len())?;
    if bytes[*at..aligned].iter().any(|byte| *byte != 0) {
        return Err(LineBinaryError::Malformed("metadata padding is nonzero"));
    }
    *at = aligned;
    Ok(Metadata {
        signal_id,
        signal_path,
        unit,
    })
}

fn append_f64s(bytes: &mut Vec<u8>, values: &[f64]) {
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

fn put_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn align8(value: usize) -> usize {
    value.checked_add(7).expect("Line2D payload size overflow") & !7
}

fn align8_checked(value: usize, length: usize) -> Result<usize, LineBinaryError> {
    let aligned = value
        .checked_add(7)
        .ok_or(LineBinaryError::Malformed("offset overflow"))?
        & !7;
    (aligned <= length)
        .then_some(aligned)
        .ok_or(LineBinaryError::Truncated)
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], LineBinaryError> {
    let end = at
        .checked_add(len)
        .ok_or(LineBinaryError::Malformed("offset overflow"))?;
    let output = bytes.get(*at..end).ok_or(LineBinaryError::Truncated)?;
    *at = end;
    Ok(output)
}

fn read_u16(bytes: &[u8], at: &mut usize) -> Result<u16, LineBinaryError> {
    Ok(u16::from_le_bytes(
        take(bytes, at, 2)?.try_into().expect("length checked"),
    ))
}

fn read_u32(bytes: &[u8], at: &mut usize) -> Result<u32, LineBinaryError> {
    Ok(u32::from_le_bytes(
        take(bytes, at, 4)?.try_into().expect("length checked"),
    ))
}

fn read_u64(bytes: &[u8], at: &mut usize) -> Result<u64, LineBinaryError> {
    Ok(u64::from_le_bytes(
        take(bytes, at, 8)?.try_into().expect("length checked"),
    ))
}

fn read_f64s(bytes: &[u8], at: &mut usize, count: usize) -> Result<Vec<f64>, LineBinaryError> {
    take(
        bytes,
        at,
        count
            .checked_mul(8)
            .ok_or(LineBinaryError::Malformed("column size overflow"))?,
    )?
    .chunks_exact(8)
    .map(|chunk| {
        Ok(f64::from_le_bytes(
            chunk.try_into().expect("length checked"),
        ))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> BinaryLineResponse<'static> {
        static ANCHOR: [f64; 4] = [0.0, 1.0, 2.0, 3.0];
        static X: [f64; 4] = [10.0, f64::NAN, 12.0, 13.0];
        static Y0: [f64; 4] = [20.0, 21.0, f64::NAN, 23.0];
        static Y1: [f64; 4] = [30.0, 31.0, 32.0, f64::NAN];
        static YS: [BinaryLineColumn<'static>; 2] = [
            BinaryLineColumn {
                signal_id: 2,
                signal_path: "run/y0",
                unit: Some("V"),
                values: &Y0,
            },
            BinaryLineColumn {
                signal_id: 3,
                signal_path: "run/y1",
                unit: None,
                values: &Y1,
            },
        ];
        BinaryLineResponse {
            level: 4,
            anchor: &ANCHOR,
            x: BinaryLineColumn {
                signal_id: 1,
                signal_path: "run/x",
                unit: Some("s"),
                values: &X,
            },
            ys: &YS,
        }
    }

    #[test]
    fn round_trip_preserves_metadata_order_rows_and_nan_gaps() {
        let expected = response();
        let bytes = encode_line_response(&expected).unwrap();
        let actual = decode_line_response(&bytes).expect("decode");
        assert_eq!(actual.level, expected.level);
        assert_eq!(actual.anchor, expected.anchor);
        assert_eq!(actual.x.signal_id, expected.x.signal_id);
        assert_eq!(actual.x.signal_path, expected.x.signal_path);
        assert_eq!(actual.x.unit.as_deref(), expected.x.unit);
        assert_f64s(&actual.x.values, expected.x.values);
        assert_eq!(actual.ys.len(), expected.ys.len());
        for (actual, expected) in actual.ys.iter().zip(expected.ys) {
            assert_eq!(actual.signal_id, expected.signal_id);
            assert_eq!(actual.signal_path, expected.signal_path);
            assert_eq!(actual.unit.as_deref(), expected.unit);
            assert_f64s(&actual.values, expected.values);
        }
    }

    #[test]
    fn rejects_bad_version_and_empty_y_columns() {
        let expected = response();
        let mut bytes = encode_line_response(&expected).unwrap();
        bytes[4..8].copy_from_slice(&2_u32.to_le_bytes());
        assert!(matches!(
            decode_line_response(&bytes),
            Err(LineBinaryError::Version { .. })
        ));

        let mut bytes = encode_line_response(&expected).unwrap();
        bytes[12..16].copy_from_slice(&0_u32.to_le_bytes());
        assert_eq!(
            decode_line_response(&bytes),
            Err(LineBinaryError::Malformed("missing Y columns"))
        );

        let mut bytes = encode_line_response(&expected).unwrap();
        bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            decode_line_response(&bytes),
            Err(LineBinaryError::Malformed("Y column count exceeds payload"))
        );

        let mut bytes = encode_line_response(&expected).unwrap();
        bytes[46] = 1;
        assert_eq!(
            decode_line_response(&bytes),
            Err(LineBinaryError::Malformed("metadata padding is nonzero"))
        );
    }

    #[test]
    fn rejects_a_unit_length_reserved_for_the_absent_sentinel() {
        let base = response();
        let unit = "u".repeat(usize::from(u16::MAX));
        let x = BinaryLineColumn {
            signal_id: base.x.signal_id,
            signal_path: base.x.signal_path,
            unit: Some(&unit),
            values: base.x.values,
        };
        let invalid = BinaryLineResponse {
            level: base.level,
            anchor: base.anchor,
            x,
            ys: base.ys,
        };

        assert_eq!(
            encode_line_response(&invalid),
            Err(LineBinaryError::Malformed("unit exceeds u16"))
        );
    }

    #[test]
    fn rejects_an_oversized_signal_path_without_panicking() {
        let base = response();
        let path = "p".repeat(usize::from(u16::MAX) + 1);
        let x = BinaryLineColumn {
            signal_id: base.x.signal_id,
            signal_path: &path,
            unit: base.x.unit,
            values: base.x.values,
        };
        let invalid = BinaryLineResponse {
            level: base.level,
            anchor: base.anchor,
            x,
            ys: base.ys,
        };

        assert_eq!(
            encode_line_response(&invalid),
            Err(LineBinaryError::Malformed("signal path exceeds u16"))
        );
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
