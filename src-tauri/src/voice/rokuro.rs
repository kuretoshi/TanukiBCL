use super::{
    effects::Biquad,
    model::*,
    routing::{self, Filter, Route},
};
use serde_json::Value;
pub struct Body {
    route: Route,
    filter: Biquad,
    cutoff: f64,
    delay: Vec<[f32; 2]>,
    at: usize,
    strength: f32,
}
impl Body {
    pub fn new(route: Route, echo: f32) -> Self {
        let cutoff = route
            .effects
            .filter
            .map_or(1800., |f| f.frequency.min(1800.));
        Self {
            route,
            filter: Biquad::new(Filter {
                highpass: false,
                frequency: cutoff,
                q: std::f64::consts::FRAC_1_SQRT_2,
            }),
            cutoff,
            delay: vec![[0.; 2]; 8640],
            at: 0,
            strength: echo,
        }
    }
    pub fn update(&mut self, route: Route, echo: f32) {
        let cutoff = route
            .effects
            .filter
            .map_or(1800., |f| f.frequency.min(1800.));
        if self.cutoff != cutoff {
            self.cutoff = cutoff;
            self.filter = Biquad::new(Filter {
                highpass: false,
                frequency: cutoff,
                q: std::f64::consts::FRAC_1_SQRT_2,
            });
        }
        self.route = route;
        self.strength = echo;
    }
    pub fn next(&mut self, sample: [f32; 2], mono: bool) -> [f32; 2] {
        let p = pan(sample, mono, self.route);
        let filtered = self.filter.process(p);
        let delayed = self.delay[self.at];
        self.delay[self.at] =
            std::array::from_fn(|c| filtered[c] + delayed[c] * 0.3 * self.strength);
        self.at = (self.at + 1) % self.delay.len();
        if self.route.gains == [0.; 2] {
            return [0.; 2];
        }
        std::array::from_fn(|c| {
            filtered[c] * (1. - 0.35 * self.strength) + delayed[c] * 0.5 * self.strength
        })
    }
}
pub fn pan(sample: [f32; 2], mono: bool, route: Route) -> [f32; 2] {
    std::array::from_fn(|c| {
        if mono {
            sample[0] * route.gains[c]
        } else {
            sample[0] * route.stereo[c][0] + sample[1] * route.stereo[c][1]
        }
    })
}
pub fn complete(
    state: &Value,
    other_client: i64,
    rules: &Value,
    prefs: &Preferences,
    shared: &Value,
    radios: &[i64],
) -> (Route, Option<(Route, f32)>) {
    let mut head = routing::route(state, other_client, rules, prefs, shared, radios);
    let Some(me) = local(state) else {
        return (head, None);
    };
    let Some(other) = state["players"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["clientId"] == other_client))
    else {
        return (head, None);
    };
    let p = &other["nosPlayer"];
    let valid = state["mod"] == "NoS"
        && state["gameState"] == 1
        && !flag(me, "isDead")
        && !flag(other, "isDead")
        && !flag(other, "disconnected")
        && !flag(other, "isDummy")
        && rules["nosRokurokubiVoiceEffect"] != false
        && p["bodyType"] == 3
        && number(p, "neckLength", 0.) > 0.
        && !radios.contains(&other_client)
        && !flag(state, "airshipMeetingByOutfit")
        && !flag(state, "nativeAirshipSpawnFallback");
    let position = [
        other["x"].as_f64(),
        other["y"].as_f64(),
        p["speakerPositionX"].as_f64(),
        p["speakerPositionY"].as_f64(),
    ];
    if !valid
        || position.iter().any(|v| v.is_none_or(|n| !n.is_finite()))
        || (position[0].unwrap() - position[2].unwrap())
            .hypot(position[1].unwrap() - position[3].unwrap())
            < 0.05
    {
        return (head, None);
    }
    let mut body = routing::route_at(state, other_client, rules, prefs, shared, radios, true);
    body.effects = super::routing::Effects {
        filter: body.effects.filter,
        ..Default::default()
    };
    for (route, key, default) in [
        (&mut head, "headVolume", 100.),
        (&mut body, "bodyVolume", 35.),
    ] {
        let w = number(&shared["rokuroVoice"], key, default).clamp(0., 100.) as f32 / 100.;
        for v in &mut route.gains {
            *v *= w;
        }
        for row in &mut route.stereo {
            for v in row {
                *v *= w;
            }
        }
    }
    (
        head,
        Some((
            body,
            number(&shared["rokuroVoice"], "bodyEcho", 50.).clamp(0., 100.) as f32 / 100.,
        )),
    )
}
