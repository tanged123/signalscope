use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    ingest::{
        DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget},
        batch::{BatchJobs, BatchOptions, BatchState, CommitSink},
        registry::ProviderRegistry,
    },
    pyramid::{FINEST_STORED_LEVEL, Pyramid},
    sources::SourceRecord,
    store::SourceId,
};

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
