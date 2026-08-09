//! Versioned data-plane protocol generated from the repository schema.

mod envelope;
pub mod file_binary;
mod generated;
pub mod tile_binary;

pub use envelope::{Envelope, VersionError};
pub use file_binary::{FileBinaryError, decode_file_frame, encode_file_frame};
pub use generated::*;
pub use tile_binary::{
    BREAK_BEFORE, BinaryTileSeries, OwnedBinaryPoint, OwnedBinarySeries, TileBinaryError,
    decode_tile_response, encode_tile_response,
};

#[cfg(test)]
mod tests {
    use super::TileRequest;

    #[test]
    fn tile_requests_keep_wire_ids_exact() {
        let request: TileRequest = serde_json::from_str(
            r#"{"request_id":"r","signal_ids":["9007199254740993"],
                "window":{"t0":0.0,"t1":1.0},"pixel_width":100}"#,
        )
        .unwrap();
        assert_eq!(request.signal_ids, vec![9_007_199_254_740_993]);
        assert_eq!(request.pixel_width, 100);
    }
}
