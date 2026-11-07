use super::{
    audio::{self, Audio, Frame, Mixer, SharedMixer},
    gate::{Gate, Vad},
    model::*,
    peer::{Event, Peer},
    radio::Radio,
    routing::Route,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use webrtc::peer_connection::{
    RTCConfiguration, RTCConfigurationBuilder, RTCIceServer, RTCIceTransportPolicy,
    RTCPeerConnectionState,
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
pub struct Engine {
    pub prefs: watch::Receiver<Preferences>,
    pub game: watch::Receiver<Value>,
    pub stop: watch::Receiver<bool>,
    pub controls: Arc<Controls>,
    pub metrics: Arc<Metrics>,
    pub status: Arc<Mutex<Status>>,
    pub shared: watch::Receiver<Value>,
    pub synthetic: bool,
    pub frequency: f32,
    pub app: Option<tauri::AppHandle>,
    pub initial_context: Value,
}
impl Engine {
    pub async fn run(mut self) {
        loop {
            if *self.stop.borrow() {
                break;
            }
            let prefs = self.prefs.borrow_and_update().clone();
            self.controls.microphone_rms.store(0,Ordering::Relaxed);
            let mixer = Arc::new(Mutex::new(Mixer::default()));
            let (audio_tx, mut audio_rx) = mpsc::channel::<Frame>(8);
            let (error_tx, mut error_rx) = mpsc::channel::<String>(4);
            match Audio::start(
                &prefs,
                mixer.clone(),
                self.controls.clone(),
                self.metrics.clone(),
                audio_tx,
                error_tx,
                self.synthetic,
            ) {
                Ok(audio) => {
                    {
                        let mut status = self.status.lock().unwrap();
                        status.audio_ready = true;
                        status.microphone_name = audio.input_name.clone();
                        status.speaker_name = audio.output_name.clone();
                        status.error.clear();
                    }
                    let result = self
                        .session(&prefs, mixer, &mut audio_rx, &mut error_rx)
                        .await;
                    drop(audio);
                    if let Err(error) = result {
                        self.status.lock().unwrap().error = error;
                    }
                }
                Err(error) => self.status.lock().unwrap().error = error,
            }
            self.controls.joined.store(false, Ordering::Relaxed);
            self.controls.peers_ready.store(false, Ordering::Relaxed);
            {
                let mut s = self.status.lock().unwrap();
                s.connected = false;
                s.audio_ready = false;
                s.peers = 0;
                s.talking = false;
                s.voice_snapshot = Value::Null;
                s.effective_game = Value::Null;
            }
            if *self.stop.borrow() {
                break;
            }
            if self.prefs.has_changed().unwrap_or(false) {
                continue;
            }
            tokio::select! {_=tokio::time::sleep(Duration::from_secs(3))=>{},_=self.stop.changed()=>{},_=self.prefs.changed()=>{}}
        }
    }
    async fn session(
        &mut self,
        prefs: &Preferences,
        mixer: SharedMixer,
        audio_rx: &mut mpsc::Receiver<Frame>,
        error_rx: &mut mpsc::Receiver<String>,
    ) -> Result<(), String> {
        let mut prefs = prefs.clone();
        let mut url = tauri::Url::parse(&prefs.server_url).map_err(|e| e.to_string())?;
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| "Invalid signaling URL")?;
        url.set_path("/socket.io/");
        url.set_query(Some("EIO=4&transport=websocket"));
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(1024 * 1024);
        config.max_frame_size = Some(1024 * 1024);
        config.max_write_buffer_size = 256 * 1024;
        let connection = tokio::time::timeout(
            Duration::from_secs(12),
            connect_async_with_config(url.as_str(), Some(config), false),
        );
        let (mut socket, _) = tokio::select! {r=connection=>r.map_err(|_|"通話サーバーへの接続がタイムアウトしました")?.map_err(|e|format!("通話サーバー: {e}"))?,_=self.stop.changed()=>return Ok(()),_=self.prefs.changed()=>return Ok(())};
        let mut peers: HashMap<String, Peer> = HashMap::new();
        let (tx, mut events) = mpsc::channel::<Event>(128);
        let overflow = Arc::new(AtomicBool::new(false));
        let mut clients = serde_json::Map::new();
        let mut identity = Value::Null;
        let mut own_id = String::new();
        let mut server_host = 0i64;
        let mut ice = default_ice();
        let mut shared = self.shared.borrow_and_update().clone();
        let mut own_rules = shared["myLobbySettings"].clone();
        let mut rules = own_rules.clone();
        let mut host_rules_known = false;
        let mut retry: HashMap<String, Instant> = HashMap::new();
        let mut serial = 0u64;
        let mut last_talking = false;
        let mut radio = Radio::default();
        let mut metadata = super::control::Book::default();
        let mut access = super::access::Access::default();
        let mut sources = super::remote::Sources::default();
        let mut cosmetics = super::cosmetics::Relay::default();
        let speech_path = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../out/tauri-backend/rust-speech")
        } else {
            self.app
                .as_ref()
                .and_then(|a| a.path().resource_dir().ok())
                .unwrap_or_default()
                .join("backend/rust-speech")
        };
        let mut speech = super::speech::Speech::new(speech_path);
        let mut vad = Vad::default();
        let mut gate = Gate::default();
        let mut last_phase = None;
        let mut last_meeting_hud = None;
        let mut airship_spawn_until = Instant::now();
        let mut raw_vad: HashMap<i64, bool> = HashMap::new();
        let mut versions: HashMap<String, String> = HashMap::new();
        let mut ui = super::bridge::Ui::default();
        let mut context = self.initial_context.clone();
        let mut context_time = Instant::now() - Duration::from_secs(2);
        let mut bridge_time = Instant::now() - Duration::from_secs(2);
        let mut mobile_beacon = Instant::now() - Duration::from_secs(6);
        let mut mobile_running = false;
        let mut mobile_frame = Value::Null;
        let mut public_frame = Value::Null;
        let mut obs_frame = Value::Null;
        let mut obs_time = Instant::now() - Duration::from_secs(6);
        let mut sent_game_info = Value::Null;
        let mut overlay_enabled = None;
        let mut encoder = opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip)
            .map_err(|e| e.to_string())?;
        encoder
            .set_bitrate(opus::Bitrate::Bits(32_000))
            .map_err(|e| e.to_string())?;
        encoder.set_complexity(5).map_err(|e| e.to_string())?;
        encoder.set_inband_fec(true).map_err(|e| e.to_string())?;
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut synthetic_tick = tokio::time::interval(Duration::from_millis(20));
        synthetic_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut tone_time = 0u64;
        let mut last_ping = Instant::now();
        let mut server_ping = None::<f64>;
        let mut quality_time = Instant::now() - Duration::from_secs(3);
        let mut qualities = serde_json::Map::new();
        let mut ping_timeout = Duration::from_secs(50);
        let result:Result<(),String>=async {
            loop {tokio::select!{
                _=self.stop.changed()=>break,
                _=self.prefs.changed()=>{let next=self.prefs.borrow().clone();if prefs.requires_restart(&next){break}self.prefs.borrow_and_update();prefs=next;},
                Some(error)=error_rx.recv()=>return Err(error),
                message=socket.next()=>{
                    let Some(message)=message else {return Err("通話サーバーとの接続が終了しました".into());};
                    let message=message.map_err(|e|e.to_string())?;
                    let Message::Text(text)=message else {if let Message::Close(_)=message{return Err("通話サーバーとの接続が終了しました".into());}continue;};
                    if let Some(open)=text.strip_prefix('0'){
                        let hello:Value=serde_json::from_str(open).map_err(|e|e.to_string())?;
                        let timeout=hello["pingInterval"].as_u64().unwrap_or(25000)+hello["pingTimeout"].as_u64().unwrap_or(20000);
                        ping_timeout=Duration::from_millis(timeout.clamp(5000,120000));last_ping=Instant::now();send(&mut socket,"40".into()).await?;
                    }else if let Some(ping)=text.strip_prefix('2'){last_ping=Instant::now();let start=Instant::now();send(&mut socket,format!("3{ping}")).await?;server_ping=Some(start.elapsed().as_secs_f64()*1000.);
                    }else if let Some(connect)=text.strip_prefix("40"){
                        let connect:Value=serde_json::from_str(connect).map_err(|e|e.to_string())?;own_id=connect["sid"].as_str().ok_or("Missing Socket.IO ID")?.to_owned();self.status.lock().unwrap().connected=true;
                    }else if text.starts_with("41")||text.starts_with("44"){return Err("通話サーバーが接続を拒否しました".into());
                    }else if let Some(event)=parse_event(&text){
                        match event[0].as_str().unwrap_or(""){
                            "clientPeerConfig"=>{ice=parse_ice(&event[1])?;},
                            "setHost"=>{server_host=event[1].as_i64().unwrap_or(0);},
                            "setClients"=>{clients=client_map(&event[1]);},
                            "VAD"=>{let frame=&event[1];if let Some(socket)=frame["socketId"].as_str(){if let (Some(id),Some(active))=(clients.get(socket).and_then(|c|c["clientId"].as_i64()),frame["activity"].as_bool()){if sources.selected(&self.game.borrow(),&clients).get(&id).is_some_and(|s|s==socket){raw_vad.insert(id,active);}}}},
                            "setClient"|"join"=>{if let Some(id)=event.get(1).and_then(Value::as_str).filter(|id|id.len()<=128){if valid_client(&event[2])&&clients.len()<MAX_PEERS+1{clients.insert(id.into(),event[2].clone());}}},
                            "signal"=>{
                                let signal=&event[1];let Some(from)=signal["from"].as_str().filter(|s|s.len()<=128&&*s!=own_id) else{continue};
                                let data=&signal["data"];let kind=data["type"].as_str().unwrap_or("");
                                if kind=="obs-cosmetics-request"{if flag(&shared,"obsOverlay")&&data["secret"]==shared["obsSecret"]&&data["secret"].as_str().is_some_and(|s|s.len()==9){cosmetics.request(from,&data["sources"]);}continue;}
                                if kind=="nos-voice-source"{let game=self.game.borrow();let sender=signal.get("client").filter(|v|valid_client(v)).or_else(||clients.get(from)).unwrap_or(&Value::Null);sources.receive(sender,data,&game,&clients);continue;}
                                if kind=="nos-voice-role"||kind=="nos-host-voice"{
                                    let game=self.game.borrow().clone();let sender=signal.get("client").filter(|v|valid_client(v)).or_else(||clients.get(from)).unwrap_or(&Value::Null);
                                    if kind=="nos-host-voice"{if sources.host_sample(from,sender,data,&game){if let Some(app)=&self.app{let backend=app.state::<Arc<crate::Backend>>().inner().clone();let _=backend.request("main","native:addon:sample",vec![json!({"playerId":data["playerId"],"rms":data["rms"],"active":data["active"],"host":true})],"invoke").await;}signal_to(&mut socket,from,"",json!({"type":"nos-host-voice-ack"})).await?;}}
                                    else{let(ack,sample)=self.controls.remote.lock().unwrap().accept(from,sender,data);if let Some(ack)=ack{signal_to(&mut socket,from,"",ack).await?;}if let Some(sample)=sample.filter(|_|local(&game).is_some_and(|p|p["isDead"]!=true)){if let Some(app)=&self.app{let jammed=rules["nosFixerJammingVoiceBlock"]!=false&&local(&game).is_some_and(|p|p["nosPlayer"]["isJammed"]==true);let backend=app.state::<Arc<crate::Backend>>().inner().clone();let _=backend.request("main","native:addon:sample",vec![json!({"playerId":sample["playerId"],"rms":sample["rms"],"active":sample["active"]==true&&!jammed,"host":false})],"invoke").await;}}}continue;
                                }
                                if data.get("mobilePlayerInfo").is_some(){let game=self.game.borrow();if flag(&shared,"mobileHost")&&!identity.is_null()&&data["mobilePlayerInfo"]["code"]==game["lobbyCode"]{mobile_running=true;cosmetics.resend(data["mobilePlayerInfo"].get("nosCosmeticIds"));}continue;}
                                if !eligible(from,&clients,&self.game.borrow()) {continue;}
                                if kind=="bcl-control"{if let Some(payload)=data["payload"].as_str().filter(|s|s.len()<=65536){if let Ok(value)=serde_json::from_str(payload){accept_rules(from,&value,&clients,&self.game.borrow(),server_host,&mut rules,&mut host_rules_known);if let Some(client)=clients[from]["clientId"].as_i64(){let game=self.game.borrow();metadata.accept(client,&value,&game,host_id(&game,server_host));radio.accept(client,&value,&game,&rules);}}}continue;}
                                if !["offer","answer","candidate"].contains(&kind){continue;}
                                let generation=data["connectionId"].as_str().filter(|s|s.len()<=128).unwrap_or("").to_owned();
                                if kind=="offer"{
                                    if let Some(peer)=peers.get(from){
                                        if peer.initiator&&!peer.connected&&own_id.as_str()<from{continue;}
                                        if peer.generation==generation&&peer.pc.remote_description().await.is_some_and(|d|Some(d.sdp.as_str())==data["sdp"].as_str()){continue;}
                                    }
                                    if let Some(old)=peers.remove(from){old.close().await;}
                                    mixer.lock().unwrap().add(from);
                                    match Peer::new(from,generation.clone(),false,ice.clone(),tx.clone(),mixer.clone(),self.metrics.clone(),overflow.clone()).await{Ok(peer)=>{peers.insert(from.into(),peer);},Err(error)=>{self.status.lock().unwrap().error=error;continue;}}
                                }
                                if let Some(peer)=peers.get_mut(from){
                                    if !generation.is_empty()&&generation!=peer.generation{continue;}
                                    match peer.signal(data).await{Ok(Some(answer))=>signal_to(&mut socket,from,&peer.generation,answer).await?,Ok(None)=>{},Err(error)=>{self.status.lock().unwrap().error=format!("音声接続: {error}");if let Some(peer)=peers.remove(from){peer.close().await;}retry.insert(from.into(),Instant::now()+Duration::from_secs(3));}}
                                }
                            },
                            "error"=>{return Err(event[1]["message"].as_str().unwrap_or("通話サーバーのエラー").chars().take(512).collect());},
                            _=>{}
                        }
                    }
                },
                Some(event)=events.recv()=>{
                    let (id,generation)=match &event{Event::Signal(a,b,_)|Event::State(a,b,_)|Event::Data(a,b,_)|Event::Ready(a,b,_)|Event::Error(a,b,_)=>(a,b)};
                    if !peers.get(id).is_some_and(|p|&p.generation==generation){continue;}
                    match event{
                        Event::Signal(id,generation,data)=>signal_to(&mut socket,&id,&generation,data).await?,
                        Event::State(id,_,state)=>{
                            if matches!(state,RTCPeerConnectionState::Failed|RTCPeerConnectionState::Closed){if let Some(peer)=peers.remove(&id){peer.close().await;}mixer.lock().unwrap().remove(&id);retry.insert(id,Instant::now()+Duration::from_secs(3));}
                            else if let Some(peer)=peers.get_mut(&id){peer.connected=state==RTCPeerConnectionState::Connected;}
                        },
                        Event::Ready(id,_,channel)=>{
                            metadata.force();
                            radio.force();
                            if let Some(peer)=peers.get_mut(&id){peer.channel=Some(channel);}
                        },
                        Event::Data(id,_,data)=>{if let Some(version)=peer_version(&data,&self.game.borrow()){versions.insert(id.clone(),version);}accept_rules(&id,&data,&clients,&self.game.borrow(),server_host,&mut rules,&mut host_rules_known);if let Some(client)=clients[&id]["clientId"].as_i64(){let game=self.game.borrow();metadata.accept(client,&data,&game,host_id(&game,server_host));radio.accept(client,&data,&game,&rules);}},
                        Event::Error(_,_,error)=>{self.status.lock().unwrap().error=format!("音声受信: {error}");}
                    }
                },
                Some(frame)=audio_rx.recv(),if !self.synthetic=>{self.encode(&mut encoder,frame,&prefs,&mut peers,&mut vad,&mut gate,&mixer).await?;},
                _=synthetic_tick.tick(),if self.synthetic=>{
                    let frame=std::array::from_fn(|i|{(std::f32::consts::TAU*self.frequency*(tone_time+i as u64) as f32/RATE as f32).sin()*0.05});tone_time+=FRAME as u64;
                    self.metrics.captured.fetch_add(FRAME as u64,Ordering::Relaxed);self.encode(&mut encoder,frame,&prefs,&mut peers,&mut vad,&mut gate,&mixer).await?;audio::drain_test_sink(&mixer,&self.controls,&self.metrics);
                },
                _=tick.tick()=>{
                    if overflow.swap(false,Ordering::Relaxed){return Err("音声イベントが上限を超えたため再接続します".into());}
                    if last_ping.elapsed()>ping_timeout{return Err("通話サーバーから応答がありません".into());}
                    if self.shared.has_changed().unwrap_or(false){shared=self.shared.borrow_and_update().clone();own_rules=shared["myLobbySettings"].clone();}
                    let mut state=self.game.borrow().clone();let parsed_host=host_id(&state,server_host);metadata.decorate(&mut state,parsed_host,&radio.kinds());let phase=state["gameState"].as_i64();let meeting_hud=state["debug"]["meetingHudState"].as_i64();
                    let remote_frames={let mut remote=self.controls.remote.lock().unwrap();let frames=remote.sync(&state,&own_id);self.controls.remote_input.store(!remote.code.is_empty(),Ordering::Relaxed);frames};for(to,frame)in remote_frames{signal_to(&mut socket,&to,"",frame).await?;}
                    cosmetics.reconcile(self.app.as_ref(),&state,flag(&shared,"mobileHost"),flag(&shared,"obsOverlay"));if flag(&shared,"obsOverlay"){for(to,frame)in cosmetics.responses(){signal_to(&mut socket,&to,"",frame).await?;}}
                    if state["map"]!=4||phase!=Some(1){airship_spawn_until=Instant::now();}
                    else if (last_phase!=Some(1)&&state["oldGameState"]==2)||(last_meeting_hud!=Some(4)&&meeting_hud==Some(4)){airship_spawn_until=Instant::now()+Duration::from_secs(15);}
                    last_phase=phase;last_meeting_hud=meeting_hud;
                    if state.is_object(){state["nativeAirshipSpawnFallback"]=json!(airship_spawn_until>Instant::now());}
                    let access_clear=access.update(self.app.as_ref(),&state);{let mut status=self.status.lock().unwrap();status.access_status=access.status().into();if !access_clear{status.error=access.error().into();}else if ["参加可否を確認しています","このアカウントは通話を利用できません","参加可否を確認できません。再試行しています"].contains(&status.error.as_str()){status.error.clear();}}
                    let mut next=if access_clear{join_identity(&state).unwrap_or(Value::Null)}else{Value::Null};
                    let host=is_host(&state,server_host);
                    if next.is_object(){next["isHost"]=json!(host);}
                    if !own_id.is_empty()&&identity!=next{
                        self.controls.joined.store(false,Ordering::Relaxed);
                        self.controls.peers_ready.store(false,Ordering::Relaxed);
                        emit(&mut socket,json!(["leave"])).await?;
                        for (_,peer) in peers.drain(){peer.close().await;}mixer.lock().unwrap().clear();clients.clear();retry.clear();rules=own_rules.clone();host_rules_known=host;
                        self.controls.joined.store(false,Ordering::Relaxed);
                        while audio_rx.try_recv().is_ok() {}
                        if !next.is_null(){emit(&mut socket,json!(["id",next["playerId"],next["clientId"],next["friendCode"],next["playerUid"],next["playerIdentifier"]])).await?;emit(&mut socket,json!(["join",next["lobby"],next["playerId"],next["clientId"],host])).await?;}
                        identity=next;
                        radio=Radio::default();self.controls.radio.store(false,Ordering::Relaxed);self.controls.jackal_radio.store(false,Ordering::Relaxed);self.controls.radio_pending.store(false,Ordering::Relaxed);metadata.force();raw_vad.clear();mobile_running=false;mobile_frame=Value::Null;public_frame=Value::Null;obs_frame=Value::Null;
                        if host&&!identity.is_null(){emit(&mut socket,json!(["setHost",identity["lobby"],identity["clientId"]])).await?;}
                    }
                    if host {
                        if rules!=own_rules{let payload=own_rules.to_string();for (id,peer) in &peers{if let Some(channel)=&peer.channel{let _=tokio::time::timeout(Duration::from_millis(200),channel.send_text(&payload)).await;}signal_to(&mut socket,id,&peer.generation,json!({"type":"bcl-control","payload":payload})).await?;}}
                        rules=own_rules.clone();host_rules_known=true;
                    }
                    self.controls.joined.store(!identity.is_null()&&(host||host_rules_known),Ordering::Relaxed);
                    let stale:Vec<_>=peers.iter().filter(|(id,p)|!eligible(id,&clients,&state)||(!p.connected&&p.started.elapsed()>Duration::from_secs(30))).map(|(id,_)|id.clone()).collect();
                    for id in stale{if let Some(peer)=peers.remove(&id){peer.close().await;}mixer.lock().unwrap().remove(&id);}
                    if !identity.is_null(){
                        for id in clients.keys().filter(|id|eligible(id,&clients,&state)&&id.as_str()!=own_id).take(MAX_PEERS){
                            if peers.contains_key(id)||retry.get(id).is_some_and(|until|*until>Instant::now()){continue;}
                            serial+=1;let generation=format!("rust-{}-{serial}",std::process::id());mixer.lock().unwrap().add(id);
                            match Peer::new(id,generation,true,ice.clone(),tx.clone(),mixer.clone(),self.metrics.clone(),overflow.clone()).await{
                                Ok(peer)=>{match peer.offer().await{Ok(offer)=>{signal_to(&mut socket,id,&peer.generation,offer).await?;peers.insert(id.clone(),peer);},Err(error)=>{peer.close().await;self.status.lock().unwrap().error=error;retry.insert(id.clone(),Instant::now()+Duration::from_secs(3));}}},
                                Err(error)=>{self.status.lock().unwrap().error=error;retry.insert(id.clone(),Instant::now()+Duration::from_secs(3));}
                            }
                        }
                    }
                    let client_ids=peers.keys().filter_map(|id|clients[id]["clientId"].as_i64()).collect();radio.prune(&state,&rules,&client_ids);raw_vad.retain(|id,_|client_ids.contains(id));
                    let may_hold=matches!(phase,Some(1|2))&&local(&state).is_some_and(|p|!flag(p,"isDead")&&!flag(p,"disconnected"));
                    if !may_hold||(state["mod"]!="NoS"&&!local(&state).is_some_and(|p|super::routing::can_use_radio(&state,p,&rules))){self.controls.radio.store(false,Ordering::Relaxed);self.controls.jackal_radio.store(false,Ordering::Relaxed);}
                    let held=if state["mod"]=="NoS"{self.controls.radio.load(Ordering::Relaxed)||self.controls.jackal_radio.load(Ordering::Relaxed)}else{self.controls.radio.load(Ordering::Relaxed)};
                    let selected=self.controls.radio_kind.load(Ordering::Relaxed) as i64;
                    let previous_radio=radio.active();
                    if let Some(message)=radio.update_channels(&state,&rules,held,selected){
                        send_controls(&mut socket,&peers,&clients,vec![super::control::Outgoing{target:None,value:message}]).await?;
                    }
                    if radio.active()!=previous_radio{self.controls.radio_cue.store(audio::RADIO_FRAMES as u64,Ordering::Relaxed);}
                    self.controls.radio_pending.store(state["mod"]=="NoS"&&held&&!radio.active(),Ordering::Relaxed);
                    let game_muted=state["mod"]=="NoS"&&matches!(phase,Some(1|2))&&local(&state).is_some_and(|p|(rules["nosFixerJammingVoiceBlock"]!=false&&p["nosPlayer"]["isJammed"]==true)||state["nosLimitSpeechMuted"].as_array().is_some_and(|ids|ids.contains(&p["id"])));
                    self.controls.game_muted.store(game_muted,Ordering::Relaxed);
                    send_controls(&mut socket,&peers,&clients,metadata.outgoing(&state,parsed_host,&rules)).await?;
                    let radio_ids=radio.ids();
                    let selected_sources=sources.selected(&state,&clients);let voice_clients:serde_json::Map<String,Value>=clients.iter().filter(|(id,c)|c["clientId"].as_i64().is_some_and(|c|selected_sources.get(&c)==Some(id))).map(|(k,v)|(k.clone(),v.clone())).collect();
                    {let mut mix=mixer.lock().unwrap();mix.recordings.update(&state,&prefs,&shared,&voice_clients,(host||host_rules_known)&&access_clear,!self.controls.deafened.load(Ordering::Relaxed));for id in peers.keys(){let (routing,body)=if (host||host_rules_known)&&voice_clients.contains_key(id){super::rokuro::complete(&state,clients[id]["clientId"].as_i64().unwrap_or(-1),&rules,&prefs,&shared,&radio_ids)}else{(Route::default(),None)};mix.route(id,routing);mix.body(id,body);}}
                    if super::roles::addon(&state)&&!self.controls.remote_input.load(Ordering::Relaxed){if let (Some(app),Some(me))=(&self.app,local(&state)){let status=self.status.lock().unwrap().clone();let backend=app.state::<Arc<crate::Backend>>().inner().clone();let _=backend.request("main","native:addon:sample",vec![json!({"playerId":me["id"],"rms":status.input_level.clamp(0.,1.),"active":status.talking,"host":false})],"invoke").await;}}
                    let peers_ready=peers.values().any(|p|p.connected);
                    if quality_time.elapsed()>=Duration::from_secs(3){quality_time=Instant::now();let samples=futures_util::future::join_all(peers.iter_mut().map(|(id,peer)|async move{(id.clone(),peer.sample_quality(server_ping).await)})).await;qualities=samples.into_iter().filter_map(|(id,q)|q.map(|q|(id,q))).collect();}
                    self.controls.peers_ready.store(peers_ready,Ordering::Relaxed);
                    if !self.controls.transmitting(prefs.push_to_talk_mode)||!peers_ready {self.status.lock().unwrap().talking=false;}
                    let vad_hidden=game_muted||(state["gameState"]!=2&&local(&state).and_then(|p|p["shiftedColor"].as_i64()).is_some_and(|n|n!=-1));
                    {let mut status=self.status.lock().unwrap();status.vad_hidden=vad_hidden;if vad_hidden{status.talking=false;}}
                    let talking=self.status.lock().unwrap().talking;
                    if talking!=last_talking{emit(&mut socket,json!(["VAD",talking])).await?;last_talking=talking;}
                    if bridge_time.elapsed()>=Duration::from_millis(200){
                        bridge_time=Instant::now();
                        let mut speech_state=Value::Null;let mut speech_inputs=Vec::new();
                        if super::roles::addon(&state){if let Some(app)=&self.app{let backend=app.state::<Arc<crate::Backend>>().inner().clone();speech_state=backend.request("main","NOS_HERO_SPEECH_STATE",vec![],"invoke").await.unwrap_or(Value::Null);if let Some(me)=local(&state).filter(|_|self.controls.transmitting(prefs.push_to_talk_mode)){speech_inputs.push(("local".to_string(),me["id"].as_u64().unwrap_or(256)));}if host{for(id,c)in &clients{if matches!(metadata.platform(c["clientId"].as_i64().unwrap_or(-1)),Some("web"|"mobile"))&&state["players"].as_array().is_some_and(|ps|ps.iter().any(|p|p["clientId"]==c["clientId"]&&p["isDead"]!=true&&p["disconnected"]!=true)){speech_inputs.push((id.clone(),c["playerId"].as_u64().unwrap_or(256)));}}}}}
                        speech.configure(&speech_state,speech_inputs);mixer.lock().unwrap().speech=speech.sender();
                        if let Some(app)=&self.app{let backend=app.state::<Arc<crate::Backend>>().inner().clone();for event in speech.events(){match event{super::speech::Event::Ready(session,player)=>{let _=backend.request("main","NOS_HERO_SPEECH_READY",vec![json!(session),json!([player])],"send").await;},super::speech::Event::Word(session,player,request,kind)=>{let _=backend.request("main","NOS_HERO_SPEECH_WORD",vec![json!(session),json!(player),json!(request),json!(kind)],"send").await;},super::speech::Event::Error(error)=>{self.status.lock().unwrap().error=error;}}}}
                        let mut visible_radios=radio_ids.clone();if radio.active(){if let Some(id)=local(&state).and_then(|p|p["clientId"].as_i64()){visible_radios.push(id);}}
                        let connected=peers.iter().filter_map(|(id,p)|p.connected.then_some(id.clone())).collect();
                        let mut voice=super::bridge::voice_state(&state,&rules,&prefs,&shared,&voice_clients,&connected,&raw_vad,&visible_radios,talking,&self.controls);
                        {let remote=self.controls.remote.lock().unwrap();voice["remoteVoiceCode"]=json!(remote.code);voice["remoteVoiceConnected"]=json!(remote.connected());}
                        voice["connectionQuality"]=json!(qualities);if let Some(ping)=server_ping{voice["serverQuality"]=json!({"rttMs":null,"jitterMs":null,"lossPercent":null,"direct":false,"serverPingMs":ping});}
                        if let Some(extra)=metadata.snapshot(&state).as_object(){for(key,value)in extra{voice[key]=value.clone();}}
                        {let status=self.status.lock().unwrap();voice["connected"]=json!(status.connected);voice["error"]=json!(status.error);}
                        voice["talking"]=json!(talking);voice["activeLobbySettings"]=rules.clone();voice["hostId"]=json!(host_id(&state,server_host));
                        versions.retain(|id,_|peers.contains_key(id));
                        voice["versionWarning"]=json!(if versions.values().any(|v|v!="3.2.62"){"参加者のベタクルのバージョンが異なります。同じバージョンにそろえてください。"}else{""});
                        {let mut status=self.status.lock().unwrap();status.voice_snapshot=voice.clone();status.effective_game=state.clone();}
                        if let Some(app)=&self.app{
                            let backend=app.state::<Arc<crate::Backend>>().inner().clone();
                            if context_time.elapsed()>=Duration::from_millis(500){context_time=Instant::now();if let Ok(value)=backend.request("main","native:context",vec![],"invoke").await{context=value;}}
                            let enabled=flag(&shared,"enableOverlay");if overlay_enabled!=Some(enabled){overlay_enabled=Some(enabled);let _=backend.request("main","enableOverlay",vec![json!(enabled)],"invoke").await;}
                            ui.publish(app,&state,&voice,&shared,&rules,host_id(&state,server_host),&context);
                        }
                        let info=&context["gameInfo"];if info.is_object()&&info["broadcastVersion"].as_i64().is_some_and(|v|v>=0)&&*info!=sent_game_info{let mut wire=info.clone();wire["appVersion"]=json!("3.2.62");emit(&mut socket,json!(["gameinfo",wire])).await?;sent_game_info=info.clone();}
                        if let Some(listing)=super::bridge::public_lobby(&state,&rules){if listing!=public_frame{emit(&mut socket,json!(["lobby",state["lobbyCode"],listing])).await?;public_frame=listing;}}
                        if flag(&shared,"mobileHost")&&!identity.is_null(){
                            let target=format!("{}_mobile",state["lobbyCode"].as_str().unwrap_or(""));
                            if mobile_beacon.elapsed()>=Duration::from_secs(5){mobile_beacon=Instant::now();signal_to(&mut socket,&target,"",json!({"mobileHostInfo":{"isHostingMobile":true,"isGameHost":host}})).await?;}
                            if mobile_running{let mut frame=cosmetics.mobile(&state);frame["activeLobbySettings"]=rules.clone();if frame!=mobile_frame{signal_to(&mut socket,&target,"",frame.clone()).await?;mobile_frame=frame;}}
                        }
                        if flag(&shared,"obsOverlay"){if let Some(secret)=shared["obsSecret"].as_str().filter(|s|s.len()==9){if matches!(state["gameState"].as_i64(),Some(0..=2))||state["oldGameState"]!=state["gameState"]{let frame=super::bridge::obs_state(&state,&voice,&context["playerColors"]);if frame!=obs_frame||obs_time.elapsed()>=Duration::from_secs(5){signal_to(&mut socket,secret,"",frame.clone()).await?;obs_frame=frame;obs_time=Instant::now();}}}}
                    }
                    let mut status=self.status.lock().unwrap();status.lobby=identity["lobby"].as_str().unwrap_or("").into();status.peers=peers.values().filter(|p|p.connected).count();status.game_state=state["gameState"].as_i64();
                    status.radio_active=radio.active();status.radio_clients=radio_ids;
                    let may_radio=local(&state).is_some_and(|p|super::routing::can_use_radio(&state,p,&rules));
                    let channel=|kind|super::routing::radio_enabled(kind,&rules)&&state["nosRadios"].as_array().is_some_and(|rows|rows.iter().any(|r|r["kind"].as_i64()==Some(kind)));
                    status.radio_available=may_radio&&(state["mod"]!="NoS"||channel(0));status.jackal_radio_available=may_radio&&state["mod"]=="NoS"&&channel(1);
                    if !identity.is_null()&&!host&&!host_rules_known{status.error="ホストの通話設定を待っています".into();}
                    else if status.error.starts_with("ホストの通話設定")||status.error.starts_with("この部屋の設定"){status.error.clear();}
                }
            }}
            Ok(())
        }.await;
        self.controls.joined.store(false, Ordering::Relaxed);
        for (_, peer) in peers.drain() {
            peer.close().await;
        }
        mixer.lock().unwrap().clear();
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            emit(&mut socket, json!(["leave"])),
        )
        .await;
        let _ = tokio::time::timeout(Duration::from_millis(500), socket.close(None)).await;
        result
    }
    async fn encode(
        &self,
        encoder: &mut opus::Encoder,
        mut frame: Frame,
        prefs: &Preferences,
        peers: &mut HashMap<String, Peer>,
        vad: &mut Vad,
        gate: &mut Gate,
        mixer: &SharedMixer,
    ) -> Result<(), String> {
        let enabled = self.controls.transmitting(prefs.push_to_talk_mode);
        let sensitivity = if prefs.mic_sensitivity_enabled && !prefs.auto_gain_control {
            prefs.mic_sensitivity
        } else {
            0.15
        };
        vad.update(&frame, sensitivity);
        let manual_gain = if prefs.microphone_gain_enabled && !prefs.auto_gain_control {
            prefs.microphone_gain
        } else {
            1.0
        };
        for sample in &mut frame {
            let value = if prefs.mic_sensitivity_enabled && !prefs.auto_gain_control {
                gate.process(*sample, vad.active)
            } else {
                *sample
            };
            *sample = if enabled {
                (value * manual_gain).clamp(-0.98, 0.98)
            } else {
                0.0
            };
        }
        {
            let mut status = self.status.lock().unwrap();
            status.input_level = (frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            status.talking = enabled && vad.active && !status.vad_hidden;
        }
        {
            let mut mix = mixer.lock().unwrap();
            mix.recordings.local(
                &frame,
                enabled && !self.controls.deafened.load(Ordering::Relaxed),
            );
            if enabled {
                if let Some(speech) = &mix.speech {
                    speech.push("local", &frame);
                }
            }
        }
        if !peers.values().any(|p| p.connected) {
            return Ok(());
        }
        let mut buffer = [0u8; 4096];
        let n = encoder
            .encode_float(&frame, &mut buffer)
            .map_err(|e| e.to_string())?;
        let bytes = Bytes::copy_from_slice(&buffer[..n]);
        for peer in peers.values_mut().filter(|p| p.connected) {
            if tokio::time::timeout(Duration::from_millis(40), peer.send(bytes.clone()))
                .await
                .is_ok_and(|r| r.is_ok())
            {
                self.metrics.sent.fetch_add(1, Ordering::Relaxed);
            } else {
                self.metrics
                    .dropped
                    .fetch_add(FRAME as u64, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}
async fn send(socket: &mut Socket, text: String) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_secs(3),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| "通話サーバーへの送信がタイムアウトしました")?
    .map_err(|e| e.to_string())
}
async fn emit(socket: &mut Socket, event: Value) -> Result<(), String> {
    send(socket, format!("42{event}")).await
}
async fn signal_to(
    socket: &mut Socket,
    id: &str,
    generation: &str,
    mut data: Value,
) -> Result<(), String> {
    if !generation.is_empty() {
        data["connectionId"] = json!(generation);
    }
    emit(socket, json!(["signal",{"to":id,"data":data}])).await
}
pub fn parse_event(text: &str) -> Option<Vec<Value>> {
    let text = text.strip_prefix("42")?;
    let event: Vec<Value> = serde_json::from_str(text).ok()?;
    if event.len() > 8 || event.first()?.as_str()?.len() > 128 {
        return None;
    }
    Some(event)
}
fn valid_client(v: &Value) -> bool {
    v["clientId"].as_i64().is_some() && v["playerId"].as_u64().is_some_and(|n| n <= 255)
}
async fn send_controls(
    socket: &mut Socket,
    peers: &HashMap<String, Peer>,
    clients: &serde_json::Map<String, Value>,
    frames: Vec<super::control::Outgoing>,
) -> Result<(), String> {
    let mut requests = Vec::new();
    for frame in frames {
        let payload: Arc<str> = frame.value.to_string().into();
        if payload.len() > 65536 {
            continue;
        }
        for (id, peer) in peers {
            if frame
                .target
                .is_some_and(|client| clients[id]["clientId"].as_i64() != Some(client))
            {
                continue;
            }
            requests.push((
                id.clone(),
                peer.generation.clone(),
                peer.channel.clone(),
                payload.clone(),
            ));
        }
    }
    // One slow data channel must not stall microphone encoding for every peer.
    let results = futures_util::future::join_all(requests.into_iter().map(
        |(id, generation, channel, payload)| async move {
            let sent = if let Some(channel) = channel {
                tokio::time::timeout(
                    Duration::from_millis(10),
                    channel.send_text(payload.as_ref()),
                )
                .await
                .is_ok_and(|r| r.is_ok())
            } else {
                false
            };
            (id, generation, payload, sent)
        },
    ))
    .await;
    for (id, generation, payload, sent) in results {
        if !sent {
            signal_to(
                socket,
                &id,
                &generation,
                json!({"type":"bcl-control","payload":payload.as_ref()}),
            )
            .await?;
        }
    }
    Ok(())
}
fn peer_version(data: &Value, state: &Value) -> Option<String> {
    if data["type"] != "app-version" || data["lobbyCode"] != state["lobbyCode"] {
        return None;
    }
    let version = data["version"].as_str()?;
    (!version.is_empty()
        && version.len() <= 64
        && version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c)))
    .then(|| version.to_owned())
}
fn client_map(v: &Value) -> serde_json::Map<String, Value> {
    v.as_object()
        .into_iter()
        .flatten()
        .filter(|(id, v)| id.len() <= 128 && valid_client(v))
        .take(MAX_PEERS + 1)
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect()
}
fn eligible(id: &str, clients: &serde_json::Map<String, Value>, state: &Value) -> bool {
    let Some(client) = clients.get(id) else {
        return false;
    };
    state["players"].as_array().is_some_and(|ps| {
        ps.iter().any(|p| {
            p["clientId"] == client["clientId"]
                && p["id"] == client["playerId"]
                && !flag(p, "isLocal")
                && !flag(p, "disconnected")
                && !flag(p, "isDummy")
        })
    })
}
fn host_id(state: &Value, server: i64) -> i64 {
    state["hostId"]
        .as_i64()
        .filter(|id| *id > 0)
        .unwrap_or(server)
}
fn is_host(state: &Value, server: i64) -> bool {
    local(state).is_some_and(|p| p["clientId"].as_i64() == Some(host_id(state, server)))
}
fn accept_rules(
    id: &str,
    data: &Value,
    clients: &serde_json::Map<String, Value>,
    state: &Value,
    server: i64,
    rules: &mut Value,
    known: &mut bool,
) {
    if clients.get(id).and_then(|c| c["clientId"].as_i64()) != Some(host_id(state, server))
        || is_host(state, server)
    {
        return;
    }
    if let Some(max) = data["maxDistance"]
        .as_f64()
        .filter(|v| v.is_finite() && (0.2..=100.0).contains(v))
    {
        let mut next = data.clone();
        next["maxDistance"] = json!(max);
        *rules = next;
        *known = true;
    }
}
fn default_ice() -> RTCConfiguration {
    RTCConfigurationBuilder::default()
        .with_ice_servers(vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".into()],
            ..Default::default()
        }])
        .build()
}
pub fn parse_ice(value: &Value) -> Result<RTCConfiguration, String> {
    let force = value["forceRelayOnly"]
        .as_bool()
        .ok_or("Invalid ICE policy")?;
    let list = value["iceServers"]
        .as_array()
        .filter(|a| a.len() <= 16)
        .ok_or("Invalid ICE servers")?;
    let mut servers = Vec::new();
    let mut turn = false;
    for item in list {
        let urls: Vec<String> = if let Some(url) = item["urls"].as_str() {
            vec![url.into()]
        } else {
            item["urls"]
                .as_array()
                .filter(|a| a.len() <= 8)
                .ok_or("Invalid ICE URLs")?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or("Invalid ICE URL"))
                .collect::<Result<_, _>>()?
        };
        for url in &urls {
            if url.len() > 2048
                || !url.starts_with("stun:")
                    && !url.starts_with("stuns:")
                    && !url.starts_with("turn:")
                    && !url.starts_with("turns:")
            {
                return Err("Invalid ICE URL scheme".into());
            }
            turn |= url.starts_with("turn:") || url.starts_with("turns:");
        }
        let username = item["username"].as_str().unwrap_or("");
        let credential = item["credential"].as_str().unwrap_or("");
        if username.len() > 1024 || credential.len() > 2048 {
            return Err("Invalid ICE credentials".into());
        }
        servers.push(RTCIceServer {
            urls,
            username: username.into(),
            credential: credential.into(),
            ..Default::default()
        });
    }
    if force && !turn {
        return Err("中継専用の通話サーバーにTURN設定がありません".into());
    }
    Ok(RTCConfigurationBuilder::default()
        .with_ice_servers(servers)
        .with_ice_transport_policy(if force {
            RTCIceTransportPolicy::Relay
        } else {
            RTCIceTransportPolicy::All
        })
        .build())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signaling_bounds_and_relay_policy() {
        assert!(parse_event("42[\"setHost\",1]").is_some());
        assert!(parse_event("43[\"setHost\",1]").is_none());
        assert!(parse_ice(&json!({"forceRelayOnly":true,"iceServers":[]})).is_err());
        assert!(
            parse_ice(&json!({"forceRelayOnly":false,"iceServers":[{"urls":"file:///x"}]}))
                .is_err()
        );
        assert!(parse_ice(&json!({"forceRelayOnly":false,"iceServers":[]})).is_ok());
    }
    #[test]
    fn only_game_host_can_change_audio_rules() {
        let state = json!({"hostId":1,"players":[{"id":2,"clientId":2,"isLocal":true}]});
        let clients = serde_json::from_value(
            json!({"host":{"playerId":1,"clientId":1},"guest":{"playerId":3,"clientId":3}}),
        )
        .unwrap();
        let mut rules = json!({});
        let mut known = false;
        accept_rules(
            "guest",
            &json!({"maxDistance":99}),
            &clients,
            &state,
            0,
            &mut rules,
            &mut known,
        );
        assert!(!known);
        accept_rules(
            "host",
            &json!({"maxDistance":5.32}),
            &clients,
            &state,
            0,
            &mut rules,
            &mut known,
        );
        assert!(known);
        assert_eq!(rules["maxDistance"], 5.32);
    }
}
