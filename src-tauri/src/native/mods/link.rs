//! One bounded, nonblocking loopback connection to the selected NoS addon.
//! Legacy UDP carries levels and recognition results, never microphone PCM.
use super::addon::{channels, link_port, now, read_json, row_valid};
use serde_json::{json, Value};
use std::{
    io::{ErrorKind, Read, Write},
    net::{SocketAddr, TcpStream, UdpSocket},
    path::PathBuf,
    time::{Duration, Instant},
};

fn token(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 32
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn fresh(v: &Value, stamp: &str, ttl: u64, t: u64) -> bool {
    v[stamp]
        .as_u64()
        .is_some_and(|s| s <= t + 100 && t.saturating_sub(s) <= ttl)
}
fn port(v: &Value) -> Option<u16> {
    v["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .map(|p| p as u16)
}
fn nonce() -> String {
    let mut bytes = [0; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn root() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("TanukiBCL/NoS"))
}
fn descriptor(name: &str, limit: usize) -> Option<Value> {
    read_json(&root()?.join(name), limit).ok()
}
pub fn profile_valid(v: &Value, pid: u32, session: &str, previous: u64, t: u64) -> bool {
    v["kind"] == "state"
        && v["protocol"] == 1
        && v["pid"] == pid
        && v["session"] == session
        && v["sequence"]
            .as_u64()
            .is_some_and(|n| n > previous && n <= 9_007_199_254_740_991)
        && fresh(v, "unixMs", 700, t)
        && matches!(v["phase"].as_str(), Some("lobby" | "tasks" | "meeting"))
        && v["localPlayer"].as_u64().is_some_and(|n| n <= 255)
        && v["host"].is_boolean()
        && channels(&v["channels"], t)
}
pub struct Link {
    pid: u32,
    scope: String,
    port: u16,
    stream: Option<TcpStream>,
    buffer: Vec<u8>,
    pending: Vec<u8>,
    nonce: String,
    session: String,
    sequence: u64,
    profile: Value,
    next_attempt: u64,
    next_discovery: u64,
    next_poll: u64,
    last_io: Instant,
    phase: String,
    local: u64,
    udp: Option<UdpSocket>,
    discovery_nonce: String,
    discovered: Value,
    discovered_at: u64,
    next_udp: u64,
    voice: Value,
    host: Value,
    speech: Value,
    legacy_sequence: u64,
}
impl Default for Link {
    fn default() -> Self {
        Self {
            pid: 0,
            scope: String::new(),
            port: 0,
            stream: None,
            buffer: Vec::new(),
            pending: Vec::new(),
            nonce: String::new(),
            session: String::new(),
            sequence: 0,
            profile: Value::Null,
            next_attempt: 0,
            next_discovery: 0,
            next_poll: 0,
            last_io: Instant::now(),
            phase: String::new(),
            local: 256,
            udp: None,
            discovery_nonce: nonce(),
            discovered: Value::Null,
            discovered_at: 0,
            next_udp: 0,
            voice: Value::Null,
            host: Value::Null,
            speech: Value::Null,
            legacy_sequence: 0,
        }
    }
}
impl Link {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    fn disconnect(&mut self) {
        self.stream = None;
        self.buffer.clear();
        self.pending.clear();
        self.session.clear();
        self.sequence = 0;
        self.profile = Value::Null;
    }
    fn accept(&mut self, v: Value) -> Result<(), String> {
        if self.session.is_empty() {
            if v["kind"] != "hello"
                || v["protocol"] != 1
                || v["pid"] != self.pid
                || v["nonce"] != self.nonce
                || !token(&v["session"])
            {
                return Err("Invalid addon hello".into());
            }
            self.session = v["session"].as_str().unwrap().into();
            self.next_poll = 0;
        } else if profile_valid(
            &v,
            self.pid,
            &self.session,
            self.profile["sequence"].as_u64().unwrap_or(0),
            now(),
        ) && v["phase"] == self.phase
            && v["localPlayer"] == self.local
        {
            self.profile = v;
        }
        Ok(())
    }
    fn receive(&mut self) -> Result<(), String> {
        let mut bytes = [0; 8192];
        let mut frames = 0;
        for _ in 0..17 {
            let n = match self
                .stream
                .as_mut()
                .ok_or("No addon socket")?
                .read(&mut bytes)
            {
                Ok(0) => return Err("Addon closed".into()),
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.to_string()),
            };
            self.last_io = Instant::now();
            self.buffer.extend_from_slice(&bytes[..n]);
            while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                frames += 1;
                if frames > 64 || end >= 131072 {
                    return Err("Oversized addon frame".into());
                }
                let frame: Value =
                    serde_json::from_slice(&self.buffer[..end]).map_err(|e| e.to_string())?;
                self.buffer.drain(..=end);
                self.accept(frame)?;
            }
            if self.buffer.len() >= 131072 {
                return Err("Oversized addon buffer".into());
            }
        }
        Ok(())
    }
    fn flush(&mut self) -> bool {
        while !self.pending.is_empty() {
            match self
                .stream
                .as_mut()
                .and_then(|s| s.write(&self.pending).ok())
            {
                Some(0) => return false,
                Some(n) => {
                    self.pending.drain(..n);
                }
                None => return false,
            }
        }
        true
    }
    fn send(&mut self, kind: &str, fields: Value) -> bool {
        if self.stream.is_none() || self.session.is_empty() || self.pending.len() > 131072 {
            return false;
        }
        self.sequence += 1;
        let mut v = fields;
        v["kind"] = json!(kind);
        v["protocol"] = json!(1);
        v["pid"] = json!(self.pid);
        v["session"] = json!(self.session);
        v["sequence"] = json!(self.sequence);
        v["unixMs"] = json!(now());
        let text = format!("{v}\n");
        if self.pending.len() + text.len() > 131072 {
            return false;
        }
        self.pending.extend_from_slice(text.as_bytes());
        self.flush();
        true
    }
    pub fn current(&self) -> Option<&Value> {
        let t = now();
        (self.profile.is_object()
            && fresh(&self.profile, "unixMs", 700, t)
            && self.profile["phase"] == self.phase
            && self.profile["localPlayer"] == self.local)
            .then_some(&self.profile)
    }
    pub fn update(&mut self, pid: u32, state: &Value, marker: &Value) -> Option<Value> {
        let enabled = state["mod"] == "NoS"
            && state["nosAddonIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|s| s == "tanuki.bcl.roles"));
        let phase = state["gameState"].as_i64().unwrap_or(3);
        if !enabled || !matches!(phase, 0..=2) {
            self.clear();
            return None;
        }
        let scope = format!("{pid}:{}:{}", state["lobbyCode"], phase != 0);
        if self.scope != scope {
            self.clear();
            self.pid = pid;
            self.scope = scope;
        }
        self.phase = match phase {
            0 => "lobby",
            2 => "meeting",
            _ => "tasks",
        }
        .into();
        self.local = state["players"]
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["isLocal"] == true))
            .and_then(|p| p["id"].as_u64())
            .unwrap_or(256);
        let t = now();
        let mut discovered = link_port(marker);
        if discovered.is_none() && t >= self.next_discovery {
            self.next_discovery = t + 500;
            discovered = descriptor(&format!("addon-link-{pid}.json"), 4096)
                .filter(|d| d["protocol"] == 1 && d["pid"] == pid && fresh(d, "unixMs", 2500, t))
                .and_then(|d| port(&d));
        }
        if let Some(port) = discovered {
            if self.port != port {
                self.disconnect();
                self.port = port;
                self.next_attempt = 0;
            }
        }
        if self.port != 0 && self.stream.is_none() && t >= self.next_attempt {
            self.next_attempt = t + 500;
            if let Ok(stream) = TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], self.port)),
                Duration::from_millis(10),
            ) {
                let _ = stream.set_nonblocking(true);
                let _ = stream.set_nodelay(true);
                self.stream = Some(stream);
                self.nonce = nonce();
                self.pending = format!(
                    "{}\n",
                    json!({"kind":"hello","protocol":1,"pid":pid,"nonce":self.nonce})
                )
                .into_bytes();
                self.last_io = Instant::now();
                self.flush();
            }
        }
        if self.stream.is_some() {
            self.flush();
            if self.receive().is_err() {
                self.disconnect();
            } else if !self.session.is_empty() && t >= self.next_poll {
                self.next_poll = t + 100;
                self.send("poll",json!({"accepted":self.current().map(|p|p["sequence"].clone()).unwrap_or(json!(0))}));
            }
            if self.last_io.elapsed() > Duration::from_secs(2)
                || (self.profile.is_object() && !fresh(&self.profile, "unixMs", 1500, t))
            {
                self.disconnect();
            }
        }
        self.legacy_poll(state, t);
        self.current().map(|p| p["channels"].clone())
    }
    fn udp(&mut self) -> Option<&UdpSocket> {
        if self.udp.is_none() {
            let socket = UdpSocket::bind(("127.0.0.1", 0)).ok()?;
            socket.set_nonblocking(true).ok()?;
            self.udp = Some(socket);
        }
        self.udp.as_ref()
    }
    fn datagram(&mut self, text: String, port: u16) -> bool {
        self.udp()
            .is_some_and(|s| s.send_to(text.as_bytes(), ("127.0.0.1", port)).is_ok())
    }
    fn legacy_poll(&mut self, state: &Value, t: u64) {
        if t < self.next_udp {
            return;
        }
        self.next_udp = t + 250;
        self.voice = descriptor("voice-role.json", 4096)
            .filter(|v| voice_descriptor(v, self.pid, self.local))
            .unwrap_or(Value::Null);
        self.host = if state["isHost"] == true {
            descriptor(&format!("host-voice-{}.json", self.pid), 4096)
                .filter(|v| {
                    v["protocol"] == 1
                        && v["pid"] == self.pid
                        && token(&v["token"])
                        && port(v).is_some()
                })
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        self.speech = descriptor(&format!("hero-speech-{}.json", self.pid), 32768)
            .filter(|v| speech_descriptor(v, self.pid, t))
            .unwrap_or(Value::Null);
        let request = format!("TBCLD1|{}|{}", self.pid, self.discovery_nonce);
        self.datagram(request, 57741);
        let mut bytes = [0; 4097];
        for _ in 0..8 {
            let Some(result) = self.udp().map(|s| s.recv_from(&mut bytes)) else {
                break;
            };
            let Ok((n, from)) = result else { break };
            if from != SocketAddr::from(([127, 0, 0, 1], 57741)) || n > 4096 {
                continue;
            }
            if let Ok(text) = std::str::from_utf8(&bytes[..n]) {
                if let Some(payload) =
                    text.strip_prefix(&format!("TBCLD1|{}|", self.discovery_nonce))
                {
                    if let Ok(v) = serde_json::from_str(payload) {
                        if voice_descriptor(&v, self.pid, self.local) {
                            self.discovered = v;
                            self.discovered_at = t;
                        }
                    }
                }
            }
        }
    }
    pub fn sample(
        &mut self,
        state: &Value,
        player: u64,
        rms: f32,
        active: bool,
        host: bool,
    ) -> bool {
        let phase = state["gameState"].as_i64();
        if self.pid == 0
            || !rms.is_finite()
            || !(0.0..=1.0).contains(&rms)
            || !matches!(phase, Some(0..=2))
            || host && state["isHost"] != true
        {
            return false;
        }
        let Some(p) = state["players"].as_array().and_then(|ps| {
            ps.iter()
                .find(|p| p["id"] == player && p["isDead"] != true && p["disconnected"] != true)
        }) else {
            return false;
        };
        if !host && p["isLocal"] != true {
            return false;
        }
        if self.current().is_some()
            && self.send(
                "sample",
                json!({"playerId":player,"rms":rms,"active":active,"version":"3.2.62","host":host}),
            )
        {
            return true;
        }
        let t = now();
        let d = if host {
            self.host.clone()
        } else if t.saturating_sub(self.discovered_at) < 1000 {
            self.discovered.clone()
        } else {
            self.voice.clone()
        };
        let Some(port) = port(&d) else { return false };
        if !host {
            let role = d["role"].as_str().unwrap_or("");
            if (role == "tanukiMicTest") != (phase == Some(0))
                || phase == Some(2)
                    && !matches!(
                        role,
                        "tanukiTalkative" | "tanukiBclBibiri" | "tanukiVoiceRoles"
                    )
            {
                return false;
            }
        }
        self.legacy_sequence = (self.legacy_sequence + 1).max(t * 1000);
        let base = if host {
            format!(
                "TBCLH1|{}|{player}|{}|{t}|{rms}|{}",
                d["token"].as_str().unwrap_or(""),
                self.legacy_sequence,
                u8::from(active)
            )
        } else {
            format!(
                "TBCL1|{}|{}|{t}|{rms}|{}",
                d["token"].as_str().unwrap_or(""),
                self.legacy_sequence,
                u8::from(active)
            )
        };
        self.datagram(
            if d["reportVersion"] == true {
                base + "|3.2.62"
            } else {
                base
            },
            port,
        )
    }
    pub fn speech_state(&self) -> Value {
        if !matches!(self.phase.as_str(), "tasks" | "meeting") {
            return Value::Null;
        }
        let (session, players) = if let Some(p) = self.current() {
            (p["session"].clone(), p["channels"]["speech"].clone())
        } else if speech_descriptor(&self.speech, self.pid, now()) {
            (self.speech["token"].clone(), self.speech["players"].clone())
        } else {
            return Value::Null;
        };
        let players: Vec<_> = players
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["request"] == 0 || p["expires"].as_u64().unwrap_or(0) > now())
            .cloned()
            .collect();
        if players.is_empty() {
            Value::Null
        } else {
            json!({"pid":self.pid,"session":session,"players":players})
        }
    }
    pub fn speech_command(
        &mut self,
        state: &Value,
        kind: &str,
        session: &str,
        player: u64,
        request: u64,
        speech_kind: &str,
        word: &str,
    ) -> bool {
        let d = self.speech_state();
        if d["session"] != session
            || !(state["isHost"] == true
                || state["players"]
                    .as_array()
                    .is_some_and(|ps| ps.iter().any(|p| p["id"] == player && p["isLocal"] == true)))
        {
            return false;
        }
        let Some(armed) = d["players"].as_array().and_then(|ps| {
            ps.iter().find(|p| {
                p["playerId"] == player
                    && (kind == "ready"
                        || p["request"] == request
                            && request > 0
                            && p["kind"] == speech_kind
                            && p["expires"].as_u64().unwrap_or(0) > now())
            })
        }) else {
            return false;
        };
        if kind == "word"
            && speech_kind == "stone"
            && !crate::voice::speech::valid_stone_word(
                word,
                armed["maxCharacters"].as_u64().unwrap_or(0) as usize,
            )
        {
            return false;
        }
        if self.current().is_some() {
            return self.send(
                kind,
                if kind == "ready" {
                    json!({"players":[player]})
                } else {
                    let mut payload =
                        json!({"playerId":player,"request":request,"speechKind":speech_kind});
                    if speech_kind == "stone" {
                        payload["word"] = json!(word);
                    }
                    payload
                },
            );
        }
        let Some(port) = port(&self.speech) else {
            return false;
        };
        let t = now();
        let text = if kind == "ready" {
            format!("TBCLHS2|{session}|ready|{t}|{player}|1")
        } else {
            format!(
                "TBCLHS2|{session}|word|{t}|{player}|{request}|{}",
                if speech_kind == "stone" {
                    use base64::Engine;
                    format!(
                        "stone|{}",
                        base64::engine::general_purpose::STANDARD.encode(word.as_bytes())
                    )
                } else if speech_kind == "ng" {
                    "ng".into()
                } else {
                    "henshin".into()
                }
            )
        };
        self.datagram(text, port)
    }
    pub fn parrot_capture(
        &mut self,
        state: &Value,
        owner: &Value,
        bird: &Value,
        source: &Value,
    ) -> bool {
        if state["mod"] != "NoS"
            || state["gameState"] != 1
            || state["isHost"] != true
            || !source.as_u64().is_some_and(|v| v <= 255)
            || !self.current().is_some_and(|p| {
                p["host"] == true
                    && p["channels"]["parrots"].as_array().is_some_and(|rs| {
                        rs.iter()
                            .any(|r| r["ownerId"] == *owner && r["birdId"] == *bird)
                    })
            })
        {
            return false;
        }
        self.send(
            "parrot",
            json!({"ownerId":owner,"birdId":bird,"sourceId":source}),
        )
    }
}
fn voice_descriptor(v: &Value, pid: u32, player: u64) -> bool {
    v["protocol"] == 1
        && v["pid"] == pid
        && v["playerId"] == player
        && port(v).is_some()
        && token(&v["token"])
        && matches!(
            v["role"].as_str(),
            Some(
                "tanukiMegaphone"
                    | "tanukiBclBibiri"
                    | "tanukiTalkative"
                    | "tanukiMicTest"
                    | "tanukiVoiceRoles"
            )
        )
}
fn speech_descriptor(v: &Value, pid: u32, t: u64) -> bool {
    v["protocol"] == 2
        && v["pid"] == pid
        && port(v).is_some()
        && token(&v["token"])
        && fresh(v, "updated", 1500, t)
        && v["players"].as_array().is_some_and(|ps| {
            let mut seen = std::collections::HashSet::new();
            !ps.is_empty()
                && ps.len() <= 72
                && ps.iter().all(|p| {
                    row_valid("speech", p, t)
                        && (p["request"] == 0 || p["expires"].as_u64().unwrap_or(0) + 100 >= t)
                        && seen.insert(format!("{}:{}", p["playerId"], p["kind"]))
                })
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_stream_handles_fragmented_state_and_sends_authenticated_samples() {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let hello = json!({"kind":"hello","protocol":1,"pid":42,"nonce":"b".repeat(32),"session":"a".repeat(32)});
            let state = json!({"kind":"state","protocol":1,"pid":42,"session":"a".repeat(32),"sequence":1,"unixMs":now(),"phase":"tasks","localPlayer":1,"host":false,"channels":{"heroes":[],"portable":[],"megaphones":[],"dying":[],"interviews":[],"jamming":[],"echoes":[],"muted":[],"speech":[]}});
            let frames = format!("{hello}\n{state}\n");
            stream.write_all(&frames.as_bytes()[..17]).unwrap();
            std::thread::sleep(Duration::from_millis(5));
            stream.write_all(&frames.as_bytes()[17..]).unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            tx.send(serde_json::from_str::<Value>(&line).unwrap())
                .unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        stream.set_nonblocking(true).unwrap();
        let mut link = Link::default();
        link.pid = 42;
        link.stream = Some(stream);
        link.nonce = "b".repeat(32);
        link.phase = "tasks".into();
        link.local = 1;
        let deadline = Instant::now() + Duration::from_secs(2);
        while link.current().is_none() {
            link.receive().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        let game = json!({"gameState":1,"players":[{"id":1,"isLocal":true}]});
        assert!(link.sample(&game, 1, 0.4, true, false));
        let packet = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(packet["kind"], "sample");
        assert_eq!(packet["session"], "a".repeat(32));
        assert_eq!(packet["playerId"], 1);
        assert!(!link.sample(&game, 2, 0.4, true, false));
        server.join().unwrap();
    }
    #[test]
    fn publications_are_session_bound_monotonic_and_fresh() {
        let t = now();
        let mut v = json!({"kind":"state","protocol":1,"pid":42,"session":"session","sequence":2,"unixMs":t,"phase":"tasks","localPlayer":1,"host":false,"channels":{"heroes":[],"portable":[],"megaphones":[],"dying":[],"interviews":[],"jamming":[],"echoes":[],"muted":[],"speech":[]}});
        assert!(profile_valid(&v, 42, "session", 1, t));
        assert!(!profile_valid(&v, 42, "session", 2, t));
        assert!(!profile_valid(&v, 43, "session", 1, t));
        assert!(!profile_valid(&v, 42, "old", 1, t));
        assert!(!profile_valid(&v, 42, "session", 1, t + 701));
        v["channels"]["portable"] = json!([{"playerId":1,"extraRange":31}]);
        assert!(!profile_valid(&v, 42, "session", 1, t));
    }
    #[test]
    fn stone_and_parrot_commands_are_authorized_and_utf8_encoded() {
        use base64::Engine;
        let udp = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        udp.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let t = now();
        let token = "a".repeat(32);
        let mut link = Link::default();
        link.pid = 42;
        link.phase = "tasks".into();
        link.speech = json!({"protocol":2,"pid":42,"port":udp.local_addr().unwrap().port(),"token":token,"updated":t,"players":[{"playerId":1,"kind":"stone","request":7,"expires":t+10000,"words":[],"maxCharacters":3}]});
        let game =
            json!({"mod":"NoS","gameState":1,"isHost":false,"players":[{"id":1,"isLocal":true}]});
        assert!(!link.speech_command(&game, "word", &token, 1, 7, "stone", "猫 犬"));
        assert!(!link.speech_command(&game, "word", "old", 1, 7, "stone", "猫"));
        assert!(!link.speech_command(&game, "word", &token, 1, 8, "stone", "猫"));
        assert!(!link.speech_command(&game, "word", &token, 2, 7, "stone", "猫"));
        assert!(link.speech_command(&game, "word", &token, 1, 7, "stone", "猫"));
        let mut data = [0; 2048];
        let n = udp.recv(&mut data).unwrap();
        let packet = String::from_utf8_lossy(&data[..n]);
        assert!(packet.ends_with(&format!(
            "|1|7|stone|{}",
            base64::engine::general_purpose::STANDARD.encode("猫")
        )));
        assert!(!link.parrot_capture(&game, &json!(1), &json!(2), &json!(1)));
        let tcp = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        link.stream = Some(TcpStream::connect(tcp.local_addr().unwrap()).unwrap());
        link.session = token.clone();
        link.local = 1;
        link.profile = json!({"unixMs":now(),"phase":"tasks","localPlayer":1,"host":true,"session":token,
            "channels":{"parrots":[{"ownerId":1,"birdId":2}],"speech":link.speech["players"]}});
        let mut host = game.clone();
        host["isHost"] = json!(true);
        assert!(!link.parrot_capture(&game, &json!(1), &json!(2), &json!(1)));
        assert!(!link.parrot_capture(&host, &json!(1), &json!(3), &json!(1)));
        assert!(link.parrot_capture(&host, &json!(1), &json!(2), &json!(1)));
        assert!(link.speech_command(&host, "word", &token, 1, 7, "stone", "猫"));
        use std::io::{BufRead, BufReader};
        let (stream, _) = tcp.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let packet: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(packet["kind"], "parrot");
        assert_eq!(packet["sourceId"], 1);
        assert_eq!(packet["session"], token);
        line.clear();
        reader.read_line(&mut line).unwrap();
        let packet: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(packet["kind"], "word");
        assert_eq!(packet["word"], "猫");
        assert_eq!(packet["speechKind"], "stone");
    }
}
