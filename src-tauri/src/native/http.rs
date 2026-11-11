use reqwest::blocking::Client;
use serde_json::Value;
use std::{io::Read, time::Duration};

pub fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("TanukiBCL-Tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
}

pub fn get(client: &Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    response
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Response exceeds the resource limit".into());
    }
    Ok(bytes)
}

pub fn post(client: &Client, url: &str, payload: &Value) -> Result<Value, String> {
    let response = client
        .post(url)
        .json(payload)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Response exceeds the JSON limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
