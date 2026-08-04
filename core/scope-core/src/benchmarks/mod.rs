use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::{
    ingest::{
        self, CancelToken, DecodeContext, DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget},
        batch::{BatchJobs, BatchOptions, BatchState, CommitSink},
        registry::ProviderRegistry,
    },
    pyramid::{FINEST_STORED_LEVEL, Pyramid},
    sources::SourceRecord,
    store::{SignalStore, SourceId, SourceKey},
};

mod corpus;
mod report;

struct StoreSink {
    store: Mutex<SignalStore>,
    pyramids: Mutex<BTreeMap<(SourceId, String), Pyramid>>,
}

impl StoreSink {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            store: Mutex::new(SignalStore::new()),
            pyramids: Mutex::new(BTreeMap::new()),
        })
    }
}

impl CommitSink for StoreSink {
    fn commit(
        &self,
        record: &SourceRecord,
        decoded: DecodedSource,
        pyramids: Vec<(String, Pyramid)>,
    ) -> Result<IngestSummary, IngestError> {
        let mut store = self.store.lock().unwrap();
        let row_count = decoded.row_count;
        let signals = decoded.signals;
        let (source_id, signal_ids) = store.transaction(|store| {
            let source_id =
                store.register_source(&record.path, record.key, record.prefix.clone())?;
            let mut signal_ids = Vec::with_capacity(signals.len());
            for signal in signals {
                signal_ids.push(store.insert_signal(
                    source_id,
                    signal.local_path,
                    signal.unit,
                    signal.time,
                    signal.values,
                )?);
            }
            Ok::<_, crate::store::StoreError>((source_id, signal_ids))
        })?;
        let mut stored_pyramids = self.pyramids.lock().unwrap();
        for (local_path, pyramid) in pyramids {
            stored_pyramids.insert((source_id, local_path), pyramid);
        }
        Ok(IngestSummary {
            source_id,
            row_count,
            signals: signal_ids,
        })
    }
}

fn batch_options(cache_directory: Option<PathBuf>) -> BatchOptions {
    BatchOptions {
        worker_count: 8,
        budget: Arc::new(MemoryBudget::new(BudgetConfig {
            working_bytes: 512 * 1024 * 1024,
            // StoreSink retains every source and pyramid for the scenario queries.
            resident_bytes: 2 * 1024 * 1024 * 1024,
        })),
        terminal_ttl: Duration::from_secs(60),
        cache_directory,
        recipe_directory: None,
        provider_registry: Arc::new(ProviderRegistry::builtin()),
    }
}

fn corpus_paths(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            (path.extension().is_some_and(|ext| ext == "csv")).then_some(path)
        })
        .collect();
    paths.sort();
    paths
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_compacted_bins_stay_below_twenty_bytes_per_sample() {
    let samples = 1_000_000_u32;
    let time = (0..samples).map(f64::from).collect::<Vec<_>>();
    let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &values);
    let bytes = pyramid.stored_bin_count() * crate::bins::BinLevel::BYTES_PER_BIN;
    let bytes_per_sample = bytes as f64 / f64::from(samples);

    println!("bench_bins bytes_per_sample={bytes_per_sample:.3} cutoff={FINEST_STORED_LEVEL}");
    assert!(bytes_per_sample <= 20.0);
}

struct Sink;

