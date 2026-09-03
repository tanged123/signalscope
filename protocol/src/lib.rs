//! Versioned data-plane protocol generated from the repository schema.

mod envelope;
mod generated;
pub mod line_binary;
pub mod tile_binary;

pub use envelope::{Envelope, VersionError};
pub use generated::*;
pub use line_binary::{
    BinaryLineColumn, BinaryLineResponse, LineBinaryError, OwnedBinaryLineColumn,
    OwnedBinaryLineResponse, decode_line_response, encode_line_response,
};
pub use tile_binary::{
    BinaryTileSeries, OwnedBinarySeries, TileBinaryError, decode_tile_response,
    encode_tile_response,
};

#[cfg(test)]
mod tests {
    use super::{SnapshotManifest, TileRequest};

    #[test]
    fn tile_requests_keep_wire_ids_exact() {
        let request: TileRequest = serde_json::from_str(
            r#"{"request_id":"r","signal_ids":["9007199254740993"],
                "window":{"t0":0.0,"t1":1.0},"pixel_width":100}"#,
        )
        .unwrap();
        assert_eq!(request.signal_ids, vec![9_007_199_254_740_993]);
    }

    #[test]
    fn old_snapshot_manifests_default_missing_line_payload() {
        let manifest: SnapshotManifest =
            serde_json::from_str(r#"{"session_json":"{}","signals":[]}"#).unwrap();
        assert_eq!(manifest.line2d, None);
    }
}
