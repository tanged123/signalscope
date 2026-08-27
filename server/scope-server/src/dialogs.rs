use std::{path::PathBuf, sync::Mutex};

pub trait DialogProvider: Send + Sync + 'static {
    fn pick_files(&self, title: &str, filters: &[(&str, &[&str])]) -> Option<Vec<PathBuf>>;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn save_file(
        &self,
        title: &str,
        file_name: &str,
        filters: &[(&str, &[&str])],
    ) -> Option<PathBuf>;
}

#[derive(Default)]
pub struct Native;

impl DialogProvider for Native {
    fn pick_files(&self, title: &str, filters: &[(&str, &[&str])]) -> Option<Vec<PathBuf>> {
        let dialog = filters.iter().fold(
            rfd::FileDialog::new().set_title(title),
            |dialog, (name, extensions)| dialog.add_filter(*name, extensions),
        );
        dialog.pick_files()
    }

    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        rfd::FileDialog::new().set_title(title).pick_folder()
    }

    fn save_file(
        &self,
        title: &str,
        file_name: &str,
        filters: &[(&str, &[&str])],
    ) -> Option<PathBuf> {
        let dialog = filters.iter().fold(
            rfd::FileDialog::new()
                .set_title(title)
                .set_file_name(file_name),
            |dialog, (name, extensions)| dialog.add_filter(*name, extensions),
        );
        dialog.save_file()
    }
}

pub struct Scripted {
    pub files: Mutex<Option<Vec<PathBuf>>>,
    pub folder: Mutex<Option<PathBuf>>,
    pub save: Mutex<Option<PathBuf>>,
}

impl Scripted {
    pub fn with_files(files: Vec<PathBuf>) -> Self {
        Self {
            files: Mutex::new(Some(files)),
            folder: Mutex::new(None),
            save: Mutex::new(None),
        }
    }
}

impl Default for Scripted {
    fn default() -> Self {
        Self {
            files: Mutex::new(Some(Vec::new())),
            folder: Mutex::new(None),
            save: Mutex::new(None),
        }
    }
}

impl DialogProvider for Scripted {
    fn pick_files(&self, _title: &str, _filters: &[(&str, &[&str])]) -> Option<Vec<PathBuf>> {
        self.files.lock().ok()?.clone()
    }

    fn pick_folder(&self, _title: &str) -> Option<PathBuf> {
        self.folder.lock().ok()?.clone()
    }

    fn save_file(
        &self,
        _title: &str,
        _file_name: &str,
        _filters: &[(&str, &[&str])],
    ) -> Option<PathBuf> {
        self.save.lock().ok()?.clone()
    }
}
