use super::{effects::Processor, model::number, routing::Effects};
use serde_json::Value;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
#[derive(Default)]
pub struct Preview {
    until: Option<Instant>,
    queue: VecDeque<f32>,
    fx: Processor,
}
impl Preview {
    pub fn configure(&mut self, value: &Value) -> Result<(), String> {
        if value.is_null() || value == false {
            *self = Self::default();
            return Ok(());
        }
        let t = &value["tuning"];
        let pitch = number(t, "pitch", f64::NAN);
        let reverb = number(t, "reverb", f64::NAN);
        let echo = number(t, "echo", f64::NAN);
        if !pitch.is_finite()
            || !(-100.0..=100.).contains(&pitch)
            || ![reverb, echo]
                .iter()
                .all(|v| v.is_finite() && (0.0..=100.).contains(v))
        {
            return Err("Invalid preview tuning".into());
        }
        let berserker = if value["effectKind"] == "nosBerserker" {
            pitch.abs().max(reverb).max(echo) / 100.
        } else {
            0.
        };
        self.fx.configure(Effects {
            pitch: (pitch != 0.).then_some(super::pitch::Parameters {
                pitch: 2f64.powf(pitch / 100.),
                formant: 1.,
                squash: 0.,
            }),
            echo: echo / 100.,
            reverb: reverb > 0.,
            reverb_wet: reverb / 100.,
            berserker,
            ..Default::default()
        });
        self.until = Some(Instant::now() + Duration::from_secs(30));
        Ok(())
    }
    pub fn capture(&mut self, samples: &[f32]) {
        if self.until.is_none_or(|t| Instant::now() >= t) {
            if self.until.is_some() {
                *self = Self::default();
            }
            return;
        }
        while self.queue.len() + samples.len() > 4800 {
            self.queue.pop_front();
        }
        self.queue.extend(samples);
    }
    pub fn render<const N: usize>(&mut self) -> [[f32; 2]; N] {
        if self.until.is_none_or(|t| Instant::now() >= t) {
            if self.until.is_some() {
                *self = Self::default();
            }
            return [[0.; 2]; N];
        }
        std::array::from_fn(|_| {
            let v = self.queue.pop_front().unwrap_or(0.);
            self.fx.process([v; 2])
        })
    }
}
