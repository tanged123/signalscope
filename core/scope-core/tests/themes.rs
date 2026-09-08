use scope_core::{preferences, session};

#[test]
fn named_themes_roundtrip_in_preferences_and_sessions() {
    for theme in [
        "dark",
        "light",
        "graphite",
        "paper",
        "contrast_dark",
        "contrast_light",
    ] {
        let mut prefs = serde_json::to_value(preferences::Preferences::default()).unwrap();
        prefs["theme"] = theme.into();
        let restored = preferences::from_json(&prefs.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap()["theme"], theme);
        let mut workspace = serde_json::to_value(session::Session::default()).unwrap();
        workspace["theme"] = theme.into();
        let restored = session::from_json(&workspace.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap()["theme"], theme);
    }
    let mut prefs = serde_json::to_value(preferences::Preferences::default()).unwrap();
    prefs["theme"] = "future".into();
    assert_eq!(
        preferences::from_json(&prefs.to_string()).unwrap().theme,
        preferences::Theme::Dark
    );
}
