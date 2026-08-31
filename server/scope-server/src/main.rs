use std::{
    env,
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
};

use scope_server::{AppContext, build_router};

struct Args {
    port: u16,
    frontend_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    no_auth: bool,
    no_open: bool,
    exit_on_stdin_close: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    if arguments == ["--version"] {
        println!(env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let args = parse_args_from(arguments)?;
    let token = (!args.no_auth).then(|| format!("{:032x}", rand::random::<u128>()));
    let data_dir = args.data_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("signalscope")
    });
    let frontend_dir = args.frontend_dir.or_else(default_frontend_dir);
    let ctx = AppContext::new(data_dir, token.clone(), frontend_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], args.port))).await?;
        let port = listener.local_addr()?.port();
        let url = launch_url(port, token.as_deref());
        println!("{url}");
        std::io::stdout().flush()?;
        if !args.no_open {
            let _ = open::that(&url);
        }
        axum::serve(listener, build_router(ctx))
            .with_graceful_shutdown(shutdown_signal(args.exit_on_stdin_close))
            .await
            .map_err(Into::into)
    })
}

fn launch_url(port: u16, token: Option<&str>) -> String {
    token.map_or_else(
        || format!("http://127.0.0.1:{port}/"),
        |token| format!("http://127.0.0.1:{port}/?token={token}"),
    )
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

async fn shutdown_signal(exit_on_stdin_close: bool) {
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
    let stdin_closed = async move {
        if exit_on_stdin_close {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let mut stdin = std::io::stdin().lock();
                let mut byte = [0_u8; 1];
                while stdin.read(&mut byte).unwrap_or(0) != 0 {}
                let _ = sender.send(());
            });
            let _ = receiver.await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
        () = stdin_closed => {},
    }
}

fn parse_args_from(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut args = args.into_iter();
    let mut parsed = Args {
        port: 8317,
        frontend_dir: None,
        data_dir: None,
        no_auth: false,
        no_open: false,
        exit_on_stdin_close: false,
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
            "--exit-on-stdin-close" => parsed.exit_on_stdin_close = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{launch_url, parse_args_from};
    use std::path::PathBuf;

    #[test]
    fn desktop_arguments_select_an_ephemeral_authenticated_server() {
        let args = parse_args_from(
            [
                "--port",
                "0",
                "--no-open",
                "--exit-on-stdin-close",
                "--frontend-dir",
                "/app/frontend",
                "--data-dir",
                "/data",
            ]
            .map(String::from),
        )
        .unwrap();
        assert_eq!(args.port, 0);
        assert!(args.no_open);
        assert!(args.exit_on_stdin_close);
        assert_eq!(args.frontend_dir, Some(PathBuf::from("/app/frontend")));
        assert_eq!(args.data_dir, Some(PathBuf::from("/data")));
    }

    #[test]
    fn launch_url_contains_the_bound_port_and_token() {
        assert_eq!(
            launch_url(43817, Some("secret")),
            "http://127.0.0.1:43817/?token=secret"
        );
    }
}
