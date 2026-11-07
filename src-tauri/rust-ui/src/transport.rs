use js_sys::{Function, Promise, Reflect};
use serde_json::{json, Value};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
fn api(namespace: &str, name: &str) -> Result<(JsValue, Function), String> {
    let window = web_sys::window().ok_or("Window unavailable")?;
    let tauri = Reflect::get(&window, &JsValue::from_str("__TAURI__")).map_err(error)?;
    let namespace = Reflect::get(&tauri, &JsValue::from_str(namespace)).map_err(error)?;
    let function = Reflect::get(&namespace, &JsValue::from_str(name))
        .map_err(error)?
        .dyn_into::<Function>()
        .map_err(|_| "Tauri API unavailable")?;
    Ok((namespace, function))
}
pub fn error(value: JsValue) -> String {
    value.as_string().unwrap_or_else(|| format!("{value:?}"))
}
pub fn to_js(value: &Value) -> Result<JsValue, String> {
    js_sys::JSON::parse(&value.to_string()).map_err(error)
}
pub fn from_js(value: JsValue) -> Result<Value, String> {
    if value.is_undefined() || value.is_null() {
        return Ok(Value::Null);
    }
    let value = js_sys::JSON::stringify(&value)
        .map_err(error)?
        .as_string()
        .ok_or("Invalid IPC JSON")?;
    serde_json::from_str(&value).map_err(|e| e.to_string())
}
pub async fn invoke(command: &str, args: Value) -> Result<Value, String> {
    let (core, function) = api("core", "invoke")?;
    let promise = function
        .call2(&core, &JsValue::from_str(command), &to_js(&args)?)
        .map_err(error)?;
    from_js(
        JsFuture::from(Promise::resolve(&promise))
            .await
            .map_err(error)?,
    )
}
pub async fn ipc(channel: &str, args: Vec<Value>) -> Result<Value, String> {
    invoke(
        "ipc",
        json!({"channel":channel,"args":args,"mode":"invoke"}),
    )
    .await
}
pub async fn native(action: &str, value: Value) -> Result<Value, String> {
    invoke("native_voice", json!({"action":action,"value":value})).await
}
pub async fn listen(callback: impl FnMut(Value) + 'static) -> Result<(), String> {
    let (event, function) = api("event", "listen")?;
    let mut callback = callback;
    let listener = Closure::<dyn FnMut(JsValue)>::new(move |event| {
        if let Ok(event) = from_js(event) {
            callback(event["payload"].clone());
        }
    });
    let promise = function
        .call2(&event, &JsValue::from_str("backend-ipc"), listener.as_ref())
        .map_err(error)?;
    JsFuture::from(Promise::resolve(&promise))
        .await
        .map_err(error)?;
    // Exactly one listener per WebView. Its lifetime ends with that WebView.
    listener.forget();
    Ok(())
}
pub fn current_window() -> Result<JsValue, String> {
    let (window, function) = api("window", "getCurrentWindow")?;
    function.call0(&window).map_err(error)
}
pub async fn window_action(action: &str) -> Result<(), String> {
    let window = current_window()?;
    let method = Reflect::get(&window, &JsValue::from_str(action))
        .map_err(error)?
        .dyn_into::<Function>()
        .map_err(|_| "Window method unavailable")?;
    let result = method.call0(&window).map_err(error)?;
    JsFuture::from(Promise::resolve(&result))
        .await
        .map_err(error)?;
    Ok(())
}
pub fn dispatch(future: impl std::future::Future<Output = Result<(), String>> + 'static) {
    wasm_bindgen_futures::spawn_local(async move {
        if let Err(error) = future.await {
            crate::show_error(&error);
        }
    });
}
