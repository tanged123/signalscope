use crate::session::{SeriesRef, SourceRecord};

pub const DERIVED_SOURCE_KEY: &str = "derived";

#[must_use]
pub fn path_from_ref(sources: &[SourceRecord], reference: &SeriesRef) -> Option<String> {
    if reference.source_key == DERIVED_SOURCE_KEY {
        return Some(format!("{DERIVED_SOURCE_KEY}/{}", reference.channel));
    }
    sources
        .iter()
        .find(|source| source.key == reference.source_key)
        .map(|source| {
            if source.prefix.is_empty() {
                reference.channel.clone()
            } else {
                format!("{}/{}", source.prefix, reference.channel)
            }
        })
}

#[must_use]
pub fn ref_from_path(sources: &[SourceRecord], path: &str) -> Option<SeriesRef> {
    ref_from_prefixes(
        path,
        &sources
            .iter()
            .map(|source| (source.prefix.clone(), source.key.clone()))
            .collect::<Vec<_>>(),
    )
}

#[must_use]
pub fn ref_from_prefixes(path: &str, prefixes: &[(String, String)]) -> Option<SeriesRef> {
    if let Some(channel) = path.strip_prefix(&format!("{DERIVED_SOURCE_KEY}/")) {
        return Some(SeriesRef {
            source_key: DERIVED_SOURCE_KEY.into(),
            channel: channel.into(),
        });
    }
    prefixes
        .iter()
        .filter_map(|(prefix, key)| {
            if prefix.is_empty() {
                Some((0, key, path))
            } else if path.len() > prefix.len() + 1
                && path.starts_with(prefix)
                && path.as_bytes()[prefix.len()] == b'/'
            {
                Some((prefix.len(), key, &path[prefix.len() + 1..]))
            } else {
                None
            }
        })
        .max_by_key(|(length, _, _)| *length)
        .map(|(_, key, channel)| SeriesRef {
            source_key: key.clone(),
            channel: channel.into(),
        })
}
