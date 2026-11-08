//! `post_save` for a row written by a guarded column update. The one copy
//! lives in `taskflow_projects::emit` (lowest in the plugin graph, so every
//! plugin can use it); umbra gaps6 #27 tracks deleting it.

pub use taskflow_projects::emit::emit_post_save;
