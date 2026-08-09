#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]

use crate::{Envelope, FileWriteMetadata, PROTOCOL_VERSION};

const MAGIC: u32 = 0x_5746_5353;
pub const FILE_FRAME_HEADER_BYTES: usize = 24;
pub const FILE_FRAME_METADATA_LIMIT: usize = 1024 * 1024;
pub const FILE_FRAME_PAYLOAD_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFrameHeader {
    pub metadata_length: u32,
    pub payload_length: u64,
}

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
    if metadata.len() > FILE_FRAME_METADATA_LIMIT {
        return Err(FileBinaryError::Length);
    }
    let payload_length = u64::try_from(payload.len()).map_err(|_| FileBinaryError::Length)?;
    if payload_length > FILE_FRAME_PAYLOAD_LIMIT {
        return Err(FileBinaryError::Length);
    }
    let total = FILE_FRAME_HEADER_BYTES
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

pub fn decode_file_frame_header(bytes: &[u8]) -> Result<FileFrameHeader, FileBinaryError> {
    if bytes.len() < FILE_FRAME_HEADER_BYTES {
        return Err(FileBinaryError::Truncated);
    }
    if u32::from_le_bytes(bytes[0..4].try_into().unwrap()) != MAGIC {
        return Err(FileBinaryError::Magic);
    }
    if u32::from_le_bytes(bytes[4..8].try_into().unwrap()) != PROTOCOL_VERSION {
        return Err(FileBinaryError::Version);
    }
    let metadata_length = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let reserved = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    if reserved != 0 {
        return Err(FileBinaryError::Length);
    }
    if usize::try_from(metadata_length).map_err(|_| FileBinaryError::Length)?
        > FILE_FRAME_METADATA_LIMIT
    {
        return Err(FileBinaryError::Length);
    }
    let payload_length = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
    if payload_length > FILE_FRAME_PAYLOAD_LIMIT {
        return Err(FileBinaryError::Length);
    }
    Ok(FileFrameHeader {
        metadata_length,
        payload_length,
    })
}

pub fn decode_file_frame_metadata(
    header: &FileFrameHeader,
    bytes: &[u8],
) -> Result<Envelope<FileWriteMetadata>, FileBinaryError> {
    let metadata_length =
        usize::try_from(header.metadata_length).map_err(|_| FileBinaryError::Length)?;
    if bytes.len() != metadata_length {
        return Err(if bytes.len() < metadata_length {
            FileBinaryError::Truncated
        } else {
            FileBinaryError::Trailing
        });
    }
    serde_json::from_slice(bytes).map_err(|error| FileBinaryError::Metadata(error.to_string()))
}

pub fn decode_file_frame(
    frame: &[u8],
) -> Result<(Envelope<FileWriteMetadata>, Vec<u8>), FileBinaryError> {
    let header = decode_file_frame_header(frame)?;
    let metadata_length =
        usize::try_from(header.metadata_length).map_err(|_| FileBinaryError::Length)?;
    let metadata_start = FILE_FRAME_HEADER_BYTES;
    let metadata_end = metadata_start
        .checked_add(metadata_length)
        .ok_or(FileBinaryError::Length)?;
    let payload_length =
        usize::try_from(header.payload_length).map_err(|_| FileBinaryError::Length)?;
    let payload_end = metadata_end
        .checked_add(payload_length)
        .ok_or(FileBinaryError::Length)?;
    if frame.len() < payload_end {
        return Err(FileBinaryError::Truncated);
    }
    if frame.len() != payload_end {
        return Err(FileBinaryError::Trailing);
    }
    let metadata = decode_file_frame_metadata(&header, &frame[metadata_start..metadata_end])?;
    Ok((metadata, frame[metadata_end..payload_end].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::{
        FILE_FRAME_HEADER_BYTES, FILE_FRAME_METADATA_LIMIT, FILE_FRAME_PAYLOAD_LIMIT,
        FileFrameHeader, decode_file_frame, decode_file_frame_header, decode_file_frame_metadata,
        encode_file_frame,
    };
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
        for length in 0..FILE_FRAME_HEADER_BYTES {
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

    #[test]
    fn splits_header_and_metadata_decoding() {
        let frame = encode_file_frame(&metadata(), &[1, 2, 3]).unwrap();
        let header = decode_file_frame_header(&frame).unwrap();
        assert_eq!(
            header,
            FileFrameHeader {
                metadata_length: u32::try_from(frame.len() - FILE_FRAME_HEADER_BYTES - 3).unwrap(),
                payload_length: 3,
            }
        );
        assert_eq!(
            decode_file_frame_metadata(
                &header,
                &frame[FILE_FRAME_HEADER_BYTES
                    ..FILE_FRAME_HEADER_BYTES + header.metadata_length as usize]
            )
            .unwrap(),
            metadata()
        );
    }

    #[test]
    fn rejects_reserved_and_oversized_lengths() {
        let frame = encode_file_frame(&metadata(), &[]).unwrap();
        let mut reserved = frame.clone();
        reserved[12] = 1;
        assert!(decode_file_frame_header(&reserved).is_err());

        let mut metadata_too_large = frame.clone();
        metadata_too_large[8..12].copy_from_slice(
            &u32::try_from(FILE_FRAME_METADATA_LIMIT + 1)
                .unwrap()
                .to_le_bytes(),
        );
        assert!(decode_file_frame_header(&metadata_too_large).is_err());

        let mut payload_too_large = frame;
        payload_too_large[16..24].copy_from_slice(&(FILE_FRAME_PAYLOAD_LIMIT + 1).to_le_bytes());
        assert!(decode_file_frame_header(&payload_too_large).is_err());
    }
}
