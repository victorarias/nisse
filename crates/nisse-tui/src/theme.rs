use ratatui::style::{Color, Modifier, Style};

/// Neon on a night city. `PLAIN` keeps the layout and draws with the terminal's own colours.
#[derive(Clone, Copy)]
pub struct Theme {
    pub panel: Color,
    pub cyan: Color,
    pub magenta: Color,
    pub yellow: Color,
    pub violet: Color,
    pub ink: Color,
    pub dim: Color,
    pub faint: Color,
    pub shadow: Color,
    pub logo: [Color; 6],
    pub plain: bool,
}

impl Theme {
    pub const NEON: Self = Self {
        panel: Color::Rgb(0x16, 0x12, 0x2B),
        cyan: Color::Rgb(0x00, 0xF0, 0xFF),
        magenta: Color::Rgb(0xFF, 0x2E, 0x88),
        yellow: Color::Rgb(0xF3, 0xE6, 0x00),
        violet: Color::Rgb(0xB4, 0x6C, 0xFF),
        ink: Color::Rgb(0xE8, 0xE6, 0xFF),
        dim: Color::Rgb(0x8A, 0x86, 0xB8),
        faint: Color::Rgb(0x3D, 0x36, 0x6E),
        shadow: Color::Rgb(0x2A, 0x24, 0x4E),
        logo: [
            Color::Rgb(0x00, 0xF0, 0xFF),
            Color::Rgb(0x3F, 0xC4, 0xFF),
            Color::Rgb(0x7E, 0x98, 0xFF),
            Color::Rgb(0xB4, 0x6C, 0xFF),
            Color::Rgb(0xE0, 0x4C, 0xC4),
            Color::Rgb(0xFF, 0x2E, 0x88),
        ],
        plain: false,
    };

    pub const PLAIN: Self = Self {
        panel: Color::Reset,
        cyan: Color::Reset,
        magenta: Color::Reset,
        yellow: Color::Reset,
        violet: Color::Reset,
        ink: Color::Reset,
        dim: Color::Reset,
        faint: Color::Reset,
        shadow: Color::Reset,
        logo: [Color::Reset; 6],
        plain: true,
    };

    pub fn from_env() -> Self {
        let plain = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
            || std::env::var("NISSE_THEME").is_ok_and(|theme| theme == "plain");
        if plain { Self::PLAIN } else { Self::NEON }
    }

    pub fn fg(&self, color: Color) -> Style {
        Style::new().fg(color)
    }

    pub fn glow(&self, color: Color) -> Style {
        Style::new().fg(color).add_modifier(Modifier::BOLD)
    }

    /// A solid label, like a tag on a HUD.
    pub fn chip(&self, color: Color) -> Style {
        if self.plain {
            Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
        } else {
            Style::new()
                .fg(self.panel)
                .bg(color)
                .add_modifier(Modifier::BOLD)
        }
    }

    pub fn key(&self) -> Style {
        if self.plain {
            Style::new().add_modifier(Modifier::REVERSED)
        } else {
            Style::new().fg(self.cyan).bg(self.faint)
        }
    }

    /// The edge of a chip: its colour fading into the bar behind it.
    pub fn chip_edge(&self, color: Color) -> Style {
        Style::new().fg(color).bg(self.panel)
    }

    pub fn bar(&self) -> Style {
        Style::new().bg(self.panel)
    }
}

/// ANSI Shadow. Full blocks take the gradient; the box-drawing shadow sits behind them.
pub const LOGO: [&str; 6] = [
    "███╗   ██╗██╗███████╗███████╗███████╗",
    "████╗  ██║██║██╔════╝██╔════╝██╔════╝",
    "██╔██╗ ██║██║███████╗███████╗█████╗  ",
    "██║╚██╗██║██║╚════██║╚════██║██╔══╝  ",
    "██║ ╚████║██║███████║███████║███████╗",
    "╚═╝  ╚═══╝╚═╝╚══════╝╚══════╝╚══════╝",
];
