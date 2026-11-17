//! Live per-speaker retro voice. Recording and recognition keep the raw PCM.
use serde_json::Value;

const RATES: [f64; 6] = [4000., 6000., 8000., 16000., 32000., 44100.];
const LEVELS: [f64; 6] = [7., 31., 127., 2047., 32767., 8388607.];

#[derive(Default)]
pub struct Processor {
    stage: Option<u8>,
    phase: f64,
    held: [f32; 2],
}
impl Processor {
    pub fn set_stage(&mut self, stage: Option<u8>) {
        let stage = stage.filter(|s| (*s as usize) < RATES.len());
        if stage == self.stage {
            return;
        }
        self.stage = stage;
        self.phase = 0.;
        self.held = [0.; 2];
    }
    pub fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let Some(stage) = self.stage else {
            return input;
        };
        if self.phase <= 0. {
            self.held = input.map(|sample| quantize(sample, LEVELS[stage as usize]));
            self.phase += super::model::RATE as f64 / RATES[stage as usize];
        }
        self.phase -= 1.;
        self.held
    }
}
fn quantize(input: f32, levels: f64) -> f32 {
    let sample = if input.is_finite() {
        input.clamp(-1., 1.) as f64
    } else {
        0.
    };
    let compressed = sample.signum() * (255. * sample.abs()).ln_1p() / 256_f64.ln();
    // Match JavaScript Math.round, including negative half boundaries.
    let value = (compressed * levels + 0.5).floor() / levels;
    (value.signum() * (value.abs() * 256_f64.ln()).exp_m1() / 255.) as f32
}
pub fn stage(state: &Value, speaker: &Value) -> Option<u8> {
    if state["mod"] != "NoS"
        || state["gameState"] != 1
        || speaker["isDead"] == true
        || speaker["disconnected"] == true
    {
        return None;
    }
    let rows = state["nosBitCharacters"].as_array()?;
    if rows.len() > 24 {
        return None;
    }
    let mut seen = [false; 256];
    for row in rows {
        if !crate::native::mods::addon::row_valid("bits", row, 0) {
            return None;
        }
        let id = row["playerId"].as_u64()? as usize;
        if seen[id] {
            return None;
        }
        seen[id] = true;
    }
    let value = rows.iter().find(|r| r["playerId"] == speaker["id"])?["stage"].as_u64()?;
    (value < 6).then_some(value as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn six_stages_improve_and_bypass_restores_exact_pcm() {
        let input: Vec<f32> = (0..48000)
            .map(|i| (0.18 * (i as f64 * std::f64::consts::TAU * 220. / 48000.).sin()) as f32)
            .collect();
        let mut previous = f64::INFINITY;
        for stage in 0..6 {
            let mut p = Processor::default();
            p.set_stage(Some(stage));
            let mut error = 0.;
            for &x in &input {
                let y = p.process([x, x]);
                assert!(y[0].is_finite() && y[0] == y[1]);
                error += (y[0] as f64 - x as f64).powi(2);
            }
            assert!(error < previous, "stage{stage}: {error} >= {previous}");
            previous = error;
            p.set_stage(None);
            assert_eq!(p.process([0.125, -0.25]), [0.125, -0.25]);
        }
        let mut p = Processor::default();
        p.set_stage(Some(0));
        assert_eq!(p.process([0.; 2]), [0.; 2]);
    }
    #[test]
    fn meeting_death_final_duplicates_and_old_state_bypass() {
        let mut state =
            json!({"mod":"NoS","gameState":1,"nosBitCharacters":[{"playerId":1,"stage":5}]});
        let player = json!({"id":1,"isDead":false,"disconnected":false});
        assert_eq!(stage(&state, &player), Some(5));
        state["gameState"] = json!(2);
        assert_eq!(stage(&state, &player), None);
        state["gameState"] = json!(1);
        state["nosBitCharacters"][0]["stage"] = json!(6);
        assert_eq!(stage(&state, &player), None);
        state["nosBitCharacters"] = json!([{"playerId":1,"stage":0},{"playerId":1,"stage":1}]);
        assert_eq!(stage(&state, &player), None);
        state["nosBitCharacters"] = json!([{"playerId":1,"stage":0}]);
        assert_eq!(stage(&state, &json!({"id":1,"isDead":true})), None);
        assert_eq!(stage(&json!({"mod":"NoS","gameState":1}), &player), None);
    }
}
