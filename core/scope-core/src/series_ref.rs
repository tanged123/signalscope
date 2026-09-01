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
