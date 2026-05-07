import os
import json
import traceback
from datetime import datetime, timezone

from flask import (
    Blueprint, request, jsonify, session, redirect,
    url_for, flash, render_template, send_from_directory, current_app
)
from flask_login import login_required, current_user

from .. import monday
from ..user_store import log_submission, get_user_submissions

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
@login_required
def index():
    linked_items = []
    logs = []

    # ── Fetch linked-board items for the dropdown ────────────────────
    try:
        query = (
            f"{{ boards (ids: {monday.LINK_BOARD}) "
            "{ items_page { items { id name } } } }"
        )
        res = monday.graphql(query)
        boards = (res or {}).get("data", {}).get("boards")
        if boards:
            linked_items = ((boards[0] or {}).get("items_page") or {}).get("items", [])
        elif (res or {}).get("errors"):
            flash(f"API Error fetching service requests: {(res['errors'][0] or {}).get('message')}", "error")
    except Exception as e:
        flash(f"Failed to fetch service requests: {e}", "error")

    # ── Load recent submissions from local log ──────────────────────
    username = current_user.id if current_user.is_authenticated else None
    if username:
        logs = get_user_submissions(username, limit=20)

    return render_template("index.html", linked_options=linked_items, logs=logs)


@main_bp.route("/submit", methods=["POST"])
@login_required
def submit():
    try:
        item_name = request.form.get("name", "").strip()

        if not item_name:
            flash("Item name is required.", "error")
            return _submit_response(False, "Item name is required.")

        # ── Extract TSP WORKWITH email and resolve to Monday people IDs ────────
        tsp_workwith_email = request.form.get("tsp_workwith", "").strip()
        print(f"[WORKWITH] raw email input: {tsp_workwith_email!r}")

        # Resolve email(s) to Monday.com user IDs for the people column
        workwith_person_ids: list[int] = []
        if tsp_workwith_email:
            workwith_person_ids = monday.resolve_users_by_email(
                [e.strip() for e in tsp_workwith_email.split(",") if e.strip()]
            )
            if not workwith_person_ids:
                print(f"[WORKWITH] No matching Monday users — people column will be left unset")

        # ── Derive Created-By from logged-in user and resolve to Monday people IDs ────────
        created_by_person_ids: list[int] = []
        if current_user.is_authenticated:
            # current_user.id stores the username (email) for local users created from Monday.com sync
            user_email = str(current_user.id or "").strip()
            if user_email:
                print(f"[CREATED_BY] Resolving Monday user for logged-in account: {user_email!r}")
                created_by_person_ids = monday.resolve_users_by_email([user_email])
                if not created_by_person_ids:
                    print(f"[CREATED_BY] No matching Monday users for {user_email!r} — COL_CREATED_BY will be left unset")

        local_timezone = request.form.get("local_timezone")

        form_data = {
            # COL_TSP_WORKWITH is a people column — populated below after email resolution
            # (kept here as None so it flows through format_column_value with resolved IDs)
            "COL_TSP_WORKWITH": workwith_person_ids if workwith_person_ids else None,
            # COL_CREATED_BY is a people column - populated from Service TSP Email resolution
            "COL_CREATED_BY": created_by_person_ids if created_by_person_ids else None,
            "COL_SERVICE_START": (datetime.fromisoformat(request.form.get("service_start","")).replace(tzinfo=timezone.utc).isoformat() if request.form.get("service_start") else None),
            "COL_SERVICE_END": (datetime.fromisoformat(request.form.get("service_end","")).replace(tzinfo=timezone.utc).isoformat() if request.form.get("service_end") else None),
            "COL_LOGIN_DATE": (datetime.fromisoformat(request.form.get("login_date","")).replace(tzinfo=timezone.utc).isoformat() if request.form.get("login_date") else None),
            "COL_LOGOUT_DATE": (datetime.fromisoformat(request.form.get("logout_date","")).replace(tzinfo=timezone.utc).isoformat() if request.form.get("logout_date") else None),
            "COL_PROBLEMS": request.form.get("problems"),
            "COL_JOB_DONE": request.form.get("job_done"),
            "COL_PARTS_REPLACED": request.form.get("parts_replaced"),
            "COL_RECOMMENDATION": request.form.get("recommendation"),
            "COL_REMARKS": request.form.get("remarks"),
            "COL_STATUS": request.form.get("status"),
            "COL_MACHINE_SYSTEM": request.form.get("machine_system"),
            "COL_SERIAL_NUMBER": request.form.get("serial_number"),
            "COL_BIOMED_PERSON": request.form.get("biomed_person"),
            "COL_BIOMED_PERSON_EMAIL": request.form.get("biomed_person_email"),
            "COL_CUSTOMER_NAME": request.form.get("customer_name"),
            "COL_CUSTOMER_EMAIL": request.form.get("customer_email"),
            "COL_SOFTWARE_VERSION": request.form.get("software_version"),
        }

        # Build column_values dict (people column handled separately below)
        column_values = {}
        for env_var, form_value in form_data.items():
            col_id = os.getenv(env_var)
            if not col_id:
                continue
            formatted = monday.format_column_value(col_id, form_value, local_timezone)
            if formatted is not None:
                column_values[col_id] = formatted

        # TSP WORKWITH: the people column (COL_TSP_WORKWITH) has been set above via
        # resolve_users_by_email() → personsAndTeams JSON, handled by format_column_value().
        # If no Monday user matched the email, the column is simply left unset.

        create_query = """
        mutation ($boardId: ID!, $itemName: String!, $columnVals: JSON!) {
            create_item (board_id: $boardId, item_name: $itemName, column_values: $columnVals) { id }
        }
        """
        print(f"[SUBMIT] column_values payload: {json.dumps(column_values, indent=2)}")
        print(f"[SUBMIT] column_values JSON string: {json.dumps(column_values)}")
        gql_vars = {
            "boardId": monday.MAIN_BOARD,
            "itemName": item_name,
            "columnVals": json.dumps(column_values),
        }

        user_token = session.get("monday_token") or None
        res = monday.graphql(create_query, gql_vars, api_key=user_token)
        res = res or {}

        if res.get("errors"):
            msg = res["errors"][0].get("message", "Unknown error")
            flash(f"API Error: {msg}", "error")
            return _submit_response(False, f"API Error: {msg}")

        if res.get("data", {}).get("create_item"):
            item_id = res["data"]["create_item"]["id"]

            # Record locally so "My Recent Submissions" always works
            if current_user.is_authenticated:
                log_submission(current_user.id, item_name, item_id)
            flash(f"Service entry '{item_name}' created successfully!", "success")
            return _submit_response(True, item_id=item_id, item_name=item_name)

        flash("Error creating item. Please check your data.", "error")
        return _submit_response(False, "Failed to create item.")

    except Exception as e:
        print(f"[SUBMIT] Unexpected error: {e}")
        print(traceback.format_exc())
        flash(f"Unexpected error: {e}", "error")
        return _submit_response(False, str(e))

    except Exception as e:
        print(f"[SUBMIT] Unexpected error: {e}")
        print(traceback.format_exc())
        flash(f"Unexpected error: {e}", "error")
        return _submit_response(False, str(e))


