use super::{audio::SharedMixer, model::*};
use bytes::Bytes;
use rtc::{
    media_stream::MediaStreamTrack,
    rtp::{header::Header, packet::Packet},
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    media_stream::{
        track_local::static_rtp::TrackLocalStaticRTP,
        track_remote::{TrackRemote, TrackRemoteEvent},
    },
    peer_connection::*,
};

pub enum Event {
    Signal(String, String, Value),
    State(String, String, RTCPeerConnectionState),
    Data(String, String, Value),
    Ready(String, String, Arc<dyn DataChannel>),
    Error(String, String, String),
}
struct Handler {
    id: String,
    generation: String,
    tx: mpsc::Sender<Event>,
    mixer: SharedMixer,
    metrics: Arc<Metrics>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    overflow: Arc<AtomicBool>,
    receiving: AtomicBool,
}
impl Handler {
    fn emit(&self, event: Event) {
        if self.tx.try_send(event).is_err() {
            self.overflow.store(true, Ordering::Relaxed);
        }
    }
    fn channel(&self, channel: Arc<dyn DataChannel>) {
        let tx = self.tx.clone();
        let id = self.id.clone();
        let generation = self.generation.clone();
        let overflow = self.overflow.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                let event = match event {
                    DataChannelEvent::OnOpen => Some(Event::Ready(
                        id.clone(),
                        generation.clone(),
                        channel.clone(),
                    )),
                    DataChannelEvent::OnMessage(msg) if msg.data.len() <= 65_536 => {
                        serde_json::from_slice(&msg.data)
                            .ok()
                            .map(|v| Event::Data(id.clone(), generation.clone(), v))
                    }
                    DataChannelEvent::OnClose => break,
                    _ => None,
                };
                if let Some(event) = event {
                    if tx.try_send(event).is_err() {
                        overflow.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
        });
        self.tasks.lock().unwrap().push(task);
    }
}
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(mut candidate) = event.candidate.to_json() {
            // The core's generic to_json() uses an empty MID. The audio section
            // is the first m-line; Chrome accepts an absent MID with index=0.
            candidate.sdp_mid = None;
            self.emit(Event::Signal(
                self.id.clone(),
                self.generation.clone(),
                json!({"type":"candidate","candidate":candidate}),
            ));
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.emit(Event::State(
            self.id.clone(),
            self.generation.clone(),
            state,
        ));
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        self.channel(channel);
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if track.kind().await != RtpCodecKind::Audio || self.receiving.swap(true, Ordering::Relaxed)
        {
            return;
        }
        let id = self.id.clone();
        let mixer = self.mixer.clone();
        let metrics = self.metrics.clone();
        let tx = self.tx.clone();
        let generation = self.generation.clone();
        self.tasks.lock().unwrap().push(tokio::spawn(async move {
            if let Err(error) = receive(track, &id, mixer, metrics).await {
                let _ = tx.try_send(Event::Error(id, generation, error));
            }
        }));
    }
}