impl CommitSink for Sink {
    fn commit(
        &self,
        _record: &SourceRecord,
        decoded: DecodedSource,
        _pyramids: Vec<(String, Pyramid)>,
    ) -> Result<IngestSummary, IngestError> {
        Ok(IngestSummary {
            source_id: SourceId(1),
            row_count: decoded.row_count,
            signals: Vec::new(),
        })
    }
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_batch_ingests_one_thousand_synthetic_runs() {
    let directory = tempfile::tempdir().unwrap();
    let paths = (0..1_000)
        .map(|index| {
            let path = directory.path().join(format!("run-{index}.csv"));
            std::fs::write(&path, "time,value\n0,1\n1,2\n2,3\n3,4\n").unwrap();
            path
        })
        .collect();
    let jobs = BatchJobs::new(BatchOptions {
        worker_count: 8,
        budget: Arc::new(MemoryBudget::new(BudgetConfig {
            working_bytes: 512 * 1024 * 1024,
            resident_bytes: 1024 * 1024 * 1024,
        })),
        terminal_ttl: Duration::from_secs(60),
        cache_directory: None,
        recipe_directory: None,
        provider_registry: Arc::new(ProviderRegistry::builtin()),
    });

    let started = Instant::now();
    let id = jobs.submit(paths, Arc::new(Sink));
    let status = jobs.join(id).unwrap();
    let elapsed = started.elapsed();
    let runs_per_second = 1_000.0 / elapsed.as_secs_f64();

    println!("bench_batch runs_per_second={runs_per_second:.1}");
    assert_eq!(status.state, BatchState::Done);
    assert!(runs_per_second >= 10.0);
}

#[test]
#[ignore = "release benchmark"]
fn bench_corpus_mc1000() {
    let started = Instant::now();
    let dir = corpus::ensure(&corpus::mc1000());
    println!(
        "bench_corpus_mc1000 dir={} seconds={:.1}",
        dir.display(),
        started.elapsed().as_secs_f64()
    );
}

#[test]
#[ignore = "release benchmark"]
fn bench_corpus_wide100m() {
    let started = Instant::now();
    let dir = corpus::ensure(&corpus::wide100m());
    println!(
        "bench_corpus_wide100m dir={} seconds={:.1}",
        dir.display(),
        started.elapsed().as_secs_f64()
    );
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_mc_cold_open() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache = tempfile::tempdir().unwrap();
    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache.path().to_path_buf())));

    let started = Instant::now();
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    let status = jobs.join(id).unwrap();
    let ingest_seconds = started.elapsed().as_secs_f64();
    assert_eq!(status.state, BatchState::Done, "batch status: {status:?}");

    let pyramids = sink.pyramids.lock().unwrap();
    let query_started = Instant::now();
    let mut series = 0_u32;
    for ((_, local_path), pyramid) in pyramids.iter() {
        if local_path == "response" {
            let query = pyramid.query(0.0, 1000.0, 1920);
            assert!(!query.bins.is_empty());
            series += 1;
        }
    }
    let first_window_ms = query_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(series, 1000);

    let total_seconds = ingest_seconds + first_window_ms / 1000.0;
    report::write_report(
        "mc_cold_open",
        serde_json::json!({
            "bench": "mc_cold_open",
            "ingest_seconds": ingest_seconds,
            "first_window_ms": first_window_ms,
            "total_seconds": total_seconds,
            "target_seconds": 30.0,
            "floor_seconds": 60.0,
            "pass": total_seconds <= 60.0,
        }),
    );
    assert!(
        total_seconds <= 60.0,
        "cold open took {total_seconds:.1}s (floor 60s)"
    );
}

