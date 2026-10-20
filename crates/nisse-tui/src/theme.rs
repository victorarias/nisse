use ratatui::style::{Color, Modifier, Style};

/// Synthwave on a dark night. `plain` keeps the layout and drops every colour.
#[derive(Clone, Copy)]
pub struct Theme {
    pub magenta: Color,
    pub cyan: Color,
    pub violet: Color,
    pub sunset: Color,
    pub grid: Color,
    pub ink: Color,
    pub chrome: [Color; 5],
}

impl Theme {
    pub const NEON: Self = Self {
        magenta: Color::Rgb(0xFF, 0x2A, 0x6D),
        cyan: Color::Rgb(0x05, 0xD9, 0xE8),
        violet: Color::Rgb(0xD3, 0x00, 0xC5),
        sunset: Color::Rgb(0xFF, 0x6C, 0x11),
        grid: Color::Rgb(0x6B, 0x4F, 0xBB),
        ink: Color::Rgb(0xF5, 0xF3, 0xFF),
        chrome: [
            Color::Rgb(0xF5, 0xF3, 0xFF),
            Color::Rgb(0xFF, 0xB8, 0xE6),
            Color::Rgb(0xFF, 0x6E, 0xC7),
            Color::Rgb(0xFF, 0x2A, 0x6D),
            Color::Rgb(0xD3, 0x00, 0xC5),
        ],
    };

    pub const PLAIN: Self = Self {
        magenta: Color::Reset,
        cyan: Color::Reset,
        violet: Color::Reset,
        sunset: Color::Reset,
        grid: Color::Reset,
        ink: Color::Reset,
        chrome: [Color::Reset; 5],
    };

    pub fn from_env() -> Self {
        let plain = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
            || std::env::var("NISSE_THEME").is_ok_and(|theme| theme == "plain");
        if plain { Self::PLAIN } else { Self::NEON }
    }

    pub fn glow(color: Color) -> Style {
        Style::new().fg(color).add_modifier(Modifier::BOLD)
    }

    pub fn quiet(&self) -> Style {
        Style::new().fg(self.grid)
    }
}

pub const LOGO: [&str; 5] = [
    "█   █  ███   ████   ████  █████",
    "██  █   █   █      █      █    ",
    "█ █ █   █    ███    ███   ████ ",
    "█  ██   █       █      █  █    ",
    "█   █  ███  ████   ████   █████",
];
