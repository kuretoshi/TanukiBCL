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
    report
        .iter()
        .filter_map(|e| {
            let (kind, result) = match e {
                S::Transport(v) => ("transport", serde_json::to_value(v)),
                S::IceCandidatePair(v) => ("candidate-pair", serde_json::to_value(v)),
                S::LocalCandidate(v) => ("local-candidate", serde_json::to_value(v)),
                S::RemoteCandidate(v) => ("remote-candidate", serde_json::to_value(v)),
                S::InboundRtp(v) => ("inbound-rtp", serde_json::to_value(v)),
                _ => return None,
            };
            result.ok().map(|mut v| {
                v["type"] = json!(kind);
                v
            })
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packet_loss_uses_interval_counters_and_restarts_its_baseline() {
        let mut s = Sampler::default();
        let row = |r, l| json!({"type":"inbound-rtp","id":"audio","kind":"audio","packetsReceived":r,"packetsLost":l,"jitter":0.01});
        assert!(s.read(&[row(100, 2)], None)["lossPercent"].is_null());
        assert_eq!(s.read(&[row(190, 12)], Some(10.))["lossPercent"], 10.);
        assert!(s.read(&[row(1, 0)], None)["lossPercent"].is_null());
    }
}
