use ratatui::{
    style::{Color, Style},
    text::Span,
};

use crate::theme::Theme;

/// The nisse, two pixels to a cell. Each letter names a colour in `paint`; `.` is empty.
const SPRITE: [&str; 20] = [
    "..........y.........",
    ".........yHy........",
    ".........HH.........",
    "........HHh.........",
    "........HHHh........",
    ".......HHHHh........",
    ".......HHHHHh.......",
    "......HHHHHHHh......",
    ".....HHHHHHHHHh.....",
    "..cccccccccccccccc..",
    "....GgggGGGGgggG....",
    "....GgwgG..GgwgG....",
    "....bGGGbnnbGGGb....",
    "...bbbbbbnnbbbbbb...",
    "..vbbbbbbbbbbbbbbv..",
    ".vvvbbbbbmmbbbbbvvv.",
    ".vvvvbbbbbbbbbbvvvv.",
    ".vvvvvbbbbbbbbvvvvv.",
    "..vvvvvvbbbbvvvvvv..",
    "...kkkk......kkkk...",
];

pub const WIDTH: usize = SPRITE[0].len();
pub const HEIGHT: usize = SPRITE.len() / 2;

fn paint(pixel: u8, theme: &Theme) -> Option<Color> {
    let shade = |rgb: Color| if theme.plain { Color::Reset } else { rgb };
    Some(match pixel {
        b'H' => theme.magenta,
        b'h' => shade(Color::Rgb(0xA8, 0x1C, 0x5C)),
        b'y' => theme.yellow,
        b'c' => theme.cyan,
        b'G' => theme.faint,
        b'g' => theme.cyan,
        b'w' => theme.ink,
        b'n' => shade(Color::Rgb(0xFF, 0x9E, 0xC0)),
        b'b' => theme.ink,
        b'm' => theme.dim,
        b'v' => theme.violet,
        b'k' => theme.faint,
        _ => return None,
    })
}

/// One row of cells per two rows of pixels: the upper pixel is the glyph, the lower one the background.
pub fn rows(theme: &Theme) -> Vec<Vec<Span<'static>>> {
    SPRITE
        .chunks(2)
        .map(|pair| {
            let (upper, lower) = (pair[0].as_bytes(), pair[1].as_bytes());
            (0..WIDTH)
                .map(|x| match (paint(upper[x], theme), paint(lower[x], theme)) {
                    (None, None) => Span::raw(" "),
                    (Some(top), None) => Span::styled("▀", Style::new().fg(top)),
                    (None, Some(bottom)) => Span::styled("▄", Style::new().fg(bottom)),
                    (Some(top), Some(bottom)) if theme.plain || top == bottom => {
                        Span::styled("█", Style::new().fg(top))
                    }
                    (Some(top), Some(bottom)) => Span::styled("▀", Style::new().fg(top).bg(bottom)),
                })
                .collect()
        })
        .collect()
}