#[test]
#[ignore = "release benchmark"]
fn bench_mc_warm_reopen() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let warmup = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir.clone())));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&warmup) as Arc<dyn CommitSink>,
    );
    assert_eq!(
        jobs.join(id).unwrap().state,
        BatchState::Done,
        "batch status after warmup"
    );
    drop(warmup);

    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let started = Instant::now();
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    let status = jobs.join(id).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    assert_eq!(status.state, BatchState::Done, "batch status: {status:?}");

    let store = sink.store.lock().unwrap();
    let paged = store.signals().filter(|signal| signal.is_paged()).count();
    let total = store.signals().count();
    assert_eq!(
        paged, total,
        "warm reopen decoded signals instead of paging"
    );

    report::write_report(
        "mc_warm_reopen",
        serde_json::json!({
            "bench": "mc_warm_reopen",
            "seconds": seconds,
            "paged_signals": paged,
            "target_seconds": 5.0,
            "floor_seconds": 15.0,
            "pass": seconds <= 15.0,
        }),
    );
    assert!(
        seconds <= 15.0,
        "warm reopen took {seconds:.1}s (floor 15s)"
    );
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_huge_cold_build() {
    let dir = corpus::ensure(&corpus::wide100m());
    let path = dir.join("run_0001.csv");
    let mut store = SignalStore::new();
    let registry = ProviderRegistry::builtin();
    let cancel = CancelToken::default();
    let mut progress = |_| {};
    let mut context = DecodeContext {
        progress: &mut progress,
        cancel: &cancel,
    };

    let started = Instant::now();
    let summary = ingest::ingest_path(
        &registry,
        &path,
        &mut store,
        SourceKey(uuid::Uuid::from_bytes([7; 16])),
        "wide100m",
        &mut context,
    )
    .unwrap();
    let mut bins = 0_usize;
    for id in &summary.signals {
        let pyramid = Pyramid::from_signal(store.signal(*id).unwrap());
        bins += pyramid.stored_bin_count();
        let query = pyramid.query(0.0, 12_500.0, 1920);
        assert!(!query.bins.is_empty());
    }
    let seconds = started.elapsed().as_secs_f64();
    let samples = summary.row_count as f64 * 8.0;
    let samples_per_second = samples / seconds;

    report::write_report(
        "huge_cold_build",
        serde_json::json!({
            "bench": "huge_cold_build",
            "seconds": seconds,
            "samples_per_second": samples_per_second,
            "stored_bins": bins,
            "target_samples_per_second": 5_000_000.0,
            "floor_samples_per_second": 2_000_000.0,
            "pass": samples_per_second >= 2_000_000.0,
        }),
    );
    assert!(
        samples_per_second >= 2_000_000.0,
        "built {samples_per_second:.0} samples/s (floor 2M)"
    );
}

fn latency_windows(end: f64, spans: &[f64]) -> Vec<(f64, f64)> {
    let mut windows = Vec::new();
    for &span in spans {
        let max_start = (end - span).max(0.0);
        for index in 0..28 {
            let t0 = max_start * f64::from(index) / 27.0;
            windows.push((t0, t0 + span));
        }
    }
    windows
}

