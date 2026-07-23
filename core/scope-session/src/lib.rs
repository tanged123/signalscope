//! Versioned session schema and migration entry point.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub app: String,
    pub schema_version: u32,
    pub theme: Theme,
    pub linked_time: LinkedTime,
    pub focused_panel_id: Option<String>,
    pub panels: Vec<PanelState>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            app: "signalscope".into(),
            schema_version: CURRENT_SCHEMA_VERSION,
            theme: Theme::Dark,
            linked_time: LinkedTime::default(),
            focused_panel_id: None,
            panels: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkedTime {
    pub t0: f64,
    pub t1: f64,
    pub linked: bool,
    pub cursor_t: Option<f64>,
    pub mode: TimeMode,
}

impl Default for LinkedTime {
    fn default() -> Self {
        Self {
            t0: 0.0,
            t1: 1.0,
            linked: true,
            cursor_t: None,
            mode: TimeMode::Fixed,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeMode {
    #[default]
    Fixed,
    Follow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PanelState {
    pub id: String,
    pub title: String,
    pub mode: PanelMode,
    pub axis_style: AxisStyle,
    pub x_signal: Option<String>,
    pub color_signal: Option<String>,
    pub series: Vec<SeriesState>,
    pub y_range: Option<[f64; 2]>,
    pub annotations: Vec<Annotation>,
    pub show_stats: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelMode {
    Time,
    Xy,
    Fft,
    Histogram,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AxisStyle {
    Gutter,
    Inline,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeriesState {
    pub path: String,
    pub color_slot: u8,
    pub dash: DashStyle,
    pub width: f32,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashStyle {
    Solid,
    Dash,
    Dot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub series_path: String,
    pub time: f64,
    pub value: f64,
    pub label: String,
}

pub fn from_json(json: &str) -> Result<Session, SessionError> {
    #[derive(Deserialize)]
    struct Envelope {
        app: String,
        schema_version: u32,
    }

    let envelope: Envelope = serde_json::from_str(json)?;
    if envelope.app != "signalscope" {
        return Err(SessionError::WrongApplication(envelope.app));
    }
    match envelope.schema_version {
        CURRENT_SCHEMA_VERSION => Ok(serde_json::from_str(json)?),
        version => Err(SessionError::UnsupportedVersion(version)),
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session belongs to another application: {0}")]
    WrongApplication(String),
    #[error("unsupported session schema version: {0}")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_session_round_trips() {
        let session = Session {
            focused_panel_id: Some("panel-a".into()),
            panels: vec![PanelState {
                id: "panel-a".into(),
                title: "Body velocity".into(),
                mode: PanelMode::Time,
                axis_style: AxisStyle::Gutter,
                x_signal: None,
                color_signal: None,
                series: vec![SeriesState {
                    path: "rocket/velocity_body/x".into(),
                    color_slot: 1,
                    dash: DashStyle::Solid,
                    width: 1.5,
                    visible: true,
                }],
                y_range: None,
                annotations: Vec::new(),
                show_stats: false,
            }],
            ..Session::default()
        };

        let json = serde_json::to_string(&session).unwrap();
        assert_eq!(from_json(&json).unwrap(), session);
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"app":"signalscope","schema_version":99}"#).unwrap_err();
        assert!(matches!(error, SessionError::UnsupportedVersion(99)));
    }
}
