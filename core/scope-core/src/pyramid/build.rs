use super::{
    Arc, BinLevel, CachedBinLevel, Column, ColumnPair, EnvelopeBin, FINEST_STORED_LEVEL, OnceLock,
    Pyramid, PyramidColumns, Signal,
};

pub(super) fn sample_bin(time: f64, value: f64) -> EnvelopeBin {
    let finite = value.is_finite().then_some(value);
    EnvelopeBin {
        t0: time,
        t1: time,
        first: finite,
        last: finite,
        min: finite,
        max: finite,
        sum: finite.unwrap_or(0.0),
        sum_sq: finite.map_or(0.0, |value| value * value),
        finite_count: u64::from(value.is_finite()),
        sample_count: 1,
        has_gap: !value.is_finite(),
    }
}

pub(super) fn merge_bins(left: &EnvelopeBin, right: &EnvelopeBin) -> EnvelopeBin {
    EnvelopeBin {
        t0: left.t0,
        t1: right.t1,
        first: left.first.or(right.first),
        last: right.last.or(left.last),
        min: min_option(left.min, right.min),
        max: max_option(left.max, right.max),
        sum: left.sum + right.sum,
        sum_sq: left.sum_sq + right.sum_sq,
        finite_count: left.finite_count + right.finite_count,
        sample_count: left.sample_count + right.sample_count,
        has_gap: left.has_gap || right.has_gap,
    }
}

impl Pyramid {
    #[must_use]
    pub fn from_signal(signal: &Signal) -> Self {
        let time = signal.time();
        let values = signal.values();
        Self::build(
            &time,
            &values,
            FINEST_STORED_LEVEL,
            PyramidColumns::Weak {
                time: signal.time_column().downgrade(),
                values: signal.values_column().downgrade(),
            },
        )
    }

    #[must_use]
    /// Builds an envelope pyramid from equal-length time and value columns.
    ///
    /// # Panics
    ///
    /// Panics when `time` and `values` have different lengths.
    pub fn from_samples(time: &[f64], values: &[f64]) -> Self {
        let time = Arc::from(time.to_vec());
        let values = Arc::from(values.to_vec());
        Self::from_columns(&time, &values)
    }

    fn from_columns(time: &Arc<[f64]>, values: &Arc<[f64]>) -> Self {
        Self::from_columns_with_cutoff(time, values, FINEST_STORED_LEVEL)
    }

    fn from_columns_with_cutoff(
        time: &Arc<[f64]>,
        values: &Arc<[f64]>,
        first_stored_level: usize,
    ) -> Self {
        let columns = PyramidColumns::Retained {
            time: Column::owned(Arc::clone(time)),
            values: Column::owned(Arc::clone(values)),
        };
        Self::build(time, values, first_stored_level, columns)
    }

