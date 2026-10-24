//! Which models expect code mode: the ones Codex's bundled `models.json` (rust-v0.164.0) marks
//! `tool_mode: code_mode_only`. A model missing here gets direct tools.

const CODE_MODE_ONLY: &[&str] = &[
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-daybreak-blue-latest",
    "gpt-daybreak-red-latest",
    "codex-auto-review",
];

pub(crate) fn wants_code_mode(model: &str) -> bool {
    CODE_MODE_ONLY.contains(&model)
}
