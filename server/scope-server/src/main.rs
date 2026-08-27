use std::{env, net::SocketAddr, path::PathBuf};

use scope_server::{AppContext, build_router};

struct Args {
    port: u16,
    frontend_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    no_auth: bool,
    no_open: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    let token = (!args.no_auth).then(|| format!("{:032x}", rand::random::<u128>()));
    let data_dir = args.data_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("signalscope")
    });
    let frontend_dir = args.frontend_dir.or_else(default_frontend_dir);
    let ctx = AppContext::new(data_dir, token.clone(), frontend_dir);
    let port = args.port;
    let url = token.as_deref().map_or_else(
        || format!("http://127.0.0.1:{port}/"),
        |token| format!("http://127.0.0.1:{port}/?token={token}"),
    );
    println!("{url}");
    if !args.no_open {
        let _ = open::that(&url);
    }
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        axum::serve(listener, build_router(ctx))
            .with_graceful_shutdown(shutdown_signal())
            .await
            .map_err(Into::into)
    })
}

fn default_frontend_dir() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("frontend/dist")];
    if let Ok(executable) = env::current_exe()
        && let Some(directory) = executable.parent()
    {
        candidates.push(directory.join("frontend/dist"));
        candidates.push(directory.join("frontend"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend/dist"));
    candidates.into_iter().find(|path| path.is_dir())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install terminate handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

fn parse_args() -> Result<Args, String> {
    let mut args = env::args().skip(1);
    let mut parsed = Args {
        port: 8317,
        frontend_dir: None,
        data_dir: None,
        no_auth: false,
        no_open: false,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                parsed.port = args
                    .next()
                    .ok_or("--port needs a value")?
                    .parse()
                    .map_err(|_| "invalid --port")?;
            }
            "--frontend-dir" => {
                parsed.frontend_dir = Some(PathBuf::from(
                    args.next().ok_or("--frontend-dir needs a value")?,
                ));
            }
            "--data-dir" => {
                parsed.data_dir = Some(PathBuf::from(
                    args.next().ok_or("--data-dir needs a value")?,
                ));
            }
            "--no-auth" => parsed.no_auth = true,
            "--no-open" => parsed.no_open = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(parsed)
}
