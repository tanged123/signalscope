#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]

use crate::{Envelope, FileWriteMetadata, PROTOCOL_VERSION};

const MAGIC: u32 = 0x_5746_5353;
const HEADER_BYTES: usize = 24;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FileBinaryError {
    #[error("file frame is truncated")]
    Truncated,
    #[error("file frame has the wrong magic")]
    Magic,
    #[error("file frame has the wrong protocol version")]
    Version,
    #[error("file frame length is invalid")]
    Length,
    #[error("file frame metadata is invalid: {0}")]
    Metadata(String),
    #[error("file frame has trailing bytes")]
    Trailing,
}

pub fn encode_file_frame(
    metadata: &Envelope<FileWriteMetadata>,
    payload: &[u8],
) -> Result<Vec<u8>, FileBinaryError> {
    let metadata = serde_json::to_vec(metadata)
        .map_err(|error| FileBinaryError::Metadata(error.to_string()))?;
    let metadata_length = u32::try_from(metadata.len()).map_err(|_| FileBinaryError::Length)?;
    let payload_length = u64::try_from(payload.len()).map_err(|_| FileBinaryError::Length)?;
    let total = HEADER_BYTES
        .checked_add(metadata.len())
        .and_then(|length| length.checked_add(payload.len()))
        .ok_or(FileBinaryError::Length)?;
    let mut frame = Vec::with_capacity(total);
    frame.extend_from_slice(&MAGIC.to_le_bytes());
    frame.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    frame.extend_from_slice(&metadata_length.to_le_bytes());
    frame.extend_from_slice(&0_u32.to_le_bytes());
    frame.extend_from_slice(&payload_length.to_le_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_file_frame(
    frame: &[u8],
) -> Result<(Envelope<FileWriteMetadata>, Vec<u8>), FileBinaryError> {
    if frame.len() < HEADER_BYTES {
        return Err(FileBinaryError::Truncated);
    }
    if u32::from_le_bytes(frame[0..4].try_into().unwrap()) != MAGIC {
        return Err(FileBinaryError::Magic);
    }
    if u32::from_le_bytes(frame[4..8].try_into().unwrap()) != PROTOCOL_VERSION {
        return Err(FileBinaryError::Version);
    }
    let metadata_length = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
    let reserved = u32::from_le_bytes(frame[12..16].try_into().unwrap());
    if reserved != 0 {
        return Err(FileBinaryError::Length);
    }
    let payload_length = usize::try_from(u64::from_le_bytes(frame[16..24].try_into().unwrap()))
        .map_err(|_| FileBinaryError::Length)?;
    let metadata_end = HEADER_BYTES
        .checked_add(metadata_length)
        .ok_or(FileBinaryError::Length)?;
    let payload_end = metadata_end
        .checked_add(payload_length)
        .ok_or(FileBinaryError::Length)?;
    if frame.len() < payload_end {
        return Err(FileBinaryError::Truncated);
    }
    if frame.len() != payload_end {
        return Err(FileBinaryError::Trailing);
    }
    let metadata = serde_json::from_slice(&frame[HEADER_BYTES..metadata_end])
        .map_err(|error| FileBinaryError::Metadata(error.to_string()))?;
    Ok((metadata, frame[metadata_end..payload_end].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::{decode_file_frame, encode_file_frame};
    use crate::{Envelope, ExportFileKind, FileWriteDestination, FileWriteMetadata};

    fn metadata() -> Envelope<FileWriteMetadata> {
        Envelope::new(FileWriteMetadata {
            destination: FileWriteDestination::Directory,
            path: "/tmp/é".into(),
            file_name: "plot.png".into(),
            kind: ExportFileKind::Png,
        })
    }

    #[test]
    fn round_trips_unicode_metadata_and_empty_payload() {
        let frame = encode_file_frame(&metadata(), &[]).unwrap();
        let (decoded, payload) = decode_file_frame(&frame).unwrap();
        assert_eq!(decoded, metadata());
        assert!(payload.is_empty());
    }

    #[test]
    fn rejects_wrong_header_and_trailing_bytes() {
        let frame = encode_file_frame(&metadata(), &[1, 2, 3]).unwrap();
        for length in 0..24 {
            assert!(
                decode_file_frame(&frame[..length]).is_err(),
                "header length {length}"
            );
        }
        let mut wrong_magic = frame.clone();
        wrong_magic[0] ^= 1;
        assert!(decode_file_frame(&wrong_magic).is_err());
        let mut trailing = frame;
        trailing.push(0);
        assert!(decode_file_frame(&trailing).is_err());
    }
}
