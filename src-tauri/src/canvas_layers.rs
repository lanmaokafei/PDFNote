use crate::{
    models::{
        canvas_ink_from_row, now, CanvasInk, CreateCanvasInkInput, LayerMember, SetCardLayerInput,
        CANVAS_INK_COLUMNS,
    },
    state::AppState,
};
use rusqlite::{params, Connection};
use uuid::Uuid;

fn canvas_exists(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mindmap_canvases WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn layer_belongs(connection: &Connection, canvas_id: &str, layer_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM layers
             WHERE id = ?1 AND scope = 'canvas' AND owner_id = ?2)",
            params![layer_id, canvas_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub fn list_canvas_inks(state: &AppState, canvas_id: String) -> Result<Vec<CanvasInk>, String> {
    let database = state.db()?;
    if !canvas_exists(&database, &canvas_id)? {
        return Err("canvas not found".into());
    }
    let mut statement = database
        .prepare(&format!(
            "SELECT {CANVAS_INK_COLUMNS} FROM canvas_inks
             WHERE canvas_id = ?1 ORDER BY created_at, id LIMIT 20000"
        ))
        .map_err(|error| error.to_string())?;
    let inks = statement
        .query_map(params![canvas_id], canvas_ink_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(inks)
}

pub fn create_canvas_ink(
    state: &AppState,
    input: CreateCanvasInkInput,
) -> Result<CanvasInk, String> {
    if input.points.len() < 2 {
        return Err("a stroke needs at least two points".into());
    }
    if input.points.iter().any(|point| {
        !point[0].is_finite() || !point[1].is_finite()
    }) {
        return Err("stroke points must be finite".into());
    }
    if !input.style.is_object() {
        return Err("ink style must be a JSON object".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !canvas_exists(&transaction, &input.canvas_id)? {
        return Err("canvas not found".into());
    }
    if !layer_belongs(&transaction, &input.canvas_id, &input.layer_id)? {
        return Err("layer does not belong to this canvas".into());
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let points = serde_json::to_string(&input.points).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO canvas_inks (id, canvas_id, layer_id, points_json, style_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                id,
                input.canvas_id,
                input.layer_id,
                points,
                input.style.to_string(),
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    let ink = transaction
        .query_row(
            &format!("SELECT {CANVAS_INK_COLUMNS} FROM canvas_inks WHERE id = ?1"),
            params![id],
            canvas_ink_from_row,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ink)
}

pub fn delete_canvas_ink(state: &AppState, id: String) -> Result<(), String> {
    let database = state.db()?;
    let affected = database
        .execute("DELETE FROM canvas_inks WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("ink not found".into());
    }
    Ok(())
}

pub fn list_layer_members(state: &AppState, canvas_id: String) -> Result<Vec<LayerMember>, String> {
    let database = state.db()?;
    let mut statement = database
        .prepare(
            "SELECT m.layer_id, m.card_id, m.canvas_id
             FROM mindmap_layer_members m
             JOIN layers l ON l.id = m.layer_id
             WHERE m.canvas_id = ?1 AND l.scope = 'canvas' AND l.owner_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let members = statement
        .query_map(params![canvas_id], |row| {
            Ok(LayerMember {
                layer_id: row.get(0)?,
                card_id: row.get(1)?,
                canvas_id: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(members)
}

/// 一张卡片在同一画布上最多属于一个图层；layer_id = null 移回「未分层」。
pub fn set_card_layer(state: &AppState, input: SetCardLayerInput) -> Result<(), String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !canvas_exists(&transaction, &input.canvas_id)? {
        return Err("canvas not found".into());
    }
    if let Some(layer_id) = &input.layer_id {
        if !layer_belongs(&transaction, &input.canvas_id, layer_id)? {
            return Err("layer does not belong to this canvas".into());
        }
    }
    transaction
        .execute(
            "DELETE FROM mindmap_layer_members
             WHERE canvas_id = ?1 AND card_id = ?2",
            params![input.canvas_id, input.card_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(layer_id) = &input.layer_id {
        transaction
            .execute(
                "INSERT INTO mindmap_layer_members (layer_id, card_id, canvas_id)
                 VALUES (?1, ?2, ?3)",
                params![layer_id, input.card_id, input.canvas_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CreateLayerInput;
    use crate::notebooks;
    use crate::state::test_state;
    use serde_json::json;

    fn make_canvas(state: &AppState) -> String {
        // main 由迁移 009 建立，直接用它。
        let canvas: String = state
            .db()
            .unwrap()
            .query_row("SELECT id FROM mindmap_canvases WHERE id = 'main'", [], |row| row.get(0))
            .unwrap();
        canvas
    }

    fn make_layer(state: &AppState, canvas_id: &str, name: &str) -> String {
        notebooks::create_layer(
            state,
            CreateLayerInput {
                scope: "canvas".into(),
                owner_id: canvas_id.into(),
                name: name.into(),
            },
        )
        .unwrap()
        .id
    }

    fn points() -> Vec<[f64; 2]> {
        vec![[10.0, 20.0], [30.0, 40.0], [50.0, 60.0]]
    }

    #[test]
    fn canvas_ink_roundtrip_and_validation() {
        let (_directory, state) = test_state();
        let canvas = make_canvas(&state);
        let layer = make_layer(&state, &canvas, "草稿");
        let ink = create_canvas_ink(
            &state,
            CreateCanvasInkInput {
                canvas_id: canvas.clone(),
                layer_id: layer.clone(),
                points: points(),
                style: json!({ "color": "#d94f3d", "width": 0.0028 }),
            },
        )
        .unwrap();
        assert_eq!(ink.points.len(), 3);
        assert_eq!(ink.layer_id, layer);
        assert_eq!(list_canvas_inks(&state, canvas.clone()).unwrap().len(), 1);

        let bad = create_canvas_ink(
            &state,
            CreateCanvasInkInput {
                canvas_id: canvas.clone(),
                layer_id: layer.clone(),
                points: vec![[1.0, 2.0]],
                style: json!({}),
            },
        )
        .unwrap_err();
        assert!(bad.contains("at least two"));

        let foreign = make_layer(&state, "other-canvas", "别处");
        let error = create_canvas_ink(
            &state,
            CreateCanvasInkInput {
                canvas_id: canvas.clone(),
                layer_id: foreign,
                points: points(),
                style: json!({}),
            },
        )
        .unwrap_err();
        assert!(error.contains("does not belong"));

        delete_canvas_ink(&state, ink.id).unwrap();
        assert_eq!(list_canvas_inks(&state, canvas).unwrap().len(), 0);
    }

    #[test]
    fn layer_members_move_between_layers_and_back() {
        let (_directory, state) = test_state();
        let canvas = make_canvas(&state);
        let first = make_layer(&state, &canvas, "第一层");
        let second = make_layer(&state, &canvas, "第二层");
        // 用一张真实卡片，验证外键与归属行往返。
        let card = crate::cards::create_card(
            &state,
            crate::models::CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: "节点".into(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: Some(canvas.clone()),
                x: None,
                y: None,
            },
        )
        .unwrap();

        set_card_layer(
            &state,
            SetCardLayerInput {
                canvas_id: canvas.clone(),
                card_id: card.id.clone(),
                layer_id: Some(first.clone()),
            },
        )
        .unwrap();
        let members = list_layer_members(&state, canvas.clone()).unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].layer_id, first);

        set_card_layer(
            &state,
            SetCardLayerInput {
                canvas_id: canvas.clone(),
                card_id: card.id.clone(),
                layer_id: Some(second.clone()),
            },
        )
        .unwrap();
        let members = list_layer_members(&state, canvas.clone()).unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].layer_id, second);

        set_card_layer(
            &state,
            SetCardLayerInput {
                canvas_id: canvas.clone(),
                card_id: card.id.clone(),
                layer_id: None,
            },
        )
        .unwrap();
        assert!(list_layer_members(&state, canvas.clone()).unwrap().is_empty());
    }

    #[test]
    fn deleting_layer_cascades_ink_and_members() {
        let (_directory, state) = test_state();
        let canvas = make_canvas(&state);
        let layer = make_layer(&state, &canvas, "临时层");
        let _keep = make_layer(&state, &canvas, "保留层");
        create_canvas_ink(
            &state,
            CreateCanvasInkInput {
                canvas_id: canvas.clone(),
                layer_id: layer.clone(),
                points: points(),
                style: json!({}),
            },
        )
        .unwrap();
        let card = crate::cards::create_card(
            &state,
            crate::models::CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: "节点".into(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: Some(canvas.clone()),
                x: None,
                y: None,
            },
        )
        .unwrap();
        set_card_layer(
            &state,
            SetCardLayerInput {
                canvas_id: canvas.clone(),
                card_id: card.id,
                layer_id: Some(layer.clone()),
            },
        )
        .unwrap();
        notebooks::delete_layer(&state, layer).unwrap();
        assert!(list_canvas_inks(&state, canvas.clone()).unwrap().is_empty());
        assert!(list_layer_members(&state, canvas).unwrap().is_empty());
    }
}
