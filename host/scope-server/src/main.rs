use std::path::PathBuf;

use scope_host::{HostConfig, HostPaths};
use scope_server::{ServerConfig, ServerError, serve};

#[derive(Debug)]
struct Arguments {
    config_dir: PathBuf,
    cache_dir: PathBuf,
    resource_dir: PathBuf,
    available_memory: u64,
    dev_origin: Option<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), ServerError> {
    let arguments = parse_arguments(std::env::args().skip(1).collect())?;
    validate_origin(arguments.dev_origin.as_deref())?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(serve(ServerConfig {
        host: HostConfig {
            paths: HostPaths {
                config_dir: arguments.config_dir,
                cache_dir: arguments.cache_dir,
                resource_dir: arguments.resource_dir,
            },
            available_memory_bytes: arguments.available_memory,
        },
        dev_origin: arguments.dev_origin,
    }))
}

fn parse_arguments(values: Vec<String>) -> Result<Arguments, ServerError> {
    let mut arguments = values.into_iter();
    let mut config_dir = None;
    let mut cache_dir = None;
    let mut resource_dir = None;
    let mut available_memory = None;
    let mut dev_origin = None;
    while let Some(argument) = arguments.next() {
        let value = |name: &str,
                     arguments: &mut std::vec::IntoIter<String>|
         -> Result<String, ServerError> {
            arguments
                .next()
                .ok_or_else(|| ServerError::Invalid(format!("missing value for {name}")))
        };
        match argument.as_str() {
            "--config-dir" => {
                config_dir = Some(PathBuf::from(value("--config-dir", &mut arguments)?));
            }
            "--cache-dir" => cache_dir = Some(PathBuf::from(value("--cache-dir", &mut arguments)?)),
            "--resource-dir" => {
                resource_dir = Some(PathBuf::from(value("--resource-dir", &mut arguments)?));
            }
            "--available-memory" => {
                available_memory = Some(
                    value("--available-memory", &mut arguments)?
                        .parse()
                        .map_err(|_| {
                            ServerError::Invalid(
                                "available memory must be an unsigned integer".into(),
                            )
                        })?,
                );
            }
            "--dev-origin" => dev_origin = Some(value("--dev-origin", &mut arguments)?),
            other => return Err(ServerError::Invalid(format!("unknown argument: {other}"))),
        }
    }
    let config_dir =
        config_dir.ok_or_else(|| ServerError::Invalid("--config-dir is required".into()))?;
    let cache_dir =
        cache_dir.ok_or_else(|| ServerError::Invalid("--cache-dir is required".into()))?;
    let resource_dir =
        resource_dir.ok_or_else(|| ServerError::Invalid("--resource-dir is required".into()))?;
    if !config_dir.is_absolute() || !cache_dir.is_absolute() || !resource_dir.is_absolute() {
        return Err(ServerError::Invalid("host paths must be absolute".into()));
    }
    Ok(Arguments {
        config_dir,
        cache_dir,
        resource_dir,
        available_memory: available_memory
            .ok_or_else(|| ServerError::Invalid("--available-memory is required".into()))?,
        dev_origin,
    })
}

fn validate_origin(origin: Option<&str>) -> Result<(), ServerError> {
    let Some(origin) = origin else { return Ok(()) };
    let valid = origin
        .strip_prefix("http://127.0.0.1:")
        .and_then(|port| port.parse::<u16>().ok())
        .is_some_and(|port| port != 0);
    if valid {
        Ok(())
    } else {
        Err(ServerError::Invalid(
            "--dev-origin must use a loopback origin".into(),
        ))
    }
}
