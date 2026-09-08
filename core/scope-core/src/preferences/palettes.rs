use super::ContourStop;

pub(super) fn default_colors() -> Vec<String> {
    [
        "#0072bd", "#d95319", "#edb120", "#7e2f8e", "#77ac30", "#4dbeee", "#a2142f",
    ]
    .map(str::to_owned)
    .to_vec()
}

pub(super) fn default_stops() -> Vec<ContourStop> {
    vec![
        ContourStop {
            position: 0.0,
            color: "#000000".to_owned(),
        },
        ContourStop {
            position: 1.0,
            color: "#ffffff".to_owned(),
        },
    ]
}

fn hex(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

pub(super) fn colors(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let colors: Vec<String> = serde_json::from_value(value?.clone()).ok()?;
    if colors.is_empty() || !colors.iter().all(|color| hex(color)) {
        return None;
    }
    Some(
        colors
            .into_iter()
            .map(|color| color.to_ascii_lowercase())
            .collect(),
    )
}

// Endpoints are exact normalized anchors, not approximate measurements.
#[allow(clippy::float_cmp)]
pub(super) fn stops(value: Option<&serde_json::Value>) -> Option<Vec<ContourStop>> {
    let mut stops: Vec<ContourStop> = serde_json::from_value(value?.clone()).ok()?;
    if stops.len() < 2
        || stops.first()?.position != 0.0
        || stops.last()?.position != 1.0
        || stops.iter().any(|stop| {
            !stop.position.is_finite() || !(0.0..=1.0).contains(&stop.position) || !hex(&stop.color)
        })
        || stops
            .windows(2)
            .any(|pair| pair[0].position >= pair[1].position)
    {
        return None;
    }
    for stop in &mut stops {
        stop.color.make_ascii_lowercase();
    }
    Some(stops)
}
