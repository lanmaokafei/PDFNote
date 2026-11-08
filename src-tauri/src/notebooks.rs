use crate::{
    models::{
        layer_from_row, notebook_from_row, notebook_ink_from_row, now, CreateLayerInput,
        CreateNotebookInkInput, CreateNotebookInput, Layer, Notebook, NotebookInk,
        UpdateLayerInput, UpdateNotebookInput, LAYER_COLUMNS, NOTEBOOK_COLUMNS,
        NOTEBOOK_INK_COLUMNS,
    },
    state::AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

const PAPER_STYLES: [&str; 4] = ["blank", "lined", "grid", "dot"];
const LAYER_SCOPES: [&str; 3] = ["notebook", "canvas", "mindmap"];
const MAX_INKS: usize = 20_000;

fn validate_paper(paper: &str) -> Result<(), String> {
    if PAPER_STYLES.contains(&paper) {
        Ok(())
    } else {
        Err(format!("unsupported paper style: {paper}"))
    }
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if LAYER_SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err(format!("unsupported layer scope: {scope}"))
    }
}

fn notebook_exists(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row("SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)", params![id], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn get_notebook(connection: &Connection, id: &str) -> Result<Notebook, String> {
    connection
        .query_row(
            &format!("SELECT {NOTEBOOK_COLUMNS} FROM notebooks WHERE id = ?1"),
            params![id],
            notebook_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "notebook not found".into())
}

pub fn list_notebooks(state: &AppState) -> Result<Vec<Notebook>, String> {
    let database = state.db()?;
    let mut statement = database
        .prepare(&format!(
            "SELECT {NOTEBOOK_COLUMNS} FROM notebooks ORDER BY updated_at DESC, id"
        ))
        .map_err(|error| error.to_string())?;
    let notebooks = statement
        .query_map([], notebook_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(notebooks)
}

/// 新本子自带一个「图层 1」：空笔记本也能直接落笔，不用先建图层。
pub fn create_notebook(state: &AppState, input: CreateNotebookInput) -> Result<Notebook, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("notebook title cannot be empty".into());
    }
    validate_paper(&input.paper)?;
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    transaction
        .execute(
            "INSERT INTO notebooks (id, title, paper, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, title, input.paper, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO layers (id, scope, owner_id, name, visible, locked, sort_order, created_at)
             VALUES (?1, 'notebook', ?2, '图层 1', 1, 0, 0, ?3)",
            params![Uuid::new_v4().to_string(), id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    let notebook = get_notebook(&transaction, &id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(notebook)
}

pub fn update_notebook(state: &AppState, input: UpdateNotebookInput) -> Result<Notebook, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("notebook title cannot be empty".into());
    }
    validate_paper(&input.paper)?;
    let database = state.db()?;
    let affected = database
        .execute(
            "UPDATE notebooks SET title = ?1, paper = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, input.paper, now(), input.id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("notebook not found".into());
    }
    get_notebook(&database, &input.id)
}

/// 删本子会连带删图层与墨迹。layers.owner_id 没有外键（要同时服务画布/脑图），
/// 所以必须显式清掉，否则会留下永远没人引用的孤儿图层。
pub fn delete_notebook(state: &AppState, id: String) -> Result<(), String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !notebook_exists(&transaction, &id)? {
        return Err("notebook not found".into());
    }
    transaction
        .execute(
            "DELETE FROM layers WHERE scope = 'notebook' AND owner_id = ?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM notebooks WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list_layers(state: &AppState, scope: String, owner_id: String) -> Result<Vec<Layer>, String> {
    validate_scope(&scope)?;
    let database = state.db()?;
    let mut statement = database
        .prepare(&format!(
            "SELECT {LAYER_COLUMNS} FROM layers WHERE scope = ?1 AND owner_id = ?2 ORDER BY sort_order, created_at, id"
        ))
        .map_err(|error| error.to_string())?;
    let layers = statement
        .query_map(params![scope, owner_id], layer_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(layers)
}

pub fn create_layer(state: &AppState, input: CreateLayerInput) -> Result<Layer, String> {
    validate_scope(&input.scope)?;
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if input.scope == "notebook" {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
                params![input.owner_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("notebook not found".into());
        }
    }
    let name = input.name.trim();
    let next_order: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM layers WHERE scope = ?1 AND owner_id = ?2",
            params![input.scope, input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let fallback = format!("图层 {}", next_order + 1);
    transaction
        .execute(
            "INSERT INTO layers (id, scope, owner_id, name, visible, locked, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?6)",
            params![
                id,
                input.scope,
                input.owner_id,
                if name.is_empty() { fallback.as_str() } else { name },
                next_order,
                now()
            ],
        )
        .map_err(|error| error.to_string())?;
    let layer = transaction
        .query_row(
            &format!("SELECT {LAYER_COLUMNS} FROM layers WHERE id = ?1"),
            params![id],
            layer_from_row,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(layer)
}

pub fn update_layer(state: &AppState, input: UpdateLayerInput) -> Result<Layer, String> {
    let database = state.db()?;
    let current = database
        .query_row(
            &format!("SELECT {LAYER_COLUMNS} FROM layers WHERE id = ?1"),
            params![input.id],
            layer_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "layer not found".to_string())?;
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(current.name);
    if name.chars().count() > 40 {
        return Err("layer name is too long".into());
    }
    database
        .execute(
            "UPDATE layers SET name = ?1, visible = ?2, locked = ?3 WHERE id = ?4",
            params![
                name,
                input.visible.unwrap_or(current.visible),
                input.locked.unwrap_or(current.locked),
                input.id
            ],
        )
        .map_err(|error| error.to_string())?;
    database
        .query_row(
            &format!("SELECT {LAYER_COLUMNS} FROM layers WHERE id = ?1"),
            params![input.id],
            layer_from_row,
        )
        .map_err(|error| error.to_string())
}

/// 每个 owner 至少保留一个图层；删图层会连带删掉该层的墨迹，前端要先确认。
pub fn delete_layer(state: &AppState, id: String) -> Result<(), String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let layer = transaction
        .query_row(
            &format!("SELECT {LAYER_COLUMNS} FROM layers WHERE id = ?1"),
            params![id],
            layer_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "layer not found".to_string())?;
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM layers WHERE scope = ?1 AND owner_id = ?2",
            params![layer.scope, layer.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if count <= 1 {
        return Err("at least one layer must remain".into());
    }
    transaction
        .execute("DELETE FROM layers WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list_notebook_inks(state: &AppState, notebook_id: String) -> Result<Vec<NotebookInk>, String> {
    let database = state.db()?;
    let exists: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
            params![notebook_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("notebook not found".into());
    }
    let mut statement = database
        .prepare(&format!(
            "SELECT {NOTEBOOK_INK_COLUMNS} FROM notebook_inks
             WHERE notebook_id = ?1 ORDER BY page, created_at, id LIMIT ?2"
        ))
        .map_err(|error| error.to_string())?;
    let inks = statement
        .query_map(params![notebook_id, MAX_INKS as i64], notebook_ink_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(inks)
}

pub fn create_notebook_ink(
    state: &AppState,
    input: CreateNotebookInkInput,
) -> Result<NotebookInk, String> {
    if input.page == 0 {
        return Err("page numbers are one-based".into());
    }
    input.bbox.validate()?;
    if !input.style.is_object() {
        return Err("ink style must be a JSON object".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !notebook_exists(&transaction, &input.notebook_id)? {
        return Err("notebook not found".into());
    }
    let layer_ok: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM layers WHERE id = ?1 AND scope = 'notebook' AND owner_id = ?2)",
            params![input.layer_id, input.notebook_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !layer_ok {
        return Err("layer does not belong to this notebook".into());
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    transaction
        .execute(
            "INSERT INTO notebook_inks (
                id, notebook_id, page, layer_id,
                bbox_x, bbox_y, bbox_width, bbox_height,
                style_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                input.notebook_id,
                input.page,
                input.layer_id,
                input.bbox.x,
                input.bbox.y,
                input.bbox.width,
                input.bbox.height,
                input.style.to_string(),
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE notebooks SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, input.notebook_id],
        )
        .map_err(|error| error.to_string())?;
    let ink = transaction
        .query_row(
            &format!("SELECT {NOTEBOOK_INK_COLUMNS} FROM notebook_inks WHERE id = ?1"),
            params![id],
            notebook_ink_from_row,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ink)
}

pub fn delete_notebook_ink(state: &AppState, id: String) -> Result<(), String> {
    let database = state.db()?;
    let affected = database
        .execute("DELETE FROM notebook_inks WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("ink not found".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NormalizedBBox;
    use crate::state::test_state;
    use serde_json::json;

    fn notebook(state: &AppState) -> Notebook {
        create_notebook(
            state,
            CreateNotebookInput { title: "演草本".into(), paper: "grid".into() },
        )
        .unwrap()
    }

    fn bbox() -> NormalizedBBox {
        NormalizedBBox { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    }

    #[test]
    fn create_notebook_bootstraps_one_layer() {
        let (_directory, state) = test_state();
        let created = notebook(&state);
        assert_eq!(created.title, "演草本");
        assert_eq!(created.paper, "grid");
        let layers = list_layers(&state, "notebook".into(), created.id.clone()).unwrap();
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].name, "图层 1");
        assert!(layers[0].visible);
        assert!(!layers[0].locked);
    }

    #[test]
    fn ink_roundtrip_and_layer_cascade() {
        let (_directory, state) = test_state();
        let created = notebook(&state);
        let layer = list_layers(&state, "notebook".into(), created.id.clone()).unwrap()[0].clone();
        let ink = create_notebook_ink(
            &state,
            CreateNotebookInkInput {
                notebook_id: created.id.clone(),
                page: 1,
                layer_id: layer.id.clone(),
                bbox: bbox(),
                style: json!({ "color": "#d94f3d", "width": 0.003, "points": [[0.1, 0.1], [0.2, 0.2]] }),
            },
        )
        .unwrap();
        assert_eq!(ink.page, 1);
        assert_eq!(ink.layer_id, layer.id);
        assert_eq!(list_notebook_inks(&state, created.id.clone()).unwrap().len(), 1);

        // 再加一层后删掉带墨迹的那层：墨迹跟着级联删除。
        let second = create_layer(
            &state,
            CreateLayerInput {
                scope: "notebook".into(),
                owner_id: created.id.clone(),
                name: "草稿".into(),
            },
        )
        .unwrap();
        assert_eq!(second.sort_order, 1);
        delete_layer(&state, layer.id.clone()).unwrap();
        assert_eq!(list_notebook_inks(&state, created.id).unwrap().len(), 0);
    }

    #[test]
    fn last_layer_cannot_be_deleted() {
        let (_directory, state) = test_state();
        let created = notebook(&state);
        let layer = list_layers(&state, "notebook".into(), created.id.clone()).unwrap()[0].clone();
        let error = delete_layer(&state, layer.id).unwrap_err();
        assert!(error.contains("at least one layer"));
    }

    #[test]
    fn deleting_notebook_cleans_layers_and_inks() {
        let (_directory, state) = test_state();
        let created = notebook(&state);
        let layer = list_layers(&state, "notebook".into(), created.id.clone()).unwrap()[0].clone();
        create_notebook_ink(
            &state,
            CreateNotebookInkInput {
                notebook_id: created.id.clone(),
                page: 1,
                layer_id: layer.id,
                bbox: bbox(),
                style: json!({ "points": [[0.1, 0.1]] }),
            },
        )
        .unwrap();
        delete_notebook(&state, created.id.clone()).unwrap();
        assert!(notebook_exists(&state.db().unwrap(), &created.id).unwrap() == false);
        let leftover: i64 = state
            .db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM layers WHERE owner_id = ?1",
                params![created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
    }

    #[test]
    fn layer_update_and_name_validation() {
        let (_directory, state) = test_state();
        let created = notebook(&state);
        let layer = list_layers(&state, "notebook".into(), created.id.clone()).unwrap()[0].clone();
        let updated = update_layer(
            &state,
            UpdateLayerInput {
                id: layer.id.clone(),
                name: Some("高亮".into()),
                visible: Some(false),
                locked: Some(true),
            },
        )
        .unwrap();
        assert_eq!(updated.name, "高亮");
        assert!(!updated.visible);
        assert!(updated.locked);
        let long = "字".repeat(41);
        let error = update_layer(
            &state,
            UpdateLayerInput { id: layer.id, name: Some(long), visible: None, locked: None },
        )
        .unwrap_err();
        assert!(error.contains("too long"));
    }

    #[test]
    fn ink_rejects_foreign_layer_and_bad_page() {
        let (_directory, state) = test_state();
        let first = notebook(&state);
        let second = notebook(&state);
        let foreign = list_layers(&state, "notebook".into(), second.id.clone()).unwrap()[0].clone();
        let error = create_notebook_ink(
            &state,
            CreateNotebookInkInput {
                notebook_id: first.id.clone(),
                page: 1,
                layer_id: foreign.id,
                bbox: bbox(),
                style: json!({ "points": [] }),
            },
        )
        .unwrap_err();
        assert!(error.contains("does not belong"));

        let layer = list_layers(&state, "notebook".into(), first.id.clone()).unwrap()[0].clone();
        let error = create_notebook_ink(
            &state,
            CreateNotebookInkInput {
                notebook_id: first.id,
                page: 0,
                layer_id: layer.id,
                bbox: bbox(),
                style: json!({}),
            },
        )
        .unwrap_err();
        assert!(error.contains("one-based"));
    }
}
