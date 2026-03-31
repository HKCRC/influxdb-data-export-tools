mod commands;
mod influxdb;

use commands::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::test_connection,
            commands::get_buckets,
            commands::get_measurements,
            commands::get_tag_keys,
            commands::get_tag_values,
            commands::preview_query,
            commands::preview_query_debug,
            commands::start_download,
            commands::cancel_download,
            commands::save_settings,
            commands::load_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
