//! Same interval counters as connectionQuality.ts; no endpoint data leaves here.
use serde_json::{json, Value};
use std::collections::HashMap;
#[derive(Default)]
pub struct Sampler {
    previous: HashMap<String, (f64, f64)>,
}
impl Sampler {
    pub fn read(&mut self, rows: &[Value], server_ping: Option<f64>) -> Value {
        let mut rtt = None;
        let mut jitter = None::<f64>;
        let mut direct = false;
        let mut received = 0.;
        let mut lost = 0.;
        let mut next = HashMap::new();
        let valid = |v: &Value| v.as_f64().filter(|v| v.is_finite() && *v >= 0.);
        let index: HashMap<_, _> = rows
            .iter()
            .filter_map(|v| v["id"].as_str().map(|id| (id, v)))
            .collect();
        for row in rows {
            if row["type"] == "transport" {
                if let Some(pair) = row["selectedCandidatePairId"]
                    .as_str()
                    .and_then(|id| index.get(id))
                {
                    rtt = valid(&pair["currentRoundTripTime"]).map(|v| v * 1000.);
                    let candidate = |key: &str| {
                        pair[key]
                            .as_str()
                            .and_then(|id| index.get(id))
                            .is_some_and(|v| v["candidateType"] == "host")
                    };
                    direct = candidate("localCandidateId") && candidate("remoteCandidateId");
                }
            }
            if row["type"] != "inbound-rtp"
                || row.get("kind").or_else(|| row.get("mediaType")) != Some(&json!("audio"))
            {
                continue;
            }
            if let Some(value) = valid(&row["jitter"]) {
                jitter = Some(jitter.unwrap_or(0.).max(value * 1000.));
            }
            let (Some(r), Some(l), Some(id)) = (
                valid(&row["packetsReceived"]),
                row["packetsLost"].as_f64().filter(|v| v.is_finite()),
                row["id"].as_str(),
            ) else {
                continue;
            };
            next.insert(id.into(), (r, l));
            if let Some((before_r, before_l)) = self.previous.get(id) {
                if r >= *before_r {
                    received += r - before_r;
                    lost += (l - before_l).max(0.);
                }
            }
        }
        self.previous = next;
        json!({"rttMs":rtt,"jitterMs":jitter,"lossPercent":if received+lost>0.{Some(lost/(received+lost)*100.)}else{None},"direct":direct,"serverPingMs":server_ping})
    }
}
pub fn rows(report: &rtc::statistics::report::RTCStatsReport) -> Vec<Value> {
    use rtc::statistics::report::RTCStatsReportEntry as S;
    let rows = report
        .iter()
        .filter_map(|e| {
            let (kind, result) = match e {
                S::Transport(v) => ("transport", serde_json::to_value(v)),
                S::IceCandidatePair(v) => ("candidate-pair", serde_json::to_value(v)),
                S::LocalCandidate(v) => ("local-candidate", serde_json::to_value(v)),
                S::RemoteCandidate(v) => ("remote-candidate", serde_json::to_value(v)),
                S::Codec(v) => ("codec", serde_json::to_value(v)),
                S::InboundRtp(v) => ("inbound-rtp", serde_json::to_value(v)),
                _ => return None,
            };
            result.ok().map(|mut v| {
                v["type"] = json!(kind);
                v
            })
        })
        .collect();
    normalize_native_rows(rows)
}

fn normalize_native_rows(mut rows: Vec<Value>) -> Vec<Value> {
    let clocks: HashMap<String, u64> = rows
        .iter()
        .filter(|row| row["type"] == "codec")
        .filter_map(|row| Some((row["id"].as_str()?.into(), row["clockRate"].as_u64().filter(|rate| *rate > 0)?)))
        .collect();
    for row in &mut rows {
        if row["type"] != "inbound-rtp" || row["kind"] != "audio" {
            continue;
        }
        // rtc =0.21.1 passes the raw RTCP ReceiverReport.jitter into its
        // supposedly-seconds stats field (handler/interceptor.rs). Convert RTP
        // clock ticks here, leaving Sampler's browser-compatible seconds intact.
        // The native Opus engine uses 48 kHz when rtc omits codec metadata.
        let clock = row["codecId"]
            .as_str()
            .and_then(|id| clocks.get(id))
            .copied()
            .unwrap_or(super::model::RATE as u64);
        if let Some(ticks) = row["jitter"].as_f64().filter(|n| n.is_finite() && *n >= 0.) {
            row["jitter"] = json!(ticks / clock as f64);
        }
    }
    rows
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_rtcp_ticks_match_browser_seconds_without_double_conversion() {
        let raw = json!({"type":"inbound-rtp","id":"audio","kind":"audio","codecId":"opus","packetsReceived":100,"packetsLost":0,"jitter":480});
        let codec = json!({"type":"codec","id":"opus","clockRate":48000});
        let native = Sampler::default().read(&normalize_native_rows(vec![raw.clone(), codec]), None);
        let mut browser = raw;
        browser["jitter"] = json!(0.01);
        assert_eq!(native, Sampler::default().read(&[browser], None));
        assert_eq!(native["jitterMs"], 10.);
    }

    #[test]
    fn native_jitter_uses_each_audio_codec_clock_and_ignores_video() {
        let rows = normalize_native_rows(vec![
            json!({"type":"codec","id":"pcmu","clockRate":8000}),
            json!({"type":"inbound-rtp","id":"opus","kind":"audio","jitter":480}),
            json!({"type":"inbound-rtp","id":"pcmu","kind":"audio","codecId":"pcmu","jitter":320}),
            json!({"type":"inbound-rtp","id":"video","kind":"video","jitter":90000}),
        ]);
        assert_eq!(rows[1]["jitter"], 0.01);
        assert_eq!(rows[2]["jitter"], 0.04);
        assert_eq!(Sampler::default().read(&rows, None)["jitterMs"], 40.);
    }

    #[test]
    fn packet_loss_uses_interval_counters_and_restarts_its_baseline() {
        let mut s = Sampler::default();
        let row = |r, l| json!({"type":"inbound-rtp","id":"audio","kind":"audio","packetsReceived":r,"packetsLost":l,"jitter":0.01});
        assert!(s.read(&[row(100, 2)], None)["lossPercent"].is_null());
        assert_eq!(s.read(&[row(190, 12)], Some(10.))["lossPercent"], 10.);
        assert!(s.read(&[row(1, 0)], None)["lossPercent"].is_null());
    }
}
