use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    cache::CacheRoot,
    ensemble::{self, Limits},
    ingest::{
        DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget},
        batch::{BatchJobs, BatchOptions, BatchState, CommitSink},
    },
    pyramid::{FINEST_STORED_LEVEL, Pyramid},
    sets::{AffineTransform, SchemaFingerprint, SetId, SetKey, SetMember, SourceSet, TimeDomain},
    sources::SourceRecord,
    store::{SignalId, SignalStore, SourceId, SourceKey},
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
fn bench_ensemble_queries_at_sixty_four_and_one_thousand_members() {
    let (set_64, store_64, pyramids_64) = ensemble_data(64);
    let started = Instant::now();
    ensemble::query(
        &set_64,
        "value",
        &store_64,
        &pyramids_64,
        (0.0, 127.0),
        800,
        None,
        Limits { max_members: 64 },
    )
    .unwrap();
    let query_64 = started.elapsed();

    let (set_1000, store_1000, pyramids_1000) = ensemble_data(1_000);
    let directory = tempfile::tempdir().unwrap();
    let materialized = ensemble::materialize(
        &set_1000,
        &store_1000,
        &pyramids_1000,
        &CacheRoot::app_owned(directory.path()),
    )
    .unwrap();
    let iterations = 1_000;
    let started = Instant::now();
    for _ in 0..iterations {
        ensemble::query_with_materialization(
            &set_1000,
            "value",
            &store_1000,
            &pyramids_1000,
            (0.0, 127.0),
            800,
            None,
            Limits::default(),
            Some(&materialized),
        )
        .unwrap();
    }
    let query_1000 = started.elapsed() / iterations;

    println!(
        "bench_ensemble query_64_ms={:.3} query_1000_ms={:.3}",
        query_64.as_secs_f64() * 1_000.0,
        query_1000.as_secs_f64() * 1_000.0
    );
    assert!(query_64 < Duration::from_millis(250));
    assert!(query_1000 < Duration::from_millis(250));
}

#[allow(clippy::cast_precision_loss)]
fn ensemble_data(count: u64) -> (SourceSet, SignalStore, BTreeMap<SignalId, Pyramid>) {
    let local_paths = BTreeSet::from(["value".to_owned()]);
    let mut members = BTreeMap::new();
    let mut store = SignalStore::new();
    let mut pyramids = BTreeMap::new();
    for index in 0..count {
        let key = SourceKey(uuid::Uuid::from_u128(u128::from(index + 1)));
        members.insert(
            key,
            SetMember {
                source_key: key,
                local_paths: local_paths.clone(),
                missing: BTreeSet::new(),
                time_domain: TimeDomain::default(),
                transform: Some(AffineTransform {
                    scale: 1.0,
                    offset: 0.0,
                }),
            },
        );
        let source = store
            .register_source(format!("{index}.csv"), key, format!("r{index}"))
            .unwrap();
        let time = Arc::from((0..128).map(f64::from).collect::<Vec<_>>());
        let values = (0..128)
            .map(|sample| (f64::from(sample) * 0.1 + index as f64).sin())
            .collect::<Vec<_>>();
        let signal = store
            .insert_signal(source, "value", None, time, values)
            .unwrap();
        pyramids.insert(signal, Pyramid::from_signal(store.signal(signal).unwrap()));
    }
    (
        SourceSet {
            key: SetKey(uuid::Uuid::from_u128(1)),
            id: SetId(1),
            label: "benchmark".into(),
            fingerprint: SchemaFingerprint { local_paths },
            members,
            generation: 1,
        },
        store,
        pyramids,
    )
}
