//! Memory-weighted ingest admission.

use std::sync::{Arc, Condvar, Mutex};

use thiserror::Error;

const BIN_BYTES_PER_SAMPLE: usize = 16;
const AVERAGE_CELL_BYTES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BudgetConfig {
    pub working_bytes: usize,
    pub resident_bytes: usize,
}

impl BudgetConfig {
    #[must_use]
    pub fn from_available(total_bytes: usize) -> Self {
        Self {
            working_bytes: (total_bytes / 8).min(4 * 1024 * 1024 * 1024),
            resident_bytes: (total_bytes / 2).min(32 * 1024 * 1024 * 1024),
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum BudgetError {
    #[error("memory request {requested} exceeds allowance {allowance}")]
    TooLarge { requested: usize, allowance: usize },
    #[error("resident memory request {requested} exceeds available {allowance}")]
    ResidentFull { requested: usize, allowance: usize },
}

#[derive(Default)]
struct Usage {
    working: usize,
    resident: usize,
}

struct Inner {
    config: BudgetConfig,
    usage: Mutex<Usage>,
    available: Condvar,
}

#[derive(Clone)]
pub struct MemoryBudget {
    inner: Arc<Inner>,
}

impl MemoryBudget {
    #[must_use]
    pub fn new(config: BudgetConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                usage: Mutex::new(Usage::default()),
                available: Condvar::new(),
            }),
        }
    }

    /// Blocks until the working allowance can hold `bytes`.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::TooLarge`] when the request can never fit.
    pub fn acquire_working(&self, bytes: usize) -> Result<Ticket, BudgetError> {
        if bytes > self.inner.config.working_bytes {
            return Err(BudgetError::TooLarge {
                requested: bytes,
                allowance: self.inner.config.working_bytes,
            });
        }
        let mut usage = self.inner.usage.lock().expect("memory budget lock");
        while usage.working.saturating_add(bytes) > self.inner.config.working_bytes {
            usage = self
                .inner
                .available
                .wait(usage)
                .expect("memory budget lock");
        }
        usage.working += bytes;
        Ok(Ticket {
            budget: self.clone(),
            bytes,
            active: true,
        })
    }

    #[must_use]
    pub fn working_used(&self) -> usize {
        self.inner.usage.lock().expect("memory budget lock").working
    }

    #[must_use]
    pub fn resident_used(&self) -> usize {
        self.inner
            .usage
            .lock()
            .expect("memory budget lock")
            .resident
    }
}

pub struct Ticket {
    budget: MemoryBudget,
    bytes: usize,
    active: bool,
}

impl Ticket {
    #[must_use]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// # Errors
    ///
    /// Returns [`BudgetError::TooLarge`] when `actual` can never fit.
    pub fn reconcile(&mut self, actual: usize) -> Result<(), BudgetError> {
        let allowance = self.budget.inner.config.working_bytes;
        if actual > allowance {
            return Err(BudgetError::TooLarge {
                requested: actual,
                allowance,
            });
        }
        let mut usage = self.budget.inner.usage.lock().expect("memory budget lock");
        while usage.working - self.bytes + actual > allowance {
            usage = self
                .budget
                .inner
                .available
                .wait(usage)
                .expect("memory budget lock");
        }
        usage.working = usage.working - self.bytes + actual;
        self.bytes = actual;
        self.budget.inner.available.notify_all();
        Ok(())
    }

    /// # Errors
    ///
    /// Returns [`BudgetError::ResidentFull`] before any resident charge is made.
    pub fn transfer_to_resident(mut self) -> Result<ResidentCharge, BudgetError> {
        {
            let mut usage = self.budget.inner.usage.lock().expect("memory budget lock");
            if usage.resident.saturating_add(self.bytes) > self.budget.inner.config.resident_bytes {
                return Err(BudgetError::ResidentFull {
                    requested: self.bytes,
                    allowance: self
                        .budget
                        .inner
                        .config
                        .resident_bytes
                        .saturating_sub(usage.resident),
                });
            }
            usage.working -= self.bytes;
            usage.resident += self.bytes;
        }
        self.active = false;
        self.budget.inner.available.notify_all();
        Ok(ResidentCharge {
            budget: self.budget.clone(),
            bytes: self.bytes,
        })
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut usage = self.budget.inner.usage.lock().expect("memory budget lock");
        usage.working -= self.bytes;
        drop(usage);
        self.budget.inner.available.notify_all();
    }
}

pub struct ResidentCharge {
    budget: MemoryBudget,
    bytes: usize,
}

impl Drop for ResidentCharge {
    fn drop(&mut self) {
        let mut usage = self.budget.inner.usage.lock().expect("memory budget lock");
        usage.resident -= self.bytes;
        drop(usage);
        self.budget.inner.available.notify_all();
    }
}

#[must_use]
pub fn estimate_working_bytes(file_len: u64, column_count: usize) -> usize {
    let file_len = usize::try_from(file_len).unwrap_or(usize::MAX);
    let samples = file_len / column_count.max(1).saturating_mul(AVERAGE_CELL_BYTES);
    file_len
        .saturating_mul(2)
        .saturating_add(samples.saturating_mul(BIN_BYTES_PER_SAMPLE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget() -> MemoryBudget {
        MemoryBudget::new(BudgetConfig {
            working_bytes: 1_000,
            resident_bytes: 1_500,
        })
    }

    #[test]
    fn a_request_larger_than_the_whole_allowance_fails_instead_of_deadlocking() {
        assert!(matches!(
            budget().acquire_working(2_000),
            Err(BudgetError::TooLarge { .. })
        ));
    }

    #[test]
    fn reconciling_upward_beyond_the_allowance_fails_before_commit() {
        let budget = budget();
        let mut ticket = budget.acquire_working(400).unwrap();
        assert!(ticket.reconcile(900).is_ok());
        assert!(matches!(
            ticket.reconcile(2_000),
            Err(BudgetError::TooLarge { .. })
        ));
    }

    #[test]
    fn committing_moves_the_charge_from_working_to_resident_until_unload() {
        let budget = budget();
        let ticket = budget.acquire_working(600).unwrap();
        assert_eq!(budget.working_used(), 600);
        let charge = ticket.transfer_to_resident().unwrap();
        assert_eq!(budget.working_used(), 0);
        assert_eq!(budget.resident_used(), 600);
        drop(charge);
        assert_eq!(budget.resident_used(), 0);
    }

    #[test]
    fn a_second_file_waits_for_the_first_to_release() {
        let budget = std::sync::Arc::new(budget());
        let held = budget.acquire_working(800).unwrap();
        let waiter = std::thread::spawn({
            let budget = std::sync::Arc::clone(&budget);
            move || budget.acquire_working(800).map(|ticket| ticket.bytes())
        });
        std::thread::yield_now();
        drop(held);
        assert_eq!(waiter.join().unwrap().unwrap(), 800);
    }

    #[test]
    fn estimates_cover_the_file_columns_sort_copy_and_bins() {
        assert!(estimate_working_bytes(1_048_576, 4) > 1_048_576 * 2);
    }
}
