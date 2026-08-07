use std::{
    fmt,
    ops::{Deref, Range},
    sync::{Arc, Weak},
};

use crate::paging::PageError;
pub use crate::paging::PageHandle;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TimebaseId(pub u64);

#[derive(Clone, Debug)]
pub enum Column {
    Owned(Arc<[f64]>),
    Paged(PageHandle),
}

impl Column {
    #[must_use]
    pub fn owned(values: Arc<[f64]>) -> Self {
        Self::Owned(values)
    }

    #[must_use]
    pub fn paged(handle: PageHandle) -> Self {
        Self::Paged(handle)
    }

    #[must_use]
    /// # Panics
    ///
    /// Panics when a page-backed column cannot be read.
    pub fn as_slice(&self) -> ColumnGuard {
        ColumnGuard {
            values: match self {
                Self::Owned(values) => Arc::clone(values),
                Self::Paged(handle) => handle.values().expect("paged column read"),
            },
            range: 0..self.len(),
        }
    }

    /// # Errors
    ///
    /// Returns an error when a page-backed range cannot be read.
    pub fn range(&self, range: Range<usize>) -> Result<ColumnGuard, PageError> {
        match self {
            Self::Owned(values) => {
                values.get(range.clone()).ok_or(PageError::InvalidRange)?;
                Ok(ColumnGuard {
                    values: Arc::clone(values),
                    range,
                })
            }
            Self::Paged(handle) => Ok(ColumnGuard {
                values: handle.values_range(range.clone())?,
                range: 0..range.len(),
            }),
        }
    }

    /// # Errors
    ///
    /// Returns an error when a page-backed value cannot be read.
    pub fn value(&self, index: usize) -> Result<f64, PageError> {
        match self {
            Self::Owned(values) => values.get(index).copied().ok_or(PageError::InvalidRange),
            Self::Paged(handle) => handle.value(index),
        }
    }

    /// Gathers values in request order without materializing a paged column.
    ///
    /// # Errors
    ///
    /// Returns an error when an index is outside the column or a page-backed value cannot be read.
    pub fn gather(&self, indexes: &[u64]) -> Result<Vec<f64>, PageError> {
        match self {
            Self::Owned(values) => indexes
                .iter()
                .map(|index| {
                    values
                        .get(usize::try_from(*index).map_err(|_| PageError::InvalidRange)?)
                        .copied()
                        .ok_or(PageError::InvalidRange)
                })
                .collect(),
            Self::Paged(handle) => handle.values_at(indexes),
        }
    }

    /// # Errors
    ///
    /// Returns an error when a page-backed value cannot be read.
    pub fn partition_point(
        &self,
        mut predicate: impl FnMut(f64) -> bool,
    ) -> Result<usize, PageError> {
        if let Self::Paged(handle) = self {
            return handle.partition_point(0, self.len(), predicate);
        }
        let mut left = 0;
        let mut right = self.len();
        while left < right {
            let middle = left + (right - left) / 2;
            if predicate(self.value(middle)?) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        Ok(left)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Owned(values) => values.len(),
            Self::Paged(handle) => handle.value_len(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[must_use]
    pub fn downgrade(&self) -> WeakColumn {
        match self {
            Self::Owned(values) => WeakColumn::Owned(Arc::downgrade(values)),
            Self::Paged(handle) => WeakColumn::Paged(handle.clone()),
        }
    }

    #[must_use]
    pub fn same_values(&self, other: &Self) -> bool {
        if let (Self::Paged(left), Self::Paged(right)) = (self, other) {
            return left.same_region(right);
        }
        let left = self.as_slice();
        let right = other.as_slice();
        (Arc::ptr_eq(&left.values, &right.values) && left.range == right.range) || *left == *right
    }
}

impl From<Arc<[f64]>> for Column {
    fn from(values: Arc<[f64]>) -> Self {
        Self::owned(values)
    }
}

impl From<Vec<f64>> for Column {
    fn from(values: Vec<f64>) -> Self {
        Self::owned(values.into())
    }
}

#[derive(Clone, Debug)]
pub enum WeakColumn {
    Owned(Weak<[f64]>),
    Paged(PageHandle),
}

impl WeakColumn {
    #[must_use]
    pub fn upgrade(&self) -> Option<ColumnGuard> {
        let values = match self {
            Self::Owned(values) => values.upgrade()?,
            Self::Paged(handle) => handle.values().ok()?,
        };
        let len = values.len();
        Some(ColumnGuard {
            values,
            range: 0..len,
        })
    }

    #[must_use]
    pub fn upgrade_column(&self) -> Option<Column> {
        match self {
            Self::Owned(values) => Some(Column::Owned(values.upgrade()?)),
            Self::Paged(handle) => Some(Column::Paged(handle.clone())),
        }
    }
}

#[derive(Clone)]
pub struct ColumnGuard {
    values: Arc<[f64]>,
    range: Range<usize>,
}

impl ColumnGuard {
    #[must_use]
    pub fn shared(&self) -> Arc<[f64]> {
        if self.range.start == 0 && self.range.end == self.values.len() {
            Arc::clone(&self.values)
        } else {
            Arc::from(&self.values[self.range.clone()])
        }
    }
}

impl Deref for ColumnGuard {
    type Target = [f64];

    fn deref(&self) -> &Self::Target {
        &self.values[self.range.clone()]
    }
}

impl AsRef<[f64]> for ColumnGuard {
    fn as_ref(&self) -> &[f64] {
        self
    }
}

impl fmt::Debug for ColumnGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.deref().fmt(formatter)
    }
}

impl PartialEq for ColumnGuard {
    fn eq(&self, other: &Self) -> bool {
        **self == **other
    }
}

impl<T: AsRef<[f64]> + ?Sized> PartialEq<&T> for ColumnGuard {
    fn eq(&self, other: &&T) -> bool {
        &**self == other.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gather_preserves_request_order_and_duplicates() {
        let column = Column::from(vec![10.0, 20.0, 30.0, 40.0]);
        assert_eq!(column.gather(&[3, 1, 1]).unwrap(), vec![40.0, 20.0, 20.0]);
    }
}
