use std::{
    fmt,
    fs::File,
    io::{self, Read},
    path::Path,
    sync::Arc,
};

use thiserror::Error;

use super::Decoder;

/// How strongly a provider claims a probe window.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Confidence {
    /// The provider does not handle this input.
    No,
    /// The content is plausible for the provider but not proven.
    Likely,
    /// The content has an unambiguous format marker.
    Certain,
}

/// Fixed probe window handed to every provider.
pub const PROBE_BYTES: usize = 8 * 1024;

type Sniffer = dyn Fn(&[u8]) -> Confidence + Send + Sync;
type DecoderFactory = dyn Fn() -> Box<dyn Decoder> + Send + Sync;

/// Runtime metadata and factories for one input format.
#[derive(Clone)]
pub struct FormatProvider {
    id: String,
    label: String,
    extensions: Vec<String>,
    priority: i32,
    cache_abi: u32,
    sniff: Arc<Sniffer>,
    decoder: Arc<DecoderFactory>,
}

impl fmt::Debug for FormatProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FormatProvider")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("extensions", &self.extensions)
            .field("priority", &self.priority)
            .field("cache_abi", &self.cache_abi)
            .finish_non_exhaustive()
    }
}

impl FormatProvider {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        extensions: &[&str],
        priority: i32,
        cache_abi: u32,
        sniff: impl Fn(&[u8]) -> Confidence + Send + Sync + 'static,
        decoder: impl Fn() -> Box<dyn Decoder> + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            extensions: extensions
                .iter()
                .map(|extension| (*extension).into())
                .collect(),
            priority,
            cache_abi,
            sniff: Arc::new(sniff),
            decoder: Arc::new(decoder),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn label(&self) -> &str {
        &self.label
    }

    #[must_use]
    pub fn extensions(&self) -> &[String] {
        &self.extensions
    }

    #[must_use]
    pub const fn priority(&self) -> i32 {
        self.priority
    }

    #[must_use]
    pub const fn cache_abi(&self) -> u32 {
        self.cache_abi
    }

    #[must_use]
    pub fn decoder(&self) -> Box<dyn Decoder> {
        (self.decoder)()
    }

    fn confidence(&self, bytes: &[u8]) -> Confidence {
        (self.sniff)(bytes)
    }
}

#[derive(Debug, Error)]
pub enum SelectionError {
    #[error("could not probe {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("unsupported input {path}; known formats: {known}")]
    Unsupported { path: String, known: String },
}

/// Registry of decoders selected by bounded content probes.
#[derive(Clone, Default)]
pub struct ProviderRegistry {
    providers: Vec<FormatProvider>,
}

impl ProviderRegistry {
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn builtin() -> Self {
        let mut registry = Self::empty();
        registry.register(super::csv::provider());
        registry.register(super::mcap::provider());
        registry
    }

    pub fn register(&mut self, provider: FormatProvider) {
        self.providers.push(provider);
    }

    #[must_use]
    pub fn provider(&self, id: &str) -> Option<&FormatProvider> {
        self.providers.iter().find(|provider| provider.id() == id)
    }

    /// Select a provider using a fixed-size probe of a file.
    ///
    /// # Errors
    ///
    /// Returns an IO error when the probe cannot be read or an unsupported
    /// error when no provider claims the input.
    pub fn select(&self, path: &Path) -> Result<&FormatProvider, SelectionError> {
        let mut probe = Vec::with_capacity(PROBE_BYTES);
        File::open(path)
            .and_then(|file| {
                file.take(PROBE_BYTES as u64)
                    .read_to_end(&mut probe)
                    .map(|_| ())
            })
            .map_err(|source| SelectionError::Io {
                path: path.display().to_string(),
                source,
            })?;
        self.select_probe(&probe, path.display().to_string())
    }

    /// Select a provider from an already bounded probe.
    ///
    /// # Errors
    ///
    /// Returns an unsupported error when no provider claims the input.
    pub fn select_bytes(&self, bytes: &[u8]) -> Result<&FormatProvider, SelectionError> {
        self.select_probe(bytes, "<bytes>".into())
    }

    fn select_probe(&self, probe: &[u8], path: String) -> Result<&FormatProvider, SelectionError> {
        let mut selected: Option<(&FormatProvider, Confidence)> = None;
        for provider in &self.providers {
            let confidence = provider.confidence(probe);
            if confidence == Confidence::No {
                continue;
            }
            let replace = selected.is_none_or(|(current, current_confidence)| {
                confidence > current_confidence
                    || (confidence == current_confidence
                        && (provider.priority > current.priority
                            || (provider.priority == current.priority && provider.id < current.id)))
            });
            if replace {
                selected = Some((provider, confidence));
            }
        }

        selected.map(|(provider, _)| provider).ok_or_else(|| {
            let mut known = self
                .providers
                .iter()
                .map(|provider| provider.id.clone())
                .collect::<Vec<_>>();
            known.sort_unstable();
            SelectionError::Unsupported {
                path,
                known: known.join(", "),
            }
        })
    }

