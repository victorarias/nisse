//! The `/model` picker: a row for each model of each provider, and an effort for each row.

use nisse_protocol::{ModelSelection, ProviderModels};

pub(crate) struct Picker {
    /// Empty until the server has listed the models.
    pub(crate) rows: Vec<Row>,
    pub(crate) listed: bool,
    pub(crate) cursor: usize,
}

pub(crate) struct Row {
    pub(crate) provider: String,
    /// Absent for the provider's own choice.
    pub(crate) model: Option<String>,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) efforts: Vec<String>,
    /// Which of `efforts`; absent for the model's own default.
    pub(crate) effort: Option<usize>,
    pub(crate) current: bool,
}

impl Picker {
    pub(crate) fn loading() -> Self {
        Self {
            rows: Vec::new(),
            listed: false,
            cursor: 0,
        }
    }

    /// Lists every provider's models, the highlight on the conversation's own.
    pub(crate) fn list(&mut self, providers: Vec<ProviderModels>, current: &ModelSelection) {
        self.rows = providers
            .into_iter()
            .flat_map(|provider| {
                let own_choice = provider.default_model.is_none().then(|| Row {
                    provider: provider.provider.clone(),
                    model: None,
                    name: "default".into(),
                    description: Some("the provider chooses".into()),
                    efforts: shared_efforts(&provider),
                    effort: None,
                    current: false,
                });
                let models = provider.models.into_iter().map(move |model| Row {
                    provider: provider.provider.clone(),
                    model: Some(model.id),
                    name: model.name,
                    description: model.description,
                    efforts: model.efforts,
                    effort: None,
                    current: false,
                });
                own_choice.into_iter().chain(models)
            })
            .collect();
        self.listed = true;
        if let Some(index) = self
            .rows
            .iter()
            .position(|row| row.provider == current.provider && row.model == current.model)
        {
            let row = &mut self.rows[index];
            row.current = true;
            row.effort = current
                .effort
                .as_ref()
                .and_then(|effort| row.efforts.iter().position(|known| known == effort));
            self.cursor = index;
        }
    }

    pub(crate) fn up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub(crate) fn down(&mut self) {
        self.cursor = (self.cursor + 1).min(self.rows.len().saturating_sub(1));
    }

    /// Steps the highlighted row's effort through the model's default and each effort it takes.
    pub(crate) fn step_effort(&mut self, forward: bool) {
        let Some(row) = self.rows.get_mut(self.cursor) else {
            return;
        };
        let choices = row.efforts.len() + 1;
        let at = row.effort.map_or(0, |effort| effort + 1);
        let next = if forward {
            (at + 1) % choices
        } else {
            (at + choices - 1) % choices
        };
        row.effort = next.checked_sub(1);
    }

    pub(crate) fn chosen(&self) -> Option<ModelSelection> {
        let row = self.rows.get(self.cursor)?;
        Some(ModelSelection {
            provider: row.provider.clone(),
            model: row.model.clone(),
            effort: row.effort.map(|effort| row.efforts[effort].clone()),
        })
    }
}

/// The efforts every one of the provider's models takes, for the provider's own choice.
fn shared_efforts(provider: &ProviderModels) -> Vec<String> {
    let Some((first, rest)) = provider.models.split_first() else {
        return Vec::new();
    };
    first
        .efforts
        .iter()
        .filter(|effort| rest.iter().all(|model| model.efforts.contains(effort)))
        .cloned()
        .collect()
}