pub struct Peer {
    pub started: std::time::Instant,
    pub pc: Arc<dyn PeerConnection>,
    pub generation: String,
    pub initiator: bool,
    pub connected: bool,
    pub channel: Option<Arc<dyn DataChannel>>,
    track: Arc<TrackLocalStaticRTP>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    ssrc: u32,
    sequence: u16,
    timestamp: u32,
    payload: u8,
    pending: Vec<RTCIceCandidateInit>,
    remote_set: bool,
    quality: super::quality::Sampler,
}
impl Peer {
    pub async fn new(
        id: &str,
        generation: String,
        initiator: bool,
        config: RTCConfiguration,
        tx: mpsc::Sender<Event>,
        mixer: SharedMixer,
        metrics: Arc<Metrics>,
        overflow: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        static NEXT: AtomicU32 = AtomicU32::new(0x54424c01);
        let ssrc = NEXT.fetch_add(1, Ordering::Relaxed);
        let tasks = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(Handler {
            id: id.into(),
            generation: generation.clone(),
            tx,
            mixer,
            metrics,
            tasks: tasks.clone(),
            overflow,
            receiving: AtomicBool::new(false),
        });
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .map_err(|e| e.to_string())?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .map_err(|e| e.to_string())?;
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(config)
                .with_media_engine(media_engine)
                .with_interceptor_registry(registry)
                .with_handler(handler.clone())
                .with_data_channel_send_buffer_limit(65_536)
                .with_udp_addrs(vec!["0.0.0.0:0"])
                .build()
                .await
                .map_err(|e| e.to_string())?,
        );
        let codec = RTCRtpCodec {
            mime_type: "audio/opus".into(),
            clock_rate: RATE,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
            ..Default::default()
        };
        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "tanuki-rust".into(),
            "audio".into(),
            "Native microphone".into(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec,
                active: true,
                ..Default::default()
            }],
        )));
        if let Err(error) = pc.add_track(track.clone()).await {
            let _ = pc.close().await;
            return Err(error.to_string());
        }
        if initiator {
            match pc.create_data_channel("data", None).await {
                Ok(channel) => handler.channel(channel),
                Err(error) => {
                    let _ = pc.close().await;
                    return Err(error.to_string());
                }
            }
        }
        Ok(Self {
            started: std::time::Instant::now(),
            pc,
            generation,
            initiator,
            connected: false,
            channel: None,
            track,
            tasks,
            ssrc,
            sequence: 0,
            timestamp: 0,
            payload: 111,
            pending: Vec::new(),
            remote_set: false,
            quality: super::quality::Sampler::default(),
        })
    }
    pub async fn offer(&self) -> Result<Value, String> {
        let offer = self
            .pc
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        let sdp = offer.sdp.clone();
        self.pc
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({"type":"offer","sdp":sdp}))
    }
    pub async fn sample_quality(&mut self, server_ping: Option<f64>) -> Option<Value> {
        if !self.connected {
            return None;
        }
        let report = tokio::time::timeout(
            Duration::from_millis(10),
            self.pc.get_stats(
                std::time::Instant::now(),
                rtc::statistics::StatsSelector::None,
            ),
        )
        .await
        .ok()?;
        Some(
            self.quality
                .read(&super::quality::rows(&report), server_ping),
        )
    }
    pub async fn signal(&mut self, data: &Value) -> Result<Option<Value>, String> {
        match data["type"].as_str().unwrap_or("") {
            "offer" | "answer" => {
                let sdp = data["sdp"]
                    .as_str()
                    .filter(|s| s.len() <= 65_536)
                    .ok_or("Invalid SDP")?
                    .to_owned();
                self.payload = opus_payload(&sdp).ok_or("相手がOpus音声に対応していません")?;
                let desc = if data["type"] == "offer" {
                    RTCSessionDescription::offer(sdp)
                } else {
                    RTCSessionDescription::answer(sdp)
                }
                .map_err(|e| e.to_string())?;
                self.pc
                    .set_remote_description(desc)
                    .await
                    .map_err(|e| e.to_string())?;
                self.remote_set = true;
                for candidate in self.pending.drain(..) {
                    self.pc
                        .add_ice_candidate(candidate)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                if data["type"] == "offer" {
                    let answer = self
                        .pc
                        .create_answer(None)
                        .await
                        .map_err(|e| e.to_string())?;
                    let sdp = answer.sdp.clone();
                    self.pc
                        .set_local_description(answer)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(Some(json!({"type":"answer","sdp":sdp})));
                }
            }
            "candidate" => {
                let candidate: RTCIceCandidateInit =
                    serde_json::from_value(data["candidate"].clone()).map_err(|e| e.to_string())?;
                if candidate.candidate.len() > 4096 {
                    return Err("Invalid ICE candidate".into());
                }
                if self.remote_set {
                    self.pc
                        .add_ice_candidate(candidate)
                        .await
                        .map_err(|e| e.to_string())?;
                } else if self.pending.len() < 64 {
                    self.pending.push(candidate);
                } else {
                    return Err("Too many pending ICE candidates".into());
                }
            }
            _ => {}
        }
        Ok(None)
    }
    pub async fn send(&mut self, payload: Bytes) -> Result<(), String> {
        let packet = Packet {
            header: Header {
                version: 2,
                payload_type: self.payload,
                sequence_number: self.sequence,
                timestamp: self.timestamp,
                ssrc: self.ssrc,
                ..Default::default()
            },
            payload,
        };
        self.sequence = self.sequence.wrapping_add(1);
        self.timestamp = self.timestamp.wrapping_add(FRAME as u32);
        self.track
            .write_rtp_with_extensions(packet, &[])
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn close(self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        let _ = self.pc.close().await;
    }
}
pub fn opus_payload(sdp: &str) -> Option<u8> {
    let mut audio = false;
    for line in sdp.lines() {
        let line = line.trim();
        if line.starts_with("m=") {
            audio = line.starts_with("m=audio ");
        }
        if audio {
            if let Some(value) = line.strip_prefix("a=rtpmap:") {
                let (pt, codec) = value.split_once(' ')?;
                if codec.to_ascii_lowercase().starts_with("opus/48000/") {
                    return pt.parse::<u8>().ok().filter(|pt| *pt < 128);
                }
            }
        }
    }
    None
}

/// A small reorder window, sequence wrap support, Opus PLC and bounded latency.
struct Jitter {
    packets: HashMap<u16, Bytes>,
    next: Option<u16>,
    started: bool,
}
impl Jitter {
    fn new() -> Self {
        Self {
            packets: HashMap::new(),
            next: None,
            started: false,
        }
    }
    fn push(&mut self, sequence: u16, payload: Bytes) {
        if payload.len() > 4096 {
            return;
        }
        if let Some(next) = self.next {
            let delta = sequence.wrapping_sub(next) as i16;
            if self.started && delta < 0 {
                return;
            }
            if !self.started && delta < 0 {
                self.next = Some(sequence);
            }
            if delta > 16 {
                self.packets.clear();
                self.next = Some(sequence);
                self.started = false;
            }
        } else {
            self.next = Some(sequence);
        }
        if self.packets.len() < 16 {
            self.packets.insert(sequence, payload);
        }
    }
    fn pop(&mut self) -> Option<Option<Bytes>> {
        if !self.started && self.packets.len() < 3 {
            return None;
        }
        self.started = true;
        let next = self.next?;
        self.next = Some(next.wrapping_add(1));
        Some(self.packets.remove(&next))
    }
}
async fn receive(
    track: Arc<dyn TrackRemote>,
    id: &str,
    mixer: SharedMixer,
    metrics: Arc<Metrics>,
) -> Result<(), String> {
    let mut decoder =
        opus::Decoder::new(RATE, opus::Channels::Stereo).map_err(|e| e.to_string())?;
    let mut jitter = Jitter::new();
    let mut output = vec![0.0f32; 5760 * 2];
    let mut remaining = 0;
    let mut mono = true;
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            event=track.poll()=>match event{Some(TrackRemoteEvent::OnRtpPacket(packet))=>{metrics.received.fetch_add(1,Ordering::Relaxed);jitter.push(packet.header.sequence_number,packet.payload);},Some(TrackRemoteEvent::OnEnded)|None=>break,_=>{}},
            _=tick.tick()=>{
                if remaining>0{remaining-=1;continue;}
                if let Some(packet)=jitter.pop(){
                    let empty=Bytes::new();let payload=packet.as_ref().unwrap_or(&empty);
                    if packet.is_none(){metrics.concealed.fetch_add(1,Ordering::Relaxed);}
                    let limit=if packet.is_none(){FRAME*2}else{output.len()};
                    if let Ok(channels)=opus::packet::get_nb_channels(payload){mono=channels==opus::Channels::Mono;}
                    match decoder.decode_float(payload,&mut output[..limit],false){Ok(frames)=>{metrics.decoded.fetch_add(frames as u64,Ordering::Relaxed);mixer.lock().unwrap().push_channels(id,&output[..frames*2],&metrics,mono);remaining=(frames/FRAME).saturating_sub(1);},Err(_)=>{metrics.dropped.fetch_add(FRAME as u64,Ordering::Relaxed);}}
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jitter_reorders_wraps_and_drops_late_packets() {
        let mut j = Jitter::new();
        for n in [65535, 1, 0] {
            j.push(n, Bytes::from_static(b"x"));
        }
        for _ in 0..3 {
            assert_eq!(j.pop().unwrap().unwrap(), Bytes::from_static(b"x"));
        }
        j.push(0, Bytes::from_static(b"late"));
        assert!(j.pop().unwrap().is_none());
        for n in 100..200 {
            j.push(n, Bytes::new());
        }
        assert!(j.packets.len() <= 16);
    }
    #[test]
    fn payload_only_accepts_audio_opus() {
        assert_eq!(
            opus_payload("m=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n"),
            Some(109)
        );
        assert_eq!(
            opus_payload("m=video 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2"),
            None
        );
    }
}
