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

    // TODO(you): decide how much of a note must stay reachable.
    //
    // Today this returns `rect` unchanged, so a note saved on an unplugged
    // monitor would reopen invisible. Choose a policy, for example:
    //   * "fully inside": move the note so it fits entirely in the work area
    //     it overlaps most (or the primary one if it overlaps none);
    //   * "grab handle": only require its top 32 px header to be on a work
    //     area, so people can park notes half off-screen on purpose.
    // Helpful pieces: `Rect::overlap_area`, `right()`, `bottom()`, and remember
    // a note can be larger than a small monitor (then align it top-left).
    // Then remove `#[ignore]` from the tests at the bottom of this file.
    let _ = areas;
    rect
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
    #[ignore = "enable once keep_on_screen has a policy"]
    fn note_from_unplugged_monitor_comes_back() {
        let r = Rect::new(3000.0, 400.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP]);
        assert!(placed.overlap_area(&LAPTOP) > 0.0, "{placed:?}");
        assert_eq!((placed.width, placed.height), (300.0, 280.0));
    }

    #[test]
    #[ignore = "enable once keep_on_screen has a policy"]
    fn header_hidden_under_top_panel_is_pulled_down() {
        let r = Rect::new(200.0, -150.0, 300.0, 280.0);
        let placed = keep_on_screen(r, &[LAPTOP, RIGHT_MONITOR]);
        assert!(placed.y >= LAPTOP.y, "{placed:?}");
    }

    #[test]
    #[ignore = "enable once keep_on_screen has a policy"]
    fn note_on_second_monitor_stays_there() {
        let r = Rect::new(2500.0, 300.0, 300.0, 280.0);
        assert_eq!(keep_on_screen(r, &[LAPTOP, RIGHT_MONITOR]), r);
    }
}
