//! Minimal internal snapshot baker. `./scripts/export.sh` is the public entry.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use scope_core::{ingest, pyramid::Pyramid, session, snapshot, store::SignalStore};
use scope_protocol::{ExportFidelity, ExportRange};

struct Args {
    data: Vec<PathBuf>,
    workspace: Option<PathBuf>,
    template: PathBuf,
    out: PathBuf,
    range: ExportRange,
    fidelity: ExportFidelity,
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from<I, S>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut data = Vec::new();
    let mut workspace = None;
    let mut template = None;
    let mut out = None;
    let mut range = ExportRange::All;
    let mut fidelity = ExportFidelity::Full;
    let mut iter = args.into_iter().map(Into::into);
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => data.push(PathBuf::from(value)),
            "--workspace" => workspace = Some(PathBuf::from(value)),
            "--template" => template = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--range" => {
                range = match value.as_str() {
                    "visible" => ExportRange::Visible,
                    "all" => ExportRange::All,
                    _ => return Err(format!("invalid range: {value}")),
                }
            }
            "--fidelity" => {
                fidelity = match value.as_str() {
                    "preview" => ExportFidelity::Preview,
                    "standard" => ExportFidelity::Standard,
                    "high" => ExportFidelity::High,
                    "full" => ExportFidelity::Full,
                    _ => return Err(format!("invalid fidelity: {value}")),
                }
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    if data.is_empty() {
        return Err("at least one --data file is required".to_owned());
    }
    Ok(Args {
        data,
        workspace,
        template: template.unwrap_or_else(|| PathBuf::from("frontend/dist/snapshot-template.html")),
        out: out.ok_or("--out is required")?,
        range,
        fidelity,
    })
}

fn run(args: &Args) -> Result<(), String> {
    let mut store = SignalStore::new();
    let mut pyramids = BTreeMap::new();
    for path in &args.data {
        let summary = ingest::ingest_path(path, &mut store, &mut |_| ())
            .map_err(|error| format!("ingest {}: {error}", path.display()))?;
        for id in summary.signals {
            let signal = store.signal(id).ok_or("ingested signal vanished")?;
            pyramids.insert(id, Pyramid::from_signal(signal));
        }
    }
    let session = match &args.workspace {
        Some(path) => session::load_from_path(path)
            .map_err(|error| format!("workspace {}: {error}", path.display()))?,
        None => session::Session::default(),
    };
    let template = std::fs::read_to_string(&args.template).map_err(|error| {
        format!(
            "template {}: {error}; run ./scripts/build.sh web first",
            args.template.display()
        )
    })?;
    let export = snapshot::plan(&session, &store, &pyramids, args.range, args.fidelity)
        .map_err(|error| error.to_string())?;
    let manifest = snapshot::bake(&export, &session).map_err(|error| error.to_string())?;
    let html = snapshot::inject(&template, manifest).map_err(|error| error.to_string())?;
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&args.out, html).map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("scope-bake: {message}");
            eprintln!(
                "usage: scope-bake --data <file>... [--workspace <file>] \
                 [--template <path>] [--range visible|all] \
                 [--fidelity preview|standard|high|full] --out <path>"
            );
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("scope-bake: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_controls_default_to_all_full() {
        let args = parse_args_from(["--data", "fixture.csv", "--out", "snapshot.html"])
            .expect("arguments");
        assert_eq!(args.range, ExportRange::All);
        assert_eq!(args.fidelity, ExportFidelity::Full);
    }

    #[test]
    fn export_controls_accept_every_named_value() {
        for (range, expected_range) in
            [("visible", ExportRange::Visible), ("all", ExportRange::All)]
        {
            for (fidelity, expected_fidelity) in [
                ("preview", ExportFidelity::Preview),
                ("standard", ExportFidelity::Standard),
                ("high", ExportFidelity::High),
                ("full", ExportFidelity::Full),
            ] {
                let args = parse_args_from([
                    "--data",
                    "fixture.csv",
                    "--out",
                    "snapshot.html",
                    "--range",
                    range,
                    "--fidelity",
                    fidelity,
                ])
                .expect("arguments");
                assert_eq!(args.range, expected_range);
                assert_eq!(args.fidelity, expected_fidelity);
            }
        }
    }
}
