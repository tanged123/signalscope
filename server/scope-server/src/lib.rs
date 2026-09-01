pub mod api;
pub mod auth;
pub mod dialogs;
pub mod host;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use std::{path::PathBuf, sync::Arc};

const EXPORT_BODY_LIMIT: usize = 256 * 1024 * 1024;

use dialogs::{DialogProvider, Native, Scripted};
use host::{DataState, RestoreGate};
use scope_core::{
    ingest::{
        admission::{BudgetConfig, MemoryBudget},
        batch::{BatchJobs, BatchOptions},
        registry::ProviderRegistry,
    },
    preferences,
};

#[derive(Clone)]
pub struct AppContext {
    pub token: Option<Arc<str>>,
    pub data_dir: PathBuf,
    pub frontend_dir: Option<PathBuf>,
    pub state: Arc<std::sync::Mutex<DataState>>,
    pub gate: Arc<RestoreGate>,
    pub jobs: Arc<BatchJobs>,
    pub dialogs: Arc<dyn DialogProvider>,
}

impl AppContext {
    pub fn new(data_dir: PathBuf, token: Option<String>, frontend_dir: Option<PathBuf>) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let preferences_path = data_dir.join("preferences.json");
        let loaded = preferences_path
            .exists()
            .then(|| preferences::load_from_path(&preferences_path).ok())
            .flatten()
            .unwrap_or_default();
        let default_cache = data_dir.join("cache");
        let root = loaded
            .cache_root
            .as_ref()
            .map_or_else(|| default_cache.clone(), PathBuf::from);
        let _ = std::fs::create_dir_all(&root);
        let _ = std::fs::create_dir_all(data_dir.join("recipes"));
        let defaults = BudgetConfig::from_available(8 * 1024 * 1024 * 1024);
        let config = BudgetConfig {
            working_bytes: loaded
                .ingest_working_bytes
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(defaults.working_bytes),
            resident_bytes: loaded
                .ingest_resident_bytes
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(defaults.resident_bytes),
        };
        let budget = MemoryBudget::new(config);
        let mut data = DataState::default();
        data.cache_root.clone_from(&root);
        data.budget = budget.clone();
        let recipe_directory = loaded
            .recipe_directory
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| Some(data_dir.join("recipes")));
        let workers = std::thread::available_parallelism().map_or(1, usize::from);
        // Clippy prefers `from_mins` here, but that constructor is newer than
        // the workspace MSRV.
        #[allow(clippy::duration_suboptimal_units)]
        let terminal_ttl = std::time::Duration::from_secs(5 * 60);
        let jobs = BatchJobs::new(BatchOptions {
            worker_count: workers,
            budget: Arc::new(budget),
            terminal_ttl,
            cache_directory: Some(root),
            recipe_directory,
            provider_registry: Arc::new(ProviderRegistry::builtin()),
        });
        Self {
            token: token.map(Into::into),
            data_dir,
            frontend_dir,
            state: Arc::new(std::sync::Mutex::new(data)),
            gate: Arc::new(RestoreGate::default()),
            jobs: Arc::new(jobs),
            dialogs: Arc::new(Native),
        }
    }

    pub fn for_tests(token: Option<String>) -> Self {
        let mut context = Self::new(
            std::env::temp_dir().join(format!("scope-server-test-{}", std::process::id())),
            token,
            None,
        );
        context.dialogs = Arc::new(Scripted::default());
        context
    }
}

pub fn build_router(ctx: AppContext) -> Router {
    let export_routes = Router::new()
        .route(
            "/save_export_file_to_directory",
            post(api::save_export_file_to_directory),
        )
        .route("/export_write", post(api::export_write))
        .route("/save_export_file", post(api::save_export_file))
        .layer(DefaultBodyLimit::max(EXPORT_BODY_LIMIT));
    let api = Router::new()
        .route("/list_formats", post(api::list_formats))
        .route("/scan_sources", post(api::scan_sources))
        .route("/ingest_batch", post(api::ingest_batch))
        .route("/batch_status", post(api::batch_status))
        .route("/batch_detail", post(api::batch_detail))
        .route("/cancel_batch", post(api::cancel_batch))
        .route("/release_batch", post(api::release_batch))
        .route("/introspect_container", post(api::introspect_container))
        .route("/save_recipe", post(api::save_recipe))
        .route("/restore_sources", post(api::restore_sources))
        .route("/restore_finalize", post(api::restore_finalize))
        .route("/list_sources", post(api::list_sources))
        .route("/list_signals", post(api::list_signals))
        .route("/query_tiles_bin", post(api::query_tiles_bin))
        .route("/query_samples", post(api::query_samples))
        .route("/create_derived", post(api::create_derived))
        .route("/create_derived_bundle", post(api::create_derived_bundle))
        .route("/remove_derived_bundle", post(api::remove_derived_bundle))
        .route("/remove_signal", post(api::remove_signal))
        .route("/save_session", post(api::save_session))
        .route("/load_session", post(api::load_session))
        .route("/reset_session", post(api::reset_session))
        .route("/export_estimate", post(api::export_estimate))
        .route("/load_preferences", post(api::load_preferences))
        .route("/save_preferences", post(api::save_preferences))
        .route(
            "/effective_recipe_directory",
            post(api::effective_recipe_directory),
        )
        .route("/pick_sources", post(api::pick_sources))
        .route("/pick_source_folder", post(api::pick_source_folder))
        .route("/pick_session_path", post(api::pick_session_path))
        .route("/pick_export_directory", post(api::pick_export_directory))
        .route("/pick_recipe_directory", post(api::pick_recipe_directory))
        .merge(export_routes)
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
        .layer(axum::middleware::from_fn_with_state(
            ctx.clone(),
            auth::require_auth,
        ));
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .nest("/api", api)
        .merge(auth::page_routes())
        .with_state(ctx)
}