    #[must_use]
    pub fn descriptors(&self) -> Vec<(&str, &str, &[String], i32)> {
        let mut providers = self.providers.iter().collect::<Vec<_>>();
        providers.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        providers
            .into_iter()
            .map(|provider| {
                (
                    provider.id(),
                    provider.label(),
                    provider.extensions(),
                    provider.priority(),
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::ingest::{DecodeContext, DecodedSource, Decoder, IngestError};

    #[derive(Clone, Copy, Debug, Default)]
    struct NullDecoder;

    impl Decoder for NullDecoder {
        fn decode(
            &self,
            _path: &std::path::Path,
            _context: &mut DecodeContext<'_>,
        ) -> Result<DecodedSource, IngestError> {
            Ok(DecodedSource::default())
        }
    }

    fn probe_provider(id: &'static str, priority: i32, confidence: Confidence) -> FormatProvider {
        FormatProvider::new(
            id,
            "Test",
            &["tst"],
            priority,
            1,
            move |_| confidence,
            || Box::new(NullDecoder),
        )
    }

    fn write_bytes(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        file
    }

    #[test]
    fn selection_ignores_registration_order() {
        let high = probe_provider("zeta", 10, Confidence::Likely);
        let low = probe_provider("alpha", 1, Confidence::Likely);

        let mut forward = ProviderRegistry::empty();
        forward.register(high.clone());
        forward.register(low.clone());
        let mut backward = ProviderRegistry::empty();
        backward.register(low);
        backward.register(high);

        assert_eq!(forward.select_bytes(b"anything").unwrap().id(), "zeta");
        assert_eq!(backward.select_bytes(b"anything").unwrap().id(), "zeta");
    }

    #[test]
    fn equal_priority_and_confidence_break_ties_on_provider_id() {
        let mut registry = ProviderRegistry::empty();
        registry.register(probe_provider("beta", 5, Confidence::Likely));
        registry.register(probe_provider("alpha", 5, Confidence::Likely));
        assert_eq!(registry.select_bytes(b"x").unwrap().id(), "alpha");
    }

    #[test]
    fn certain_beats_priority_and_zero_confidence_never_claims() {
        let mut registry = ProviderRegistry::empty();
        registry.register(probe_provider("low-priority", 0, Confidence::Certain));
        registry.register(probe_provider("high-priority", 99, Confidence::Likely));
        assert_eq!(registry.select_bytes(b"x").unwrap().id(), "low-priority");

        let mut empty_claim = ProviderRegistry::empty();
        empty_claim.register(probe_provider("nobody", 99, Confidence::No));
        assert!(matches!(
            empty_claim.select_bytes(b"x"),
            Err(SelectionError::Unsupported { .. })
        ));
    }

    #[test]
    fn the_probe_window_is_fixed_regardless_of_file_size() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(0_usize));
        let recorder = std::sync::Arc::clone(&seen);
        let mut registry = ProviderRegistry::empty();
        registry.register(FormatProvider::new(
            "probe",
            "P",
            &["p"],
            0,
            1,
            move |bytes| {
                *recorder.lock().unwrap() = bytes.len();
                Confidence::Likely
            },
            || Box::new(NullDecoder),
        ));

        let file = write_bytes(&vec![b'x'; PROBE_BYTES * 4]);
        registry.select(file.path()).unwrap();
        assert_eq!(*seen.lock().unwrap(), PROBE_BYTES);
    }

    #[test]
    fn an_unsupported_input_names_the_known_formats() {
        let registry = ProviderRegistry::empty();
        let error = registry.select_bytes(b"\x00\x01\x02").unwrap_err();
        assert!(matches!(error, SelectionError::Unsupported { .. }));
        assert!(error.to_string().contains("known formats"));
    }

    #[test]
    fn mcap_magic_is_certain_and_wins_over_the_text_gate() {
        let registry = ProviderRegistry::builtin();
        let mut bytes = b"\x89MCAP0\r\n".to_vec();
        bytes.extend_from_slice(b"time,value\n0,1\n");
        assert_eq!(registry.select_bytes(&bytes).unwrap().id(), "mcap");
    }

    #[test]
    fn short_text_files_still_load_as_csv() {
        let registry = ProviderRegistry::builtin();
        assert_eq!(registry.select_bytes(b"a,b\n1,2\n").unwrap().id(), "csv");
        assert_eq!(registry.select_bytes(b"t\tv\n0\t1\n").unwrap().id(), "csv");
        assert_eq!(
            registry
                .select_bytes(b"# note\ntime,value\n0,1\n")
                .unwrap()
                .id(),
            "csv"
        );
    }

    #[test]
    fn binary_garbage_fails_closed_instead_of_parsing_as_csv() {
        let registry = ProviderRegistry::builtin();
        let error = registry
            .select_bytes(&[0_u8, 1, 2, 3, 0xFF, 0xFE, 0x00, 0x7F])
            .unwrap_err();
        assert!(matches!(error, SelectionError::Unsupported { .. }));
        assert!(error.to_string().contains("csv"));
        assert!(error.to_string().contains("mcap"));
    }

    #[test]
    fn utf8_text_with_no_delimiter_is_still_claimed_by_csv() {
        let registry = ProviderRegistry::builtin();
        assert_eq!(
            registry
                .select_bytes("temperature\n21.5\n".as_bytes())
                .unwrap()
                .id(),
            "csv"
        );
    }
}