def _submit_response(success: bool, error: str = "", item_id: str = "", item_name: str = ""):
    """Return JSON for AJAX or redirect for traditional form posts."""
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        if success:
            return jsonify({"success": True, "item_id": item_id, "item_name": item_name})
        return jsonify({"success": False, "error": error})
    return redirect(url_for("main.index"))


@main_bp.route("/search_linked_items")
@login_required
def search_linked_items():
    q = request.args.get("q", "").strip()
    try:
        items = []
        cursor = None

        # Use Monday server-side name filter when a search term is provided.
        # Iterate cursor pages so results aren't capped at 500.
        while True:
            cursor_arg = f', cursor: "{cursor}"' if cursor else ""

            if q:
                # Server-side name filter — returns only matching items regardless of board size
                name_filter = q.replace('"', '')  # sanitise
                gql = (
                    f'{{ boards (ids: {monday.LINK_BOARD}) {{'
                    f'  items_page (limit: 100{cursor_arg},'
                    f'    query_params: {{rules: [{{column_id: "name",'
                    f'      compare_value: ["{name_filter}"]}}]}}) {{'
                    f'    cursor items {{ id name }} }} }} }}'
                )
            else:
                # No search term — return first 50 as placeholder suggestions
                gql = (
                    f"{{ boards (ids: {monday.LINK_BOARD}) "
                    f"{{ items_page (limit: 50{cursor_arg}) {{ cursor items {{ id name }} }} }} }}"
                )

            res = monday.graphql(gql)
            if res.get("errors"):
                print(f"[SEARCH] Monday API error: {res['errors']}")
                break

            page = ((res or {}).get("data", {}).get("boards") or [{}])
            page_data = ((page[0] or {}).get("items_page") or {})
            batch = page_data.get("items") or []
            items.extend(batch)

            # Stop paginating when no more items or we have enough
            cursor = page_data.get("cursor")
            if not cursor or not batch or len(items) >= 500:
                break

            # When no search term, just one page is enough
            if not q:
                break

        # Client-side fallback filter (handles partial matches Monday may miss)
        if q:
            q_lower = q.lower()
            items = [i for i in items if q_lower in (i.get("name") or "").lower()]

        return jsonify({"results": [{"id": i["id"], "text": i["name"]} for i in items[:200]]})
    except Exception as e:
        print(f"[SEARCH] Unexpected error: {e}")
        traceback.print_exc()
        return jsonify({"results": [], "error": str(e)})


# ── PWA assets ────────────────────────────────────────────────────────────────

@main_bp.route("/sw.js")
def service_worker():
    """Serve Service Worker from root scope so it can control the whole app."""
    resp = send_from_directory(current_app.static_folder, "sw.js",
                               mimetype="application/javascript",
                               max_age=0)
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@main_bp.route("/manifest.webmanifest")
def web_manifest():
    """Serve Web App Manifest for PWA installability."""
    return send_from_directory(current_app.static_folder, "manifest.webmanifest",
                               mimetype="application/manifest+json")


# ── Keep-alive ping (prevents Render free tier from spinning down) ─────────────

@main_bp.route("/ping")
def ping():
    """Lightweight endpoint pinged by the client every 10 minutes."""
    return "", 204
