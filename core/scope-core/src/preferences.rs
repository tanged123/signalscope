//! Versioned global preferences schema (ADR 0023): appearance settings that
//! persist across sessions, unlike the per-workspace session file.

mod generated;

pub use generated::*;

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            ui_font_family: FontFamily::Inter,
            plot_font_family: FontFamily::Jetbrains,
            ui_font_size: 13.0,
            plot_font_size: 9.0,
        }
    }
}
