use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn paths(count: usize) -> Vec<PathBuf> {
        (0..count)
            .map(|index| PathBuf::from(format!("{index}.csv")))
            .collect()
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
}