    fn build(
        time: &[f64],
        values: &[f64],
        first_stored_level: usize,
        columns: PyramidColumns,
    ) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        let level_one: Vec<EnvelopeBin> = time
            .chunks(2)
            .zip(values.chunks(2))
            .map(|(chunk_time, chunk_values)| {
                let first = sample_bin(chunk_time[0], chunk_values[0]);
                if chunk_time.len() == 2 {
                    merge_bins(&first, &sample_bin(chunk_time[1], chunk_values[1]))
                } else {
                    first
                }
            })
            .collect();
        let mut merged = Vec::new();
        let mut logical_level = 1;
        let mut previous = BinLevel::from_wire(&level_one);
        while !previous.is_empty() {
            if logical_level >= first_stored_level {
                merged.push(CachedBinLevel::Resident(Box::new(previous.clone())));
            }
            if previous.len() == 1 {
                break;
            }
            previous = merge_level(&previous);
            logical_level += 1;
        }
        Self {
            columns,
            sample_count: time.len(),
            first_stored_level,
            merged: merged.into(),
            column_cache: Arc::new(OnceLock::new()),
            synthesized_level: Arc::new(OnceLock::new()),
        }
    }

    #[cfg(test)]
    pub(super) fn from_samples_storing_every_level(time: &[f64], values: &[f64]) -> Self {
        let time = Arc::from(time.to_vec());
        let values = Arc::from(values.to_vec());
        Self::from_columns_with_cutoff(&time, &values, 1)
    }

    /// Reassembles a pyramid from previously built parts (the sidecar cache).
    ///
    /// # Panics
    ///
    /// Panics when the columns differ in length or the first merged level
    /// does not pair the raw samples. Callers deserializing untrusted bytes
    /// must validate shapes first and treat mismatches as cache misses.
    #[must_use]
    pub fn from_parts(time: Arc<[f64]>, values: Arc<[f64]>, merged: Vec<BinLevel>) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        let sample_count = time.len();
        validate_merged(sample_count, &merged);
        Self {
            columns: PyramidColumns::Retained {
                time: Column::owned(time),
                values: Column::owned(values),
            },
            sample_count,
            first_stored_level: FINEST_STORED_LEVEL,
            merged: merged
                .into_iter()
                .map(|level| CachedBinLevel::Resident(Box::new(level)))
                .collect(),
            column_cache: Arc::new(OnceLock::new()),
            synthesized_level: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn from_signal_cached_parts(signal: &Signal, merged: Vec<CachedBinLevel>) -> Self {
        Self {
            columns: PyramidColumns::Weak {
                time: signal.time_column().downgrade(),
                values: signal.values_column().downgrade(),
            },
            sample_count: signal.len(),
            first_stored_level: FINEST_STORED_LEVEL,
            merged: merged.into(),
            column_cache: Arc::new(OnceLock::new()),
            synthesized_level: Arc::new(OnceLock::new()),
        }
    }

    /// Stored merged levels; index zero is [`FINEST_STORED_LEVEL`].
    #[must_use]
    pub fn merged_levels(&self) -> Vec<BinLevel> {
        self.merged
            .iter()
            .filter_map(CachedBinLevel::materialize)
            .collect()
    }

    #[must_use]
    pub fn level_count(&self) -> usize {
        level_count(self.sample_count)
    }

    /// Returns the final value recorded by the coarsest resident envelope bin.
    #[must_use]
    pub fn last_finite_value(&self) -> Option<f64> {
        self.level(self.level_count().saturating_sub(1))?
            .last()?
            .last
            .filter(|value| value.is_finite())
    }

    #[must_use]
    pub fn stored_bin_count(&self) -> usize {
        self.merged.iter().map(CachedBinLevel::len).sum()
    }

    #[must_use]
    pub fn paged_level_count(&self) -> usize {
        self.merged
            .iter()
            .filter(|level| matches!(level, CachedBinLevel::Paged(_)))
            .count()
    }

    #[must_use]
    pub fn retained_column_bytes(&self) -> usize {
        match self.columns {
            PyramidColumns::Retained { .. } => self.sample_count.saturating_mul(16),
            PyramidColumns::Weak { .. } => 0,
        }
    }

    pub(super) fn columns(&self) -> Option<(Column, Column)> {
        match &self.columns {
            PyramidColumns::Retained { time, values } => Some((time.clone(), values.clone())),
            PyramidColumns::Weak { time, values } => {
                Some((time.upgrade_column()?, values.upgrade_column()?))
            }
        }
    }

    // Caches column handles, not materialized slices: paged columns stay
    // paged, and every probe goes through the fallible `Column` API instead
    // of `as_slice`, which would load the full column and panic on a failed
    // page read.
    pub(super) fn cached_columns(&self) -> Option<&ColumnPair> {
        self.column_cache.get_or_init(|| self.columns()).as_ref()
    }
}

fn merge_level(previous: &BinLevel) -> BinLevel {
    let mut next = BinLevel::with_capacity(previous.len().div_ceil(2));
    for index in (0..previous.len()).step_by(2) {
        let left = previous.to_wire(index);
        let bin = previous
            .get(index + 1)
            .map_or(left.clone(), |right| merge_bins(&left, &right.to_wire()));
        next.push(&bin);
    }
    next
}

fn level_count(samples: usize) -> usize {
    let mut count = 1;
    let mut bins = samples;
    while bins > 1 {
        bins = bins.div_ceil(2);
        count += 1;
    }
    count
}

pub(super) fn level_len(samples: usize, index: usize) -> usize {
    samples.div_ceil(1 << index)
}

fn validate_merged(sample_count: usize, merged: &[BinLevel]) {
    let expected = if level_count(sample_count) > FINEST_STORED_LEVEL {
        sample_count.div_ceil(1 << FINEST_STORED_LEVEL)
    } else {
        0
    };
    assert_eq!(
        merged.first().map_or(0, BinLevel::len),
        expected,
        "first stored level has the wrong length"
    );
}

fn min_option(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

fn max_option(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}
