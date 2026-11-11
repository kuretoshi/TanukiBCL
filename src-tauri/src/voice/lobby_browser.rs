//! Bounded read-only Socket.IO lobby browser. Independent of audio capture;
//! the connection closes when its window closes or the server changes.
use super::model::Preferences;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

struct Code {
    id: i64,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
struct State {
    rows: BTreeMap<i64, Value>,
    error: String,
}
pub struct Browser {
    enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<State>>,
    commands: mpsc::Sender<Code>,
}
impl Browser {
    pub fn start(app: Option<tauri::AppHandle>, prefs: watch::Receiver<Preferences>) -> Self {
        let enabled = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(State::default()));
        let (commands, rx) = mpsc::channel(8);
        tauri::async_runtime::spawn(run(
            app,
            prefs,
            enabled.clone(),
            stop.clone(),
            state.clone(),
            rx,
        ));
        Self {
            enabled,
            stop,
            state,
            commands,
        }
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
    pub async fn request(&self, value: &Value, game: &Value) -> Result<Value, String> {
        match value["action"].as_str().unwrap_or("list") {
            "list" => {
                self.enabled.store(true, Ordering::Relaxed);
                let state = self.state.lock().unwrap();
                Ok(json!({"lobbies":state.rows.values().collect::<Vec<_>>(),"error":state.error}))
            }
            "stop" => {
                self.enabled.store(false, Ordering::Relaxed);
                Ok(Value::Null)
            }
            "code" => {
                let id = value["id"]
                    .as_i64()
                    .or_else(|| value["id"].as_str().and_then(|v| v.parse().ok()))
                    .ok_or("Invalid lobby ID")?;
                {
                    let state = self.state.lock().unwrap();
                    let row = state.rows.get(&id).ok_or("ロビーは公開を終了しました")?;
                    if row["gameState"] != 0
                        || row["current_players"].as_u64() >= row["max_players"].as_u64()
                        || row["mods"].as_str().unwrap_or("NONE")
                            != game["mod"].as_str().unwrap_or("NONE")
                    {
                        return Err("参加可能な同じMODのロビーを選択してください".into());
                    }
                }
                let (reply, result) = oneshot::channel();
                self.commands
                    .try_send(Code { id, reply })
                    .map_err(|_| "ロビーへの問い合わせが混み合っています")?;
                tokio::time::timeout(Duration::from_secs(8), result)
                    .await
                    .map_err(|_| "ロビーコードの取得がタイムアウトしました")?
                    .map_err(|_| "ロビーへの接続が終了しました")?
            }
            _ => Err("Unknown lobby browser action".into()),
        }
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.stop();
    }
}
fn valid_row(row: &Value) -> bool {
    row["id"].as_i64().is_some()
        && ["title", "host", "mods", "language"]
            .iter()
            .all(|key| row[key].as_str().is_some_and(|v| v.len() <= 256))
        && row["current_players"].as_u64().is_some_and(|n| n <= 255)
        && row["max_players"]
            .as_u64()
            .is_some_and(|n| (1..=255).contains(&n))
        && row["gameState"].as_u64().is_some_and(|n| n <= 3)
}
fn public_row(row: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "title",
        "host",
        "mods",
        "language",
        "current_players",
        "max_players",
        "gameState",
    ] {
        result[key] = row[key].clone();
    }
    if let Some(time) = row["stateTime"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
    {
        result["stateTime"] = json!(time);
    }
    result
}
fn active(app: &Option<tauri::AppHandle>, enabled: &AtomicBool, stop: &AtomicBool) -> bool {
    !stop.load(Ordering::Relaxed)
        && enabled.load(Ordering::Relaxed)
        && app
            .as_ref()
            .is_none_or(|a| a.get_webview_window("lobbies").is_some())
}
fn publish(app: &Option<tauri::AppHandle>, state: &Arc<Mutex<State>>) {
    if let Some(app) = app {
        let state = state.lock().unwrap();
        let rows: Vec<_> = state.rows.values().collect();
        let _=app.emit_to("lobbies","backend-ipc",json!({"channel":"LOBBY_BROWSER_CHANGED","args":[{"lobbies":rows,"error":state.error}]}));
    }
}
async fn run(
    app: Option<tauri::AppHandle>,
    mut prefs: watch::Receiver<Preferences>,
    enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<State>>,
    mut commands: mpsc::Receiver<Code>,
) {
    while !stop.load(Ordering::Relaxed) {
        if !active(&app, &enabled, &stop) {
            enabled.store(false, Ordering::Relaxed);
            state.lock().unwrap().rows.clear();
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        let server = prefs.borrow_and_update().server_url.clone();
        let result = session(
            &app,
            &mut prefs,
            &enabled,
            &stop,
            &state,
            &mut commands,
            &server,
        )
        .await;
        if let Err(error) = result {
            let mut data = state.lock().unwrap();
            data.error = error;
            data.rows.clear();
        }
        publish(&app, &state);
        for _ in 0..15 {
            if !active(&app, &enabled, &stop) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}
async fn session(
    app: &Option<tauri::AppHandle>,
    prefs: &mut watch::Receiver<Preferences>,
    enabled: &AtomicBool,
    stop: &AtomicBool,
    state: &Arc<Mutex<State>>,
    commands: &mut mpsc::Receiver<Code>,
    server: &str,
) -> Result<(), String> {
    let mut url = tauri::Url::parse(server).map_err(|e| e.to_string())?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err("Unsupported lobby server URL".into());
    }
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "Invalid lobby server URL")?;
    url.set_path("/socket.io/");
    url.set_query(Some("EIO=4&transport=websocket"));
    url.set_fragment(None);
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(1024 * 1024);
    config.max_frame_size = Some(1024 * 1024);
    config.write_buffer_size = 16 * 1024;
    config.max_write_buffer_size = 128 * 1024;
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_with_config(url.as_str(), Some(config), false),
    )
    .await
    .map_err(|_| "公開ロビーへの接続がタイムアウトしました")?
    .map_err(|e| e.to_string())?;
    let mut serial = 0u64;
    let mut pending: BTreeMap<u64, (Instant, oneshot::Sender<Result<Value, String>>)> =
        BTreeMap::new();
    let mut last_ping = Instant::now();
    let mut ping_timeout = Duration::from_secs(45);
    let mut connected = false;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if !active(app,enabled,stop)||prefs.borrow().server_url!=server{let _=socket.send(Message::Text("42[\"lobbybrowser\",false]".into())).await;let _=socket.close(None).await;return Ok(());}
                if last_ping.elapsed()>ping_timeout{return Err("公開ロビーの接続が切れました".into());}
                pending.retain(|_,(at,reply)|!reply.is_closed()&&at.elapsed()<Duration::from_secs(8));
            },
            Some(command)=commands.recv()=>{
                if !connected||pending.len()>=8{let _=command.reply.send(Err("公開ロビーに接続していません".into()));continue;}
                serial=serial.wrapping_add(1);socket.send(Message::Text(format!("42{serial}{}",json!(["join_lobby",command.id])).into())).await.map_err(|e|e.to_string())?;pending.insert(serial,(Instant::now(),command.reply));
            },
            message=socket.next()=>{
                let Some(message)=message else{return Err("公開ロビーの接続が終了しました".into())};let message=message.map_err(|e|e.to_string())?;
                let text=match message{Message::Text(text)=>text,Message::Ping(bytes)=>{socket.send(Message::Pong(bytes)).await.map_err(|e|e.to_string())?;continue;},Message::Close(_)=>return Err("公開ロビーの接続が終了しました".into()),_=>continue};
                if let Some(open)=text.strip_prefix('0'){let hello:Value=serde_json::from_str(open).map_err(|e|e.to_string())?;ping_timeout=Duration::from_millis(hello["pingInterval"].as_u64().unwrap_or(25000).saturating_add(hello["pingTimeout"].as_u64().unwrap_or(20000)).clamp(5000,120000));last_ping=Instant::now();socket.send(Message::Text("40".into())).await.map_err(|e|e.to_string())?;}
                else if let Some(ping)=text.strip_prefix('2'){last_ping=Instant::now();socket.send(Message::Text(format!("3{ping}").into())).await.map_err(|e|e.to_string())?;}
                else if text.starts_with("40"){connected=true;state.lock().unwrap().error.clear();socket.send(Message::Text("42[\"lobbybrowser\",true]".into())).await.map_err(|e|e.to_string())?;publish(app,state);}
                else if let Some(ack)=text.strip_prefix("43"){if let Some((id,body))=ack.split_once('['){if let Ok(id)=id.parse::<u64>(){if let Some((_,reply))=pending.remove(&id){let data:Value=serde_json::from_str(&format!("[{body}")).map_err(|e|e.to_string())?;let result=if data[0]==0{data[1].as_str().filter(|s|s.len()<=512).map(|s|json!(s)).ok_or("Invalid lobby code response".into())}else{Err(data[1].as_str().unwrap_or("ロビーコードを取得できませんでした").chars().take(512).collect())};let _=reply.send(result);}}}}
                else if let Some(event)=text.strip_prefix("42"){let event:Value=serde_json::from_str(event).map_err(|e|e.to_string())?;let mut changed=false;
                    {let mut data=state.lock().unwrap();match event[0].as_str().unwrap_or(""){
                        "new_lobbies"=>{if let Some(rows)=event[1].as_array().filter(|r|r.len()<=4096){for row in rows{if valid_row(row)&&(data.rows.len()<4096||data.rows.contains_key(&row["id"].as_i64().unwrap())){data.rows.insert(row["id"].as_i64().unwrap(),public_row(row));changed=true;}}}},
                        "update_lobby" if valid_row(&event[1])=>{if data.rows.len()<4096||data.rows.contains_key(&event[1]["id"].as_i64().unwrap()){data.rows.insert(event[1]["id"].as_i64().unwrap(),public_row(&event[1]));changed=true;}},
                        "remove_lobby"=>{if let Some(id)=event[1].as_i64(){changed=data.rows.remove(&id).is_some();}},_=>{}
                    }}if changed{publish(app,state);}
                }else if text.starts_with("41")||text.starts_with("44"){return Err("公開ロビーへの接続が拒否されました".into());}
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_or_unbounded_public_rows_are_rejected() {
        let mut row = json!({"id":-1,"title":"test","host":"fixture","mods":"NONE","language":"ja","current_players":4,"max_players":15,"gameState":0});
        assert!(valid_row(&row));
        row["host"] = json!("x".repeat(257));
        assert!(!valid_row(&row));
        row["host"] = json!("fixture");
        row["current_players"] = json!(-1);
        assert!(!valid_row(&row));
    }
    #[test]
    fn unrecognized_lobby_fields_cannot_accumulate_in_the_browser_cache() {
        let row = json!({"id":1,"title":"test","host":"fixture","mods":"NONE","language":"ja","current_players":4,"max_players":15,"gameState":0,"stateTime":1.0,"ignored":"x".repeat(1024*1024)});
        assert!(valid_row(&row));
        let stored = public_row(&row);
        assert!(stored.to_string().len() < 1024);
        assert_eq!(stored["stateTime"], 1.0);
    }
    #[tokio::test]
    async fn local_browser_tracks_rows_handles_ping_and_acknowledges_codes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.send(Message::Text(
                "0{\"pingInterval\":25000,\"pingTimeout\":20000}".into(),
            ))
            .await
            .unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap(), "40");
            ws.send(Message::Text("40{\"sid\":\"local-fixture\"}".into()))
                .await
                .unwrap();
            assert_eq!(
                ws.next().await.unwrap().unwrap().into_text().unwrap(),
                "42[\"lobbybrowser\",true]"
            );
            let row = json!({"id":42,"title":"Local fixture","host":"Synthetic","mods":"NONE","language":"ja","current_players":4,"max_players":15,"gameState":0});
            ws.send(Message::Text(
                format!(
                    "42{}",
                    json!(["new_lobbies",[row,{"id":43,"title":"invalid"}]] )
                )
                .into(),
            ))
            .await
            .unwrap();
            ws.send(Message::Text("2heartbeat".into())).await.unwrap();
            let mut acknowledged = false;
            let mut pong = false;
            while !acknowledged || !pong {
                let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
                if text == "3heartbeat" {
                    pong = true;
                    continue;
                }
                let packet = text.strip_prefix("42").unwrap();
                let (id, body) = packet.split_once('[').unwrap();
                let args: Value = serde_json::from_str(&format!("[{body}")).unwrap();
                assert_eq!(args, json!(["join_lobby", 42]));
                ws.send(Message::Text(format!("43{id}[0,\"FIXTURE\"]").into()))
                    .await
                    .unwrap();
                acknowledged = true;
            }
            ws.send(Message::Text("42[\"remove_lobby\",42]".into()))
                .await
                .unwrap();
            while let Some(message) = ws.next().await {
                if matches!(message, Ok(Message::Close(_))) {
                    break;
                }
            }
        });
        let (prefs, _) = watch::channel(Preferences {
            server_url: format!("http://{address}"),
            ..Default::default()
        });
        let browser = Browser::start(None, prefs.subscribe());
        let game = json!({"mod":"NONE"});
        browser
            .request(&json!({"action":"list"}), &game)
            .await
            .unwrap();
        for _ in 0..200 {
            if browser.state.lock().unwrap().rows.contains_key(&42) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(browser.state.lock().unwrap().rows.len(), 1);
        assert!(browser
            .request(&json!({"action":"code","id":42}), &json!({"mod":"NoS"}))
            .await
            .is_err());
        let code = browser
            .request(&json!({"action":"code","id":42}), &game)
            .await
            .unwrap();
        assert_eq!(code, "FIXTURE");
        for _ in 0..100 {
            if browser.state.lock().unwrap().rows.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(browser.state.lock().unwrap().rows.is_empty());
        browser.stop();
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
