#[cfg(feature = "node-compat")]
use crate::backend;
use crate::native;
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;

/// Keep the previous backend available for regression comparisons.
/// Rust mode never starts Node, including for assets and preferences.
pub enum RuntimeBackend {
    #[cfg(feature = "node-compat")]
    Node(Arc<backend::Backend>),
    Rust(Arc<native::Backend>),
}

impl RuntimeBackend {
    pub fn start(app: &AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let mode = std::env::args()
            .find_map(|arg| arg.strip_prefix("--backend=").map(str::to_owned))
            .unwrap_or_else(|| "rust".into());
        let backend = match mode.as_str() {
            "rust" => Self::Rust(native::Backend::start(app)?),
            #[cfg(feature = "node-compat")]
            "node" => Self::Node(backend::Backend::start(app)?),
            _ => {
                return Err(
                    "This build uses --backend=rust; Node compatibility is not included".into(),
                )
            }
        };
        Ok(Arc::new(backend))
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Rust(_) => "rust",
            #[cfg(feature = "node-compat")]
            Self::Node(_) => "node",
        }
    }

    pub async fn request(
        &self,
        target: &str,
        channel: &str,
        args: Vec<Value>,
        mode: &str,
    ) -> Result<Value, String> {
        match self {
            #[cfg(feature = "node-compat")]
            Self::Node(backend) => backend.request(target, channel, args, mode).await,
            Self::Rust(backend) => {
                let backend = backend.clone();
                let (target, channel, mode) =
                    (target.to_owned(), channel.to_owned(), mode.to_owned());
                tauri::async_runtime::spawn_blocking(move || {
                    backend.request(&target, &channel, args, &mode)
                })
                .await
                .map_err(|error| error.to_string())?
            }
        }
    }

    pub fn stop(&self) {
        match self {
            #[cfg(feature = "node-compat")]
            Self::Node(backend) => backend.stop(),
            Self::Rust(backend) => backend.stop(),
        }
    }
}
