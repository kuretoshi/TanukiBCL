//! Vanilla wall/door occlusion using the release's SVG map definitions.
//! Segment data is derived at build time; no JS runtime, parser or heap cache.
use serde_json::Value;

struct Door {
    id: i64,
    segments: &'static [[f64; 4]],
}
struct Map {
    id: i64,
    walls: &'static [[f64; 4]],
    doors: &'static [Door],
}
include!("maps.generated.rs");

// Match the line intersection, precision and parameter checks of the pinned
// path-intersection 4.1.0. MIT / Snap.svg Apache-2.0; notices in licenses/.
fn fix(value: f64) -> f64 {
    (value * 1e11 + 0.5).floor() / 1e11
}
fn rounded(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
fn crosses(a: [f64; 4], b: [f64; 4]) -> bool {
    for axis in 0..2 {
        if a[axis].max(a[axis + 2]) < b[axis].min(b[axis + 2])
            || a[axis].min(a[axis + 2]) > b[axis].max(b[axis + 2])
        {
            return false;
        }
    }
    let [x1, y1, x2, y2] = a;
    let [x3, y3, x4, y4] = b;
    let denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if denominator == 0.0 {
        return false;
    }
    let n1 = x1 * y2 - y1 * x2;
    let n2 = x3 * y4 - y3 * x4;
    let p = [
        fix((n1 * (x3 - x4) - (x1 - x2) * n2) / denominator),
        fix((n1 * (y3 - y4) - (y1 - y2) * n2) / denominator),
    ];
    for s in [a, b] {
        for axis in 0..2 {
            if rounded(p[axis]) < rounded(s[axis].min(s[axis + 2]))
                || rounded(p[axis]) > rounded(s[axis].max(s[axis + 2]))
            {
                return false;
            }
        }
        let axis = usize::from((s[2] - s[0]).abs() < 0.01);
        let t = ((p[axis] - s[axis]) / (s[axis + 2] - s[axis])).abs();
        if !(0.0..=1.0).contains(&t) {
            return false;
        }
    }
    true
}

pub fn blocks(mut map: i64, mut from: [f64; 2], mut to: [f64; 2], doors: &Value) -> bool {
    if from.iter().chain(to.iter()).any(|v| !v.is_finite()) {
        return true;
    }
    if map == 3 {
        from[0] = -from[0];
        to[0] = -to[0];
        map = 0;
    }
    let Some(map) = MAPS.iter().find(|m| m.id == map) else {
        return false;
    };
    let segment = [
        fix(from[0] + 40.0),
        fix(40.0 - from[1]),
        fix(to[0] + 40.0),
        fix(40.0 - to[1]),
    ];
    if map.walls.iter().any(|s| crosses(*s, segment)) {
        return true;
    }
    map.doors.iter().any(|door| {
        doors.as_array().is_some_and(|ids| {
            ids.iter().any(|id| id.as_i64() == Some(door.id))
                && door.segments.iter().any(|s| crosses(*s, segment))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn mira_door_only_blocks_when_closed() {
        let (a, b) = ([6.106, 2.7], [6.106, 3.1]);
        assert!(!blocks(1, a, b, &json!([])));
        assert!(blocks(1, a, b, &json!([0])));
        assert!(blocks(1, b, a, &json!([0])));
        assert!(!blocks(1, a, b, &json!([999])));
    }
    #[test]
    fn intersections_include_endpoints_but_not_parallel_or_zero_length_lines() {
        assert!(crosses([0.0, 0.0, 1.0, 0.0], [1.0, -1.0, 1.0, 0.0]));
        assert!(!crosses([0.0, 0.0, 1.0, 0.0], [0.0, 1.0, 1.0, 1.0]));
        assert!(!crosses([0.0, 0.0, 1.0, 0.0], [0.5, 0.0, 0.5, 0.0]));
        assert!(blocks(0, [f64::NAN, 0.0], [0.0; 2], &json!([])));
    }
}
