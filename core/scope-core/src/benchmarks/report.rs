use std::path::Path;

#[allow(clippy::needless_pass_by_value)]
pub fn write_report(name: &str, value: serde_json::Value) {
    write_report_at(&super::corpus::bench_root().join("report"), name, &value);
}

fn write_report_at(dir: &Path, name: &str, value: &serde_json::Value) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    println!("{name} {value}");
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
pub fn percentile(sorted_ms: &[f64], fraction: f64) -> f64 {
    assert!(!sorted_ms.is_empty());
    let rank = ((sorted_ms.len() as f64 * fraction).ceil() as usize).clamp(1, sorted_ms.len());
    sorted_ms[rank - 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_writes_pretty_json() {
        let dir = tempfile::tempdir().unwrap();
        write_report_at(dir.path(), "sample", &serde_json::json!({ "pass": true }));
        let text = std::fs::read_to_string(dir.path().join("sample.json")).unwrap();
        assert!(text.contains("\"pass\": true"));
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let sorted = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert!((percentile(&sorted, 0.5) - 5.0).abs() < f64::EPSILON);
        assert!((percentile(&sorted, 0.95) - 10.0).abs() < f64::EPSILON);
        assert!((percentile(&[42.0], 0.99) - 42.0).abs() < f64::EPSILON);

        let hundred = (1..=100).map(f64::from).collect::<Vec<_>>();
        assert!((percentile(&hundred, 0.95) - 95.0).abs() < f64::EPSILON);
    }
}
