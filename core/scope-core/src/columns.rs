use std::{
    fmt,
    ops::Deref,
    sync::{Arc, Weak},
};

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
    /// Panics for file-backed handles until a page reader is attached.
    pub fn as_slice(&self) -> ColumnGuard {
        ColumnGuard {
            values: match self {
                Self::Owned(values) => Arc::clone(values),
                Self::Paged(handle) => handle
                    .memory_values()
                    .expect("paged column handle has no reader"),
            },
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Owned(values) => values.len(),
            Self::Paged(handle) => handle.memory_values().map_or(0, |values| values.len()),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[must_use]
    /// # Panics
    ///
    /// Panics for file-backed handles until a page reader is attached.
    pub fn downgrade(&self) -> WeakColumn {
        WeakColumn {
            values: match self {
                Self::Owned(values) => Arc::downgrade(values),
                Self::Paged(handle) => Arc::downgrade(
                    &handle
                        .memory_values()
                        .expect("paged column handle has no reader"),
                ),
            },
        }
    }

    #[must_use]
    pub fn same_values(&self, other: &Self) -> bool {
        let left = self.as_slice();
        let right = other.as_slice();
        Arc::ptr_eq(&left.values, &right.values) || *left == *right
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
pub struct WeakColumn {
    values: Weak<[f64]>,
}

impl WeakColumn {
    #[must_use]
    pub fn upgrade(&self) -> Option<ColumnGuard> {
        Some(ColumnGuard {
            values: self.values.upgrade()?,
        })
    }
}

#[derive(Clone)]
pub struct ColumnGuard {
    values: Arc<[f64]>,
}

impl ColumnGuard {
    #[must_use]
    pub fn shared(&self) -> Arc<[f64]> {
        Arc::clone(&self.values)
    }
}

impl Deref for ColumnGuard {
    type Target = [f64];

    fn deref(&self) -> &Self::Target {
        &self.values
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
