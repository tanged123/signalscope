use thiserror::Error;

#[derive(Debug, Error)]
pub enum HostError {
    #[error("{message}")]
    Invalid { code: &'static str, message: String },
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    #[error("{message}")]
    Internal { code: &'static str, message: String },
}

impl HostError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. }
            | Self::Conflict { code, .. }
            | Self::Internal { code, .. } => code,
        }
    }

    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Invalid { .. } => "invalid",
            Self::Conflict { .. } => "conflict",
            Self::Internal { .. } => "internal",
        }
    }
}

#[cfg(test)]
mod tests {}
