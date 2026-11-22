use wasm_bindgen::JsCast;
use web_sys::{Document, HtmlElement};

pub struct Position {
    key: String,
    top: i32,
    left: i32,
}

// The debug page is refreshed every second. Keep both the outer viewport and
// independently scrolled history/JSON panes when their DOM nodes are replaced.
pub fn capture(document: &Document) -> Vec<Position> {
    let Ok(nodes) = document.query_selector_all("[data-scroll-key]") else {
        return vec![];
    };
    (0..nodes.length())
        .filter_map(|i| {
            let element = nodes.item(i)?.dyn_into::<HtmlElement>().ok()?;
            Some(Position {
                key: element.get_attribute("data-scroll-key")?,
                top: element.scroll_top(),
                left: element.scroll_left(),
            })
        })
        .collect()
}

pub fn restore(document: &Document, positions: &[Position]) {
    let Ok(nodes) = document.query_selector_all("[data-scroll-key]") else {
        return;
    };
    for i in 0..nodes.length() {
        let Some(element) = nodes.item(i).and_then(|n| n.dyn_into::<HtmlElement>().ok()) else {
            continue;
        };
        let Some(key) = element.get_attribute("data-scroll-key") else {
            continue;
        };
        if let Some(position) = positions.iter().find(|p| p.key == key) {
            element.set_scroll_top(position.top);
            element.set_scroll_left(position.left);
        }
    }
}
