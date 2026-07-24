//! MCAP decoding for channels with json-encoded messages (ADR 0009).

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::Arc,
};

use serde_json::Value;

use super::{Decoder, IngestError, IngestSummary, normalize_segment};
use crate::store::SignalStore;

#[derive(Clone, Copy, Debug, Default)]
pub struct McapDecoder;

#[derive(Default)]
struct TopicColumns {
    time: Vec<f64>,
    columns: BTreeMap<String, Vec<f64>>,
}

impl TopicColumns {
    fn push_row(&mut self, time: f64, fields: &[(String, f64)]) {
        let backfill = self.time.len();
        self.time.push(time);
        for (name, value) in fields {
            let column = self
                .columns
                .entry(name.clone())
                .or_insert_with(|| vec![f64::NAN; backfill]);
            column.push(*value);
        }
        for column in self.columns.values_mut() {
            if column.len() < self.time.len() {
                column.push(f64::NAN);
            }
        }
    }

    fn sorted(mut self) -> Self {
        let mut order: Vec<usize> = (0..self.time.len()).collect();
        order.sort_by(|&left, &right| self.time[left].total_cmp(&self.time[right]));
        if order
            .iter()
            .enumerate()
            .all(|(position, index)| position == *index)
        {
            return self;
        }
        self.time = order.iter().map(|&index| self.time[index]).collect();
        for column in self.columns.values_mut() {
            *column = order.iter().map(|&index| column[index]).collect();
        }
        self
    }
}

impl Decoder for McapDecoder {
    #[allow(clippy::cast_precision_loss)] // ns log times survive f64 to sub-µs precision
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        progress(0.0);
        let data = fs::read(path)?;
        let mut topics: BTreeMap<String, TopicColumns> = BTreeMap::new();
        let mut encodings: BTreeSet<String> = BTreeSet::new();
        let mut fields: Vec<(String, f64)> = Vec::new();
        for message in ::mcap::MessageStream::new(&data)? {
            let message = message?;
            encodings.insert(message.channel.message_encoding.clone());
            if message.channel.message_encoding != "json" {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                continue;
            };
            fields.clear();
            flatten_numeric("", &value, &mut fields);
            topics
                .entry(normalize_topic(&message.channel.topic))
                .or_default()
                .push_row(message.log_time as f64 * 1e-9, &fields);
        }

        let source_id = store.register_source(path);
        let mut signals = Vec::new();
        let mut row_count = 0;
        for (topic, columns) in topics {
            let columns = columns.sorted();
            row_count += columns.time.len();
            let time: Arc<[f64]> = columns.time.into();
            for (field, values) in columns.columns {
                if !values.iter().any(|value| value.is_finite()) {
                    continue;
                }
                let name = if field.is_empty() {
                    "value".to_owned()
                } else {
                    field
                };
                signals.push(store.insert_signal(
                    source_id,
                    format!("{topic}/{name}"),
                    None,
                    Arc::clone(&time),
                    values,
                )?);
            }
        }
        if signals.is_empty() {
            let seen = if encodings.is_empty() {
                "none".to_owned()
            } else {
                encodings.into_iter().collect::<Vec<_>>().join(", ")
            };
            return Err(IngestError::NoSupportedChannels(seen));
        }
        progress(1.0);
        Ok(IngestSummary {
            source_id,
            source_path: path.to_owned(),
            row_count,
            signals,
        })
    }
}

fn flatten_numeric(prefix: &str, value: &Value, out: &mut Vec<(String, f64)>) {
    let child = |key: String| {
        if prefix.is_empty() {
            key
        } else {
            format!("{prefix}/{key}")
        }
    };
    match value {
        Value::Number(number) => {
            if let Some(number) = number.as_f64() {
                out.push((prefix.to_owned(), number));
            }
        }
        Value::Bool(flag) => out.push((prefix.to_owned(), f64::from(u8::from(*flag)))),
        Value::Object(map) => {
            for (key, nested) in map {
                flatten_numeric(&child(normalize_segment(key)), nested, out);
            }
        }
        Value::Array(items) => {
            for (index, nested) in items.iter().enumerate() {
                flatten_numeric(&child(index.to_string()), nested, out);
            }
        }
        Value::String(_) | Value::Null => {}
    }
}

fn normalize_topic(topic: &str) -> String {
    let segments: Vec<String> = topic
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(normalize_segment)
        .collect();
    if segments.is_empty() {
        "topic".to_owned()
    } else {
        segments.join("/")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::ingest::ingest_path;

    fn write_test_mcap(
        channels: &[(&str, &str)],
        messages: &[(usize, u64, &str)],
    ) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut writer = ::mcap::write::Writer::new(file.as_file()).unwrap();
        let ids: Vec<u16> = channels
            .iter()
            .map(|(topic, encoding)| {
                writer
                    .add_channel(0, topic, encoding, &BTreeMap::new())
                    .unwrap()
            })
            .collect();
        for (sequence, (channel_index, log_time, body)) in messages.iter().enumerate() {
            writer
                .write_to_known_channel(
                    &::mcap::records::MessageHeader {
                        channel_id: ids[*channel_index],
                        sequence: u32::try_from(sequence).unwrap(),
                        log_time: *log_time,
                        publish_time: *log_time,
                    },
                    body.as_bytes(),
                )
                .unwrap();
        }
        writer.finish().unwrap();
        drop(writer);
        file
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn flattens_sorts_and_backfills_json_channels() {
        let file = write_test_mcap(
            &[("/Vehicle/IMU", "json"), ("/other", "protobuf")],
            &[
                (
                    0,
                    2_000_000_000,
                    r#"{"accel":{"x":1.5,"y":-2.0},"ok":true}"#,
                ),
                (1, 1_000_000_000, "\x00\x01"),
                (0, 1_000_000_000, r#"{"accel":{"x":0.5},"name":"imu"}"#),
                (
                    0,
                    3_000_000_000,
                    r#"{"accel":{"x":2.5,"y":-3.0},"ok":false}"#,
                ),
            ],
        );
        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();

        assert_eq!(summary.row_count, 3);
        let x = store.signal_by_path("vehicle/imu/accel/x").unwrap();
        assert_eq!(x.time(), &[1.0, 2.0, 3.0]);
        assert_eq!(x.values(), &[0.5, 1.5, 2.5]);
        let y = store.signal_by_path("vehicle/imu/accel/y").unwrap();
        assert!(y.values()[0].is_nan());
        assert_eq!(y.values()[1], -2.0);
        let ok = store.signal_by_path("vehicle/imu/ok").unwrap();
        assert!(ok.values()[0].is_nan());
        assert_eq!(&ok.values()[1..], &[1.0, 0.0]);
        assert!(store.signal_by_path("vehicle/imu/name").is_none());
    }

    #[test]
    fn rejects_files_with_no_ingestible_channels() {
        let file = write_test_mcap(&[("/other", "protobuf")], &[(0, 1, "\x00")]);
        let mut store = SignalStore::new();
        let error = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap_err();
        assert!(matches!(error, IngestError::NoSupportedChannels(_)));
        assert_eq!(store.sources().count(), 0, "transaction must roll back");
    }
}
