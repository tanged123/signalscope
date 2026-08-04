use std::{
    io::{BufWriter, Write as _},
    ops::Range,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug)]
pub struct TierSpec {
    pub name: &'static str,
    pub files: u32,
    pub rows: u32,
    pub hz: f64,
    pub channels: &'static [&'static str],
    pub nan_every: u32,
    pub nan_rows: Range<u32>,
}

pub fn mc1000() -> TierSpec {
    TierSpec {
        name: "mc1000",
        files: 1000,
        rows: 10_000,
        hz: 10.0,
        channels: &[
            "command",
            "response",
            "temperature",
            "pressure",
            "vibration",
        ],
        nan_every: 20,
        nan_rows: 4000..4200,
    }
}

pub fn wide100m() -> TierSpec {
    TierSpec {
        name: "wide100m",
        files: 1,
        rows: 12_500_000,
        hz: 1000.0,
        channels: &["ch0", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7"],
        nan_every: 1,
        nan_rows: 4_000_000..4_002_000,
    }
}

pub fn bench_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/bench")
}

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);

const GENERATOR_VERSION: u32 = 2;

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2_685_821_657_736_338_717).max(1))
    }

    #[allow(clippy::cast_precision_loss)]
    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1_u64 << 53) as f64
    }
}

#[allow(clippy::cast_precision_loss)]
fn sample(file: u32, channel: usize, time: f64, noise: f64) -> f64 {
    let run = f64::from(file);
    let lane = channel as f64;
    let gain = 0.9 + run * 0.000_21 + lane * 0.05;
    let damping = 0.6 + run * 0.000_35;
    let phase = run * 0.017 + lane * 1.3;
    gain * (1.0 - (-damping * time * 0.01).exp())
        * (1.0 + 0.2 * (time * (0.8 + lane * 0.11) + phase).sin())
        + 0.01 * noise
}

pub fn generate(spec: &TierSpec, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for file in 1..=spec.files {
        let path = dir.join(format!("run_{file:04}.csv"));
        let mut writer = BufWriter::new(std::fs::File::create(path)?);
        writeln!(writer, "time,{}", spec.channels.join(","))?;
        let mut rng = Rng::new(u64::from(file) * 1_000_003);
        let gap = spec.nan_every != 0 && file % spec.nan_every == 0;
        for row in 0..=spec.rows {
            let time = f64::from(row) / spec.hz;
            write!(writer, "{time:.4}")?;
            for (channel, _) in spec.channels.iter().enumerate() {
                let noise = rng.next_f64();
                if gap && channel == 1 && spec.nan_rows.contains(&row) {
                    write!(writer, ",NaN")?;
                } else {
                    write!(writer, ",{:.6}", sample(file, channel, time, noise))?;
                }
            }
            writeln!(writer)?;
        }
        writer.flush()?;
    }
    Ok(())
}

static GENERATION: Mutex<()> = Mutex::new(());

pub fn ensure(spec: &TierSpec) -> PathBuf {
    let _guard = GENERATION.lock().unwrap();
    let dir = bench_root().join("corpus").join(spec.name);
    let manifest = dir.join("manifest.json");
    let stamp = serde_json::json!({
        "generator": GENERATOR_VERSION,
        "spec": format!("{spec:?}"),
    })
    .to_string();
    if std::fs::read_to_string(&manifest).is_ok_and(|existing| existing == stamp) {
        return dir;
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    generate(spec, &dir).unwrap();
    std::fs::write(&manifest, stamp).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> TierSpec {
        TierSpec {
            name: "tiny",
            files: 3,
            rows: 100,
            hz: 10.0,
            channels: &["command", "response"],
            nan_every: 2,
            nan_rows: 40..50,
        }
    }

    #[test]
    fn generation_is_byte_stable() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        generate(&tiny(), a.path()).unwrap();
        generate(&tiny(), b.path()).unwrap();
        for index in 1..=3u32 {
            let name = format!("run_{index:04}.csv");
            assert_eq!(
                std::fs::read(a.path().join(&name)).unwrap(),
                std::fs::read(b.path().join(&name)).unwrap(),
                "{name} differs between runs"
            );
        }
    }

    #[test]
    fn rng_values_are_normalized() {
        let mut rng = Rng::new(7);
        for _ in 0..10_000 {
            let value = rng.next_f64();
            assert!((0.0..1.0).contains(&value), "noise={value}");
        }
    }

    #[test]
    fn files_have_expected_shape() {
        let dir = tempfile::tempdir().unwrap();
        generate(&tiny(), dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("run_0001.csv")).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("time,command,response"));
        assert_eq!(lines.count(), 101);
    }

    #[test]
    fn nan_window_lands_only_in_selected_files() {
        let dir = tempfile::tempdir().unwrap();
        generate(&tiny(), dir.path()).unwrap();
        let with_gap = std::fs::read_to_string(dir.path().join("run_0002.csv")).unwrap();
        let without = std::fs::read_to_string(dir.path().join("run_0001.csv")).unwrap();
        assert!(with_gap.contains("NaN"));
        assert!(!without.contains("NaN"));
        let gap_lines: Vec<usize> = with_gap
            .lines()
            .enumerate()
            .filter(|(_, line)| line.contains("NaN"))
            .map(|(number, _)| number)
            .collect();
        assert_eq!(gap_lines.first(), Some(&41));
        assert_eq!(gap_lines.last(), Some(&50));
    }

    #[test]
    fn manifest_does_not_match_a_provider_extension() {
        // Folder imports admit every provider extension (.txt included); the
        // manifest must never be picked up as a source alongside the runs.
        let dir = ensure(&tiny());
        assert!(dir.join("manifest.json").exists());
        let extensions: Vec<String> = crate::ingest::registry::ProviderRegistry::builtin()
            .descriptors()
            .iter()
            .flat_map(|descriptor| descriptor.extensions.clone())
            .collect();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let extension = path.extension().unwrap().to_str().unwrap().to_lowercase();
            if extension != "csv" {
                assert!(
                    !extensions.contains(&extension),
                    "{} would be ingested by a folder scan",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn ensure_reuses_existing_corpus() {
        let first = ensure(&tiny());
        let marker = first.join("run_0001.csv");
        let mtime = std::fs::metadata(&marker).unwrap().modified().unwrap();
        let second = ensure(&tiny());
        assert_eq!(first, second);
        assert_eq!(
            std::fs::metadata(&marker).unwrap().modified().unwrap(),
            mtime
        );
    }
}
