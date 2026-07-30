//! Versioned data-plane protocol generated from the repository schema.

mod envelope;
mod generated;

pub use envelope::{Envelope, VersionError};
pub use generated::*;

#[cfg(test)]
mod tests {
    use super::EnsembleTileRequest;

    #[test]
    fn ensemble_requests_use_local_set_ids_and_durable_member_keys() {
        let request: EnsembleTileRequest = serde_json::from_str(
            r#"{"request_id":"r","set_id":"7","local_path":"imu/ax",
                "window":{"t0":0.0,"t1":1.0},"pixel_width":100,
                "member_filter":["3f2504e0-4f89-11d3-9a0c-0305e82c3301"]}"#,
        )
        .unwrap();
        assert_eq!(request.set_id, 7);
        assert_eq!(request.member_filter.len(), 1);
    }
}
