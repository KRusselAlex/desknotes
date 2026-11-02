//! Pure geometry rules for note windows. Logical pixels, origin top-left.
//! The desktop shell gathers monitor work areas and calls these functions, so
//! the rules are identical on every OS and testable without a display.

use serde::{Deserialize, Serialize};

use crate::model::{MIN_HEIGHT, MIN_WIDTH};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// Area of the intersection with `other` (0 when they do not overlap).
    pub fn overlap_area(&self, other: &Rect) -> f64 {
        let w = (self.right().min(other.right()) - self.x.max(other.x)).max(0.0);
        let h = (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0.0);
        w * h
    }
}

/// Never let a note become too small to read.
pub fn enforce_min_size(width: f64, height: f64) -> (f64, f64) {
    let w = if width.is_finite() {
        width.max(MIN_WIDTH)
    } else {
        MIN_WIDTH
    };
    let h = if height.is_finite() {
        height.max(MIN_HEIGHT)
    } else {
        MIN_HEIGHT
    };
    (w, h)
}

/// Bring a saved note window back to a usable place before showing it.
///
/// Called at startup with the saved rectangle and the work areas (monitor
/// bounds minus panels) that exist *now*. Monitors may have been unplugged or
/// rearranged since the note was saved.
///
/// `areas` is never empty; `areas[0]` is the primary monitor.
pub fn keep_on_screen(rect: Rect, areas: &[Rect]) -> Rect {
    let (width, height) = enforce_min_size(rect.width, rect.height);
    let rect = Rect {
        width,
        height,
        ..rect
    };

    // Policy chosen by the owner (DES-14): "fully inside". The note moves into the
    // work area it overlaps most, or the primary one if it overlaps none. Its size
    // never changes; if it is larger than that area it is aligned top-left so its
    // header (the drag handle) stays reachable.
    let area = areas
        .iter()
        .map(|a| (a, rect.overlap_area(a)))
        .filter(|(_, overlap)| *overlap > 0.0)
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .map_or(areas[0], |(a, _)| *a);
    Rect {
        x: fit(rect.x, rect.width, area.x, area.width),
        y: fit(rect.y, rect.height, area.y, area.height),
        ..rect
    }
}

/// Position along one axis that keeps `[pos, pos + len]` inside
/// `[start, start + span]`, or `start` when it cannot fit.
fn fit(pos: f64, len: f64, start: f64, span: f64) -> f64 {
    if len >= span {
        start
    } else {
        pos.clamp(start, start + span - len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect {
        x: 0.0,
        y: 32.0,
        width: 1920.0,
        height: 1048.0,
    };
    const RIGHT_MONITOR: Rect = Rect {
        x: 1920.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0,
    };

    #[test]
    fn min_size_is_enforced() {
        assert_eq!(enforce_min_size(10.0, 10.0), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!(enforce_min_size(f64::NAN, 500.0), (MIN_WIDTH, 500.0));
        assert_eq!(enforce_min_size(400.0, 300.0), (400.0, 300.0));
    }

    #[test]
    fn note_already_visible_is_left_alone() {
        let r = Rect::new(100.0, 100.0, 300.0, 280.0);
        assert_eq!(keep_on_screen(r, &[LAPTOP]), r);
    }

    #[test]
    fn note_from_unplugged_monitor_comes_back() {
        let r = Rect::new(3000.0, 400.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP]);
        assert!(placed.overlap_area(&LAPTOP) > 0.0, "{placed:?}");
        assert_eq!((placed.width, placed.height), (300.0, 280.0));
    }

    #[test]
    fn header_hidden_under_top_panel_is_pulled_down() {
        let r = Rect::new(200.0, -150.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP, RIGHT_MONITOR]);
        assert!(placed.y >= LAPTOP.y, "{placed:?}");
    }

    #[test]
    fn note_on_second_monitor_stays_there() {
        let r = Rect::new(2500.0, 300.0, 300.0, 280.0);
        assert_eq!(keep_on_screen(r, &[LAPTOP, RIGHT_MONITOR]), r);
    }

    #[test]
    fn note_half_off_the_right_edge_moves_fully_inside() {
        let r = Rect::new(1800.0, 900.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP]);
        assert_eq!(placed, Rect::new(1620.0, 800.0, 300.0, 280.0));
    }

    #[test]
    fn note_across_two_monitors_goes_to_the_one_it_overlaps_most() {
        // 100 px on the laptop, 200 px on the right monitor.
        let r = Rect::new(1820.0, 300.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP, RIGHT_MONITOR]);
        assert_eq!(placed, Rect::new(1920.0, 300.0, 300.0, 280.0));
    }

    #[test]
    fn note_bigger_than_the_screen_keeps_its_size_and_shows_its_header() {
        let small = Rect::new(0.0, 0.0, 800.0, 600.0);
        let r = Rect::new(500.0, 400.0, 1000.0, 900.0);
        let placed = keep_on_screen(r, &[small]);
        assert_eq!(placed, Rect::new(0.0, 0.0, 1000.0, 900.0));
    }
}