#[test]
#[ignore = "release benchmark"]
fn bench_tile_latency() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let warmup = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir.clone())));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&warmup) as Arc<dyn CommitSink>,
    );
    assert_eq!(
        jobs.join(id).unwrap().state,
        BatchState::Done,
        "batch status after warmup"
    );
    drop(warmup);

    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    assert_eq!(
        jobs.join(id).unwrap().state,
        BatchState::Done,
        "batch status: {:?}",
        jobs.status(id)
    );

    let store = sink.store.lock().unwrap();
    let paged = store.signals().filter(|signal| signal.is_paged()).count();
    let total = store.signals().count();
    assert_eq!(paged, total, "tile latency reopened decoded signals");
    drop(store);

    let pyramids = sink.pyramids.lock().unwrap();
    let ensemble: Vec<&Pyramid> = pyramids
        .iter()
        .filter_map(|((_, local_path), pyramid)| (local_path == "response").then_some(pyramid))
        .collect();
    assert_eq!(ensemble.len(), 1000);

    let windows = latency_windows(1000.0, &[1000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0]);

    let mut refresh_ms: Vec<f64> = windows
        .iter()
        .map(|&(t0, t1)| {
            let started = Instant::now();
            for pyramid in &ensemble {
                let query = pyramid.query(t0, t1, 1920);
                std::hint::black_box(query.bins.len());
            }
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    refresh_ms.sort_by(f64::total_cmp);
    let (p50, p95, p99) = (
        report::percentile(&refresh_ms, 0.50),
        report::percentile(&refresh_ms, 0.95),
        report::percentile(&refresh_ms, 0.99),
    );

    report::write_report(
        "tile_latency",
        serde_json::json!({
            "bench": "tile_latency",
            "refreshes": refresh_ms.len(),
            "series_per_refresh": 1000,
            "p50_ms": p50,
            "p95_ms": p95,
            "p99_ms": p99,
            "target_p95_ms": 10.0,
            "floor_p95_ms": 20.0,
            "floor_p99_ms": 50.0,
            "pass": p95 <= 20.0 && p99 <= 50.0,
        }),
    );
    assert!(p95 <= 20.0, "refresh p95 {p95:.2}ms (floor 20ms)");
    assert!(p99 <= 50.0, "refresh p99 {p99:.2}ms (floor 50ms)");
}

#[test]
#[ignore = "release benchmark"]
fn bench_warm_tile_latency() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let warmup = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir.clone())));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&warmup) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);
    drop(warmup);

    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);

    let pyramids = sink.pyramids.lock().unwrap();
    let ensemble: Vec<&Pyramid> = pyramids
        .iter()
        .filter_map(|((_, local_path), pyramid)| (local_path == "response").then_some(pyramid))
        .collect();
    assert_eq!(ensemble.len(), 1000);
    let paged_levels: usize = ensemble.iter().map(|p| p.paged_level_count()).sum();
    assert!(paged_levels > 0, "warm reopen produced no paged levels");

    let windows = latency_windows(1000.0, &[1000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0]);
    let mut refresh_ms: Vec<f64> = windows
        .iter()
        .map(|&(t0, t1)| {
            let started = Instant::now();
            for pyramid in &ensemble {
                std::hint::black_box(pyramid.query(t0, t1, 1920).bins.len());
            }
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    refresh_ms.sort_by(f64::total_cmp);
    report::write_report(
        "warm_tile_latency",
        serde_json::json!({
            "bench": "warm_tile_latency",
            "refreshes": refresh_ms.len(),
            "series_per_refresh": 1000,
            "paged_levels": paged_levels,
            "p50_ms": report::percentile(&refresh_ms, 0.50),
            "p95_ms": report::percentile(&refresh_ms, 0.95),
            "p99_ms": report::percentile(&refresh_ms, 0.99),
            "target_p95_ms": 10.0,
            "floor_p95_ms": null,
            "pass": true,
        }),
    );
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_tile_wire_cost() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(None));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);

    let pyramids = sink.pyramids.lock().unwrap();
    let series: Vec<scope_protocol::SignalTile> = pyramids
        .iter()
        .filter(|((_, local_path), _)| local_path == "response")
        .enumerate()
        .map(|(index, (_, pyramid))| {
            let query = pyramid.query(0.0, 1000.0, 1920);
            scope_protocol::SignalTile {
                signal_id: index as u64,
                signal_path: format!("run_{index:04}/response"),
                unit: None,
                level: query.level,
                bins: query.bins,
            }
        })
        .collect();
    assert_eq!(series.len(), 1000);
    let response = scope_protocol::TileResponse {
        request_id: "bench".into(),
        series,
    };

    let started = Instant::now();
    let json = serde_json::to_string(&response).unwrap();
    let json_encode_ms = started.elapsed().as_secs_f64() * 1000.0;
    report::write_report(
        "tile_wire_cost",
        serde_json::json!({
            "bench": "tile_wire_cost",
            "series": 1000,
            "bins": response.series.iter().map(|s| s.bins.len()).sum::<usize>(),
            "json_bytes": json.len(),
            "json_encode_ms": json_encode_ms,
            "pass": true,
        }),
    );
    std::hint::black_box(json.len());
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_wide_tile_latency() {
    let dir = corpus::ensure(&corpus::wide100m());
    let path = dir.join("run_0001.csv");
    let mut store = SignalStore::new();
    let registry = ProviderRegistry::builtin();
    let cancel = CancelToken::default();
    let mut progress = |_| {};
    let mut context = DecodeContext {
        progress: &mut progress,
        cancel: &cancel,
    };
    let summary = ingest::ingest_path(
        &registry,
        &path,
        &mut store,
        SourceKey(uuid::Uuid::from_bytes([8; 16])),
        "wide100m",
        &mut context,
    )
    .unwrap();
    let pyramids: Vec<Pyramid> = summary
        .signals
        .iter()
        .map(|id| Pyramid::from_signal(store.signal(*id).unwrap()))
        .collect();
    assert_eq!(pyramids.len(), 8);

    let windows = latency_windows(
        12_500.0,
        &[
            12_500.0, 3_000.0, 1_000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0,
        ],
    );
    let mut refresh_ms: Vec<f64> = windows
        .iter()
        .map(|&(t0, t1)| {
            let started = Instant::now();
            for pyramid in &pyramids {
                let query = pyramid.query(t0, t1, 1920);
                std::hint::black_box(query.bins.len());
            }
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    refresh_ms.sort_by(f64::total_cmp);
    let (p50, p95, p99) = (
        report::percentile(&refresh_ms, 0.50),
        report::percentile(&refresh_ms, 0.95),
        report::percentile(&refresh_ms, 0.99),
    );

    report::write_report(
        "wide_tile_latency",
        serde_json::json!({
            "bench": "wide_tile_latency",
            "refreshes": refresh_ms.len(),
            "series_per_refresh": pyramids.len(),
            "sample_count": summary.row_count,
            "p50_ms": p50,
            "p95_ms": p95,
            "p99_ms": p99,
            "target_p95_ms": 10.0,
            "floor_p95_ms": 20.0,
            "floor_p99_ms": 50.0,
            "pass": p95 <= 20.0 && p99 <= 50.0,
        }),
    );
    assert!(p95 <= 20.0, "wide refresh p95 {p95:.2}ms (floor 20ms)");
    assert!(p99 <= 50.0, "wide refresh p99 {p99:.2}ms (floor 50ms)");
}

#[test]
#[ignore = "release benchmark"]
fn bench_nan_gap_scale() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let registry = ProviderRegistry::builtin();
    for (name, expect_gap) in [("run_0020.csv", true), ("run_0001.csv", false)] {
        let mut store = SignalStore::new();
        let cancel = CancelToken::default();
        let mut progress = |_| {};
        let mut context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };
        let summary = ingest::ingest_path(
            &registry,
            corpus.join(name),
            &mut store,
            SourceKey(uuid::Uuid::from_bytes([9; 16])),
            "gapcheck",
            &mut context,
        )
        .unwrap();
        let response = summary
            .signals
            .iter()
            .map(|id| store.signal(*id).unwrap())
            .find(|signal| signal.path.ends_with("response"))
            .unwrap();
        let pyramid = Pyramid::from_signal(response);
        for level in 0..pyramid.level_count() {
            let bins = pyramid.level(level).unwrap();
            let has_gap = bins.iter().any(|bin| bin.has_gap);
            assert_eq!(has_gap, expect_gap, "{name} level {level}");
            let finite = bins.iter().filter_map(|bin| bin.min).all(f64::is_finite)
                && bins.iter().filter_map(|bin| bin.max).all(f64::is_finite);
            assert!(finite, "{name} level {level} has non-finite extrema");
        }
    }
    report::write_report(
        "nan_gap_scale",
        serde_json::json!({ "bench": "nan_gap_scale", "pass": true }),
    );
}

#[test]
fn latency_ladder_covers_each_zoom_span() {
    let spans = [
        12_500.0, 3_000.0, 1_000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0,
    ];
    let windows = latency_windows(12_500.0, &spans);
    assert_eq!(windows.len(), spans.len() * 28);
    for (span_windows, &span) in windows.chunks(28).zip(spans.iter()) {
        assert!(span_windows.first().unwrap().0.abs() < f64::EPSILON);
        assert!((span_windows.first().unwrap().1 - span).abs() < f64::EPSILON);
        assert!((span_windows.last().unwrap().1 - 12_500.0).abs() < f64::EPSILON);
    }
}

#[test]
fn workspace_fixtures_load_at_current_schema() {
    for (name, span) in [("mc1000", 1000.0), ("smoke", 10.0)] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../examples/bench/{name}.workspace.json"));
        let session = crate::session::load_from_path(&path).unwrap();
        assert_eq!(session.tabs.len(), 1, "{name}");
        assert_eq!(session.tabs[0].panels.len(), 2, "{name}");
        assert!(
            (session.linked_time.t1 - span).abs() < f64::EPSILON,
            "{name}"
        );
    }
}
