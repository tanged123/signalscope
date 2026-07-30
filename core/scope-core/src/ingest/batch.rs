use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::{
    cache::{self, CacheError},
    ingest::{
        CancelToken, DecodeContext, DecodedSignal, DecodedSource, IngestError, IngestSummary,
    },
    pyramid::Pyramid,
    sources::{Admission, SourceError, SourceRecord, SourceRegistry},
    store::SignalStore,
};

#[cfg(test)]
use super::admission::BudgetConfig;
use super::admission::{MemoryBudget, ResidentCharge, estimate_working_bytes};

pub const RECENT_FAILURE_LIMIT: usize = 16;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct JobId(pub u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BatchState {
    Running,
    Done,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileState {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileFailure {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatchStatus {
    pub state: BatchState,
    pub fraction: f64,
    pub total: u64,
    pub done: u64,
    pub failed: u64,
    pub recent_failures: Vec<FileFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchFileStatus {
    pub path: PathBuf,
    pub state: FileState,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchDetail {
    pub entries: Vec<BatchFileStatus>,
    pub total: u64,
}

struct FileEntry {
    path: PathBuf,
    state: FileState,
    error: Option<String>,
}

struct Inner {
    entries: Vec<FileEntry>,
    cancelled: bool,
}

pub struct BatchProgress {
    inner: Mutex<Inner>,
}

impl BatchProgress {
    #[must_use]
    pub fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: paths
                    .into_iter()
                    .map(|path| FileEntry {
                        path,
                        state: FileState::Pending,
                        error: None,
                    })
                    .collect(),
                cancelled: false,
            }),
        }
    }

    pub fn started(&self, index: usize) {
        self.set_state(index, FileState::Running, None);
    }

    pub fn succeeded(&self, index: usize) {
        self.set_state(index, FileState::Done, None);
    }

    pub fn failed(&self, index: usize, error: impl Into<String>) {
        self.set_state(index, FileState::Failed, Some(error.into()));
    }

    pub fn cancelled(&self, index: usize) {
        self.set_state(index, FileState::Cancelled, None);
    }

    pub fn cancel(&self) {
        self.lock().cancelled = true;
    }

    #[must_use]
    pub fn status(&self) -> BatchStatus {
        let inner = self.lock();
        let total = inner.entries.len() as u64;
        let done = count(&inner, FileState::Done);
        let failed = count(&inner, FileState::Failed);
        let cancelled = count(&inner, FileState::Cancelled);
        let settled = done + failed + cancelled;
        let running = settled < total;
        let state = if running {
            BatchState::Running
        } else if inner.cancelled && cancelled > 0 {
            BatchState::Cancelled
        } else if failed == total && total > 0 {
            BatchState::Failed
        } else if done == total {
            BatchState::Done
        } else {
            BatchState::Partial
        };
        let recent_failures = inner
            .entries
            .iter()
            .rev()
            .filter_map(|entry| {
                entry.error.as_ref().map(|error| FileFailure {
                    path: entry.path.clone(),
                    error: error.clone(),
                })
            })
            .take(RECENT_FAILURE_LIMIT)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        BatchStatus {
            state,
            fraction: if total == 0 {
                1.0
            } else {
                settled as f64 / total as f64
            },
            total,
            done,
            failed,
            recent_failures,
        }
    }

    #[must_use]
    pub fn detail(&self, offset: usize, limit: usize) -> BatchDetail {
        let inner = self.lock();
        let entries = inner
            .entries
            .iter()
            .skip(offset)
            .take(limit)
            .map(|entry| BatchFileStatus {
                path: entry.path.clone(),
                state: entry.state,
                error: entry.error.clone(),
            })
            .collect();
        BatchDetail {
            entries,
            total: inner.entries.len() as u64,
        }
    }

    #[must_use]
    pub fn is_terminal(&self) -> bool {
        self.status().state != BatchState::Running
    }

    fn set_state(&self, index: usize, state: FileState, error: Option<String>) {
        if let Some(entry) = self.lock().entries.get_mut(index) {
            entry.state = state;
            entry.error = error;
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("batch progress lock")
    }
}

fn count(inner: &Inner, state: FileState) -> u64 {
    inner
        .entries
        .iter()
        .filter(|entry| entry.state == state)
        .count() as u64
}

pub trait CommitSink: Send + Sync {
    /// # Errors
    ///
    /// Returns an ingest error without leaving partial registrations.
    fn commit(
        &self,
        record: &SourceRecord,
        decoded: DecodedSource,
        pyramids: Vec<(String, Pyramid)>,
    ) -> Result<IngestSummary, IngestError>;
}

pub struct BatchOptions {
    pub worker_count: usize,
    pub budget: Arc<MemoryBudget>,
    pub terminal_ttl: Duration,
}

impl BatchOptions {
    #[cfg(test)]
    fn for_tests() -> Self {
        Self {
            worker_count: 4,
            budget: Arc::new(MemoryBudget::new(BudgetConfig {
                working_bytes: 64 * 1024 * 1024,
                resident_bytes: 256 * 1024 * 1024,
            })),
            terminal_ttl: Duration::from_secs(60),
        }
    }
}

struct Job {
    progress: Arc<BatchProgress>,
    cancel: Arc<CancelToken>,
    finished_at: Option<Instant>,
    handles: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
enum FlightOutcome {
    Done,
    Failed(String),
    Cancelled,
}

#[derive(Default)]
struct SingleFlight {
    outcome: Mutex<Option<FlightOutcome>>,
    ready: Condvar,
}

impl SingleFlight {
    fn publish(&self, outcome: FlightOutcome) {
        *self.outcome.lock().expect("single flight lock") = Some(outcome);
        self.ready.notify_all();
    }

    fn wait(&self) -> FlightOutcome {
        let mut outcome = self.outcome.lock().expect("single flight lock");
        while outcome.is_none() {
            outcome = self.ready.wait(outcome).expect("single flight lock");
        }
        outcome.clone().expect("single flight outcome")
    }
}

struct WorkItem {
    index: usize,
    record: SourceRecord,
}

pub struct BatchJobs {
    options: BatchOptions,
    jobs: Mutex<BTreeMap<JobId, Job>>,
    registry: Arc<Mutex<SourceRegistry>>,
    flights: Arc<Mutex<BTreeMap<PathBuf, Arc<SingleFlight>>>>,
    resident: Arc<Mutex<Vec<ResidentCharge>>>,
    next_id: AtomicU64,
}

impl BatchJobs {
    #[must_use]
    pub fn new(options: BatchOptions) -> Self {
        Self {
            options,
            jobs: Mutex::new(BTreeMap::new()),
            registry: Arc::new(Mutex::new(SourceRegistry::new())),
            flights: Arc::new(Mutex::new(BTreeMap::new())),
            resident: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn submit(&self, paths: Vec<PathBuf>, sink: Arc<dyn CommitSink>) -> JobId {
        let id = JobId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let progress = Arc::new(BatchProgress::new(paths.clone()));
        let cancel = Arc::new(CancelToken::default());
        let mut work = VecDeque::new();
        {
            let mut registry = self.registry.lock().expect("source registry lock");
            for (index, path) in paths.iter().enumerate() {
                match registry.admit(path) {
                    Ok(Admission::New(record)) => work.push_back(WorkItem { index, record }),
                    Ok(Admission::Existing(key)) => {
                        let record = registry.record(key).expect("admitted source").clone();
                        work.push_back(WorkItem { index, record });
                    }
                    Err(error) => progress.failed(index, error.to_string()),
                }
            }
        }

        let queue = Arc::new(Mutex::new(work));
        self.jobs.lock().expect("batch jobs lock").insert(
            id,
            Job {
                progress: Arc::clone(&progress),
                cancel: Arc::clone(&cancel),
                finished_at: progress.is_terminal().then(Instant::now),
                handles: Vec::new(),
            },
        );

        let worker_count = self
            .options
            .worker_count
            .max(1)
            .min(queue.lock().expect("batch queue lock").len());
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let worker = Worker {
                queue: Arc::clone(&queue),
                progress: Arc::clone(&progress),
                cancel: Arc::clone(&cancel),
                registry: Arc::clone(&self.registry),
                flights: Arc::clone(&self.flights),
                resident: Arc::clone(&self.resident),
                budget: Arc::clone(&self.options.budget),
                sink: Arc::clone(&sink),
            };
            handles.push(thread::spawn(move || worker.run()));
        }
        if let Some(job) = self.jobs.lock().expect("batch jobs lock").get_mut(&id) {
            job.handles = handles;
        }
        id
    }

    /// # Errors
    ///
    /// Returns a source identity conflict.
    pub fn restore_source(&self, record: SourceRecord) -> Result<(), SourceError> {
        self.registry
            .lock()
            .expect("source registry lock")
            .restore(record)
    }

    /// # Errors
    ///
    /// Returns an identity conflict or [`SourceError::Busy`].
    pub fn replace_sources(&self, records: Vec<SourceRecord>) -> Result<(), SourceError> {
        if self
            .jobs
            .lock()
            .expect("batch jobs lock")
            .values()
            .any(|job| !job.progress.is_terminal())
        {
            return Err(SourceError::Busy);
        }
        let mut registry = SourceRegistry::new();
        for record in records {
            registry.restore(record)?;
        }
        *self.registry.lock().expect("source registry lock") = registry;
        self.flights.lock().expect("single flights lock").clear();
        self.resident.lock().expect("resident charges lock").clear();
        Ok(())
    }

    #[must_use]
    pub fn status(&self, id: JobId) -> Option<BatchStatus> {
        let mut jobs = self.jobs.lock().expect("batch jobs lock");
        let job = jobs.get_mut(&id)?;
        let status = job.progress.status();
        if status.state != BatchState::Running && job.finished_at.is_none() {
            job.finished_at = Some(Instant::now());
        }
        Some(status)
    }

    #[must_use]
    pub fn detail(&self, id: JobId, offset: usize, limit: usize) -> Option<BatchDetail> {
        self.jobs
            .lock()
            .expect("batch jobs lock")
            .get(&id)
            .map(|job| job.progress.detail(offset, limit))
    }

    pub fn cancel(&self, id: JobId) {
        if let Some(job) = self.jobs.lock().expect("batch jobs lock").get(&id) {
            job.progress.cancel();
            job.cancel.cancel();
        }
    }

    pub fn release(&self, id: JobId) {
        let Some(mut job) = self.jobs.lock().expect("batch jobs lock").remove(&id) else {
            return;
        };
        job.cancel.cancel();
        for handle in job.handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn sweep_terminal(&self, now: Instant) {
        let ttl = self.options.terminal_ttl;
        self.jobs.lock().expect("batch jobs lock").retain(|_, job| {
            if job.progress.is_terminal() && job.finished_at.is_none() {
                job.finished_at = Some(now);
            }
            job.finished_at
                .is_none_or(|finished| now.saturating_duration_since(finished) < ttl)
        });
    }

    #[must_use]
    pub fn join(&self, id: JobId) -> Option<BatchStatus> {
        let handles = {
            let mut jobs = self.jobs.lock().expect("batch jobs lock");
            std::mem::take(&mut jobs.get_mut(&id)?.handles)
        };
        for handle in handles {
            let _ = handle.join();
        }
        self.status(id)
    }

    #[cfg(test)]
    fn wait_for_tests(&self, id: JobId) -> BatchStatus {
        self.join(id).expect("batch job")
    }
}

struct Worker {
    queue: Arc<Mutex<VecDeque<WorkItem>>>,
    progress: Arc<BatchProgress>,
    cancel: Arc<CancelToken>,
    registry: Arc<Mutex<SourceRegistry>>,
    flights: Arc<Mutex<BTreeMap<PathBuf, Arc<SingleFlight>>>>,
    resident: Arc<Mutex<Vec<ResidentCharge>>>,
    budget: Arc<MemoryBudget>,
    sink: Arc<dyn CommitSink>,
}

impl Worker {
    fn run(&self) {
        while let Some(item) = self.queue.lock().expect("batch queue lock").pop_front() {
            if self.cancel.is_cancelled() {
                self.progress.cancelled(item.index);
                continue;
            }
            self.progress.started(item.index);
            let (flight, leader) = {
                let mut flights = self.flights.lock().expect("single flights lock");
                if let Some(flight) = flights.get(&item.record.path) {
                    (Arc::clone(flight), false)
                } else {
                    let flight = Arc::new(SingleFlight::default());
                    flights.insert(item.record.path.clone(), Arc::clone(&flight));
                    (flight, true)
                }
            };
            let outcome = if leader {
                let outcome = self.process(&item.record);
                flight.publish(outcome.clone());
                outcome
            } else {
                flight.wait()
            };
            match outcome {
                FlightOutcome::Done => self.progress.succeeded(item.index),
                FlightOutcome::Failed(error) => self.progress.failed(item.index, error),
                FlightOutcome::Cancelled => self.progress.cancelled(item.index),
            }
        }
    }

    fn process(&self, record: &SourceRecord) -> FlightOutcome {
        match self.prepare_and_commit(record) {
            Ok((provider, provenance, charge)) => {
                self.registry
                    .lock()
                    .expect("source registry lock")
                    .set_provenance(record.key, provider, provenance);
                self.resident
                    .lock()
                    .expect("resident charges lock")
                    .push(charge);
                FlightOutcome::Done
            }
            Err(ProcessError::Cancelled) => FlightOutcome::Cancelled,
            Err(ProcessError::Failed(error)) => FlightOutcome::Failed(error),
        }
    }

    fn prepare_and_commit(
        &self,
        record: &SourceRecord,
    ) -> Result<(String, String, ResidentCharge), ProcessError> {
        let file_len = fs::metadata(&record.path).map_err(failed)?.len();
        let mut ticket = self
            .budget
            .acquire_working(estimate_working_bytes(file_len, 1))
            .map_err(failed)?;
        let mut temporary = SignalStore::new();
        let mut decode_progress = |_| {};
        let mut context = DecodeContext {
            progress: &mut decode_progress,
            cancel: &self.cancel,
        };
        let mut stage_progress = |_, _| {};
        let outcome = cache::ingest_or_load(
            &record.path,
            &mut temporary,
            record.key,
            &record.prefix,
            &mut context,
            &mut stage_progress,
        )
        .map_err(process_cache_error)?;
        if self.cancel.is_cancelled() {
            return Err(ProcessError::Cancelled);
        }

        let decoded = DecodedSource {
            row_count: outcome.loaded.summary.row_count,
            signals: outcome
                .loaded
                .summary
                .signals
                .iter()
                .filter_map(|id| temporary.signal(*id))
                .map(|signal| DecodedSignal {
                    local_path: signal.local_path.clone(),
                    unit: signal.unit.clone(),
                    time: signal.time_shared(),
                    values: signal.values_shared(),
                })
                .collect(),
        };
        let pyramid_bytes = outcome
            .loaded
            .pyramids
            .iter()
            .map(|(_, pyramid)| pyramid_bytes(pyramid))
            .sum::<usize>();
        let pyramids = outcome
            .loaded
            .pyramids
            .into_iter()
            .filter_map(|(id, pyramid)| Some((temporary.signal(id)?.local_path.clone(), pyramid)))
            .collect();
        ticket
            .reconcile(decoded.column_bytes().saturating_add(pyramid_bytes))
            .map_err(failed)?;
        let charge = ticket.transfer_to_resident().map_err(failed)?;
        let mut committed = record.clone();
        committed.provider_id = Some(outcome.provider_id.clone());
        committed.decode_provenance = Some(outcome.provenance.clone());
        self.sink
            .commit(&committed, decoded, pyramids)
            .map_err(|error| match error {
                IngestError::Cancelled => ProcessError::Cancelled,
                error => ProcessError::Failed(error.to_string()),
            })?;
        Ok((outcome.provider_id, outcome.provenance, charge))
    }
}

enum ProcessError {
    Cancelled,
    Failed(String),
}

fn failed(error: impl ToString) -> ProcessError {
    ProcessError::Failed(error.to_string())
}

fn process_cache_error(error: CacheError) -> ProcessError {
    match error {
        CacheError::Ingest(IngestError::Cancelled) => ProcessError::Cancelled,
        error => failed(error),
    }
}

fn pyramid_bytes(pyramid: &Pyramid) -> usize {
    pyramid
        .merged_levels()
        .iter()
        .map(|level| {
            level
                .len()
                .saturating_mul(size_of::<scope_protocol::EnvelopeBin>())
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    use crate::{
        ingest::{DecodedSource, IngestError, IngestSummary, commit},
        sources::SourceRecord,
        store::SignalStore,
    };

    fn paths(count: usize) -> Vec<PathBuf> {
        (0..count)
            .map(|index| PathBuf::from(format!("{index}.csv")))
            .collect()
    }

    fn write_csv(dir: &tempfile::TempDir, index: usize) -> PathBuf {
        let path = dir.path().join(format!("{index}.csv"));
        std::fs::write(&path, "time,value\n0,1\n1,2\n").unwrap();
        path
    }

    #[derive(Default)]
    struct RecordingSink {
        store: Mutex<SignalStore>,
        max_concurrent_commits: AtomicUsize,
        in_commit: AtomicUsize,
    }

    impl CommitSink for RecordingSink {
        fn commit(
            &self,
            record: &SourceRecord,
            decoded: DecodedSource,
            _pyramids: Vec<(String, Pyramid)>,
        ) -> Result<IngestSummary, IngestError> {
            let depth = self.in_commit.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_concurrent_commits
                .fetch_max(depth, Ordering::SeqCst);
            let result = commit(
                &mut self.store.lock().expect("store lock"),
                record.key,
                &record.prefix,
                &record.path,
                decoded,
            );
            self.in_commit.fetch_sub(1, Ordering::SeqCst);
            result
        }
    }

    #[test]
    fn reports_mixed_outcomes() {
        let batch = BatchProgress::new(paths(3));
        batch.succeeded(0);
        batch.failed(1, "invalid");
        batch.succeeded(2);

        assert_eq!(
            batch.status(),
            BatchStatus {
                state: BatchState::Partial,
                fraction: 1.0,
                total: 3,
                done: 2,
                failed: 1,
                recent_failures: vec![FileFailure {
                    path: PathBuf::from("1.csv"),
                    error: "invalid".into(),
                }],
            }
        );
    }

    #[test]
    fn distinguishes_success_and_failure() {
        let failed = BatchProgress::new(paths(2));
        failed.failed(0, "bad");
        failed.failed(1, "worse");
        assert_eq!(failed.status().state, BatchState::Failed);

        let done = BatchProgress::new(paths(2));
        done.succeeded(0);
        done.succeeded(1);
        assert_eq!(done.status().state, BatchState::Done);
    }

    #[test]
    fn cancellation_waits_for_running_files() {
        let batch = BatchProgress::new(paths(3));
        batch.succeeded(0);
        batch.cancel();
        assert_eq!(batch.status().state, BatchState::Running);

        batch.cancelled(1);
        assert_eq!(batch.status().state, BatchState::Running);
        batch.cancelled(2);
        assert_eq!(batch.status().state, BatchState::Cancelled);
        assert_eq!(batch.status().done, 1);
    }

    #[test]
    fn bounds_status_failures_and_pages_details() {
        let batch = BatchProgress::new(paths(1_000));
        for index in 0..1_000 {
            batch.failed(index, "bad");
        }

        assert_eq!(batch.status().recent_failures.len(), 16);
        let detail = batch.detail(990, 20);
        assert_eq!(detail.entries.len(), 10);
        assert_eq!(detail.total, 1_000);
    }

    #[test]
    fn one_bad_file_does_not_abort_the_batch() {
        let dir = tempfile::tempdir().unwrap();
        let good: Vec<_> = (0..8).map(|index| write_csv(&dir, index)).collect();
        let bad = dir.path().join("bad.csv");
        std::fs::write(&bad, "").unwrap();
        let mut paths = good;
        paths.insert(4, bad);

        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        let job = jobs.submit(paths, std::sync::Arc::clone(&sink) as _);
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.state, BatchState::Partial);
        assert_eq!((status.done, status.failed), (8, 1));
        assert_eq!(sink.store.lock().unwrap().sources().count(), 8);
    }

    #[test]
    fn duplicate_paths_join_one_flight() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_csv(&dir, 0);
        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        let job = jobs.submit(vec![path.clone(), path.clone(), path], sink.clone());
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.done, 3);
        assert_eq!(sink.store.lock().unwrap().sources().count(), 1);
    }

    #[test]
    fn cancelling_keeps_committed_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = (0..64).map(|index| write_csv(&dir, index)).collect();
        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions {
            worker_count: 1,
            ..BatchOptions::for_tests()
        });
        let job = jobs.submit(paths, sink.clone());
        jobs.cancel(job);
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.state, BatchState::Cancelled);
        assert!(status.done < 64);
        assert_eq!(
            sink.store.lock().unwrap().sources().count(),
            status.done as usize
        );
    }

    #[test]
    fn terminal_jobs_expire_and_can_be_released() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = BatchJobs::new(BatchOptions {
            terminal_ttl: Duration::ZERO,
            ..BatchOptions::for_tests()
        });
        let sink = std::sync::Arc::new(RecordingSink::default());
        let job = jobs.submit(vec![write_csv(&dir, 0)], sink);
        jobs.wait_for_tests(job);
        jobs.sweep_terminal(Instant::now());
        assert!(jobs.status(job).is_none());

        let job = jobs.submit(
            vec![write_csv(&dir, 1)],
            std::sync::Arc::new(RecordingSink::default()),
        );
        jobs.wait_for_tests(job);
        jobs.release(job);
        assert!(jobs.status(job).is_none());
    }

    #[test]
    fn restored_identity_is_used_by_the_batch() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_csv(&dir, 0).canonicalize().unwrap();
        let record = SourceRecord {
            key: crate::store::SourceKey(uuid::Uuid::from_bytes([8; 16])),
            path: path.clone(),
            prefix: "saved".into(),
            provider_id: None,
            decode_provenance: None,
            reconcile_legacy: true,
        };
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        jobs.replace_sources(vec![record.clone()]).unwrap();
        let sink = std::sync::Arc::new(RecordingSink::default());
        let job = jobs.submit(vec![path], sink.clone());
        assert_eq!(jobs.wait_for_tests(job).state, BatchState::Done);
        let store = sink.store.lock().unwrap();
        assert_eq!(store.sources().next().unwrap().key, record.key);
        assert!(store.signal_by_path("saved/value").is_some());
    }
}
