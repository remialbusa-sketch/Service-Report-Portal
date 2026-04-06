import os
import json
import traceback

from flask import (
    Blueprint, render_template, request, redirect,
    url_for, flash, session, jsonify,
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
        linked_id = request.form.get("linked_item_id", "").strip()

        if not item_name:
            flash("Item name is required.", "error")
            return _submit_response(False, "Item name is required.")
        if not linked_id:
            flash("Please select a Service Request.", "error")
            return _submit_response(False, "Please select a Service Request.")

        # ── Extract TSP WORKWITH IDs from raw form data ───────────────
        raw_workwith = request.form.getlist("tsp_workwith")
        print(f"[WORKWITH] getlist result: {raw_workwith!r}")
        print(f"[WORKWITH] full form keys: {list(request.form.keys())}")

        workwith_ids: list[int] = []
        for v in raw_workwith:
            for part in str(v).split(","):
                part = part.strip()
                if part.isdigit():
                    workwith_ids.append(int(part))
        print(f"[WORKWITH] parsed person IDs: {workwith_ids!r}")

        # ── Extract TSP ASSIGNED IDs ──────────────────────────────────
        raw_assigned = request.form.getlist("tsp_assigned")
        assigned_ids: list[int] = []
        for v in raw_assigned:
            for part in str(v).split(","):
                part = part.strip()
                if part.isdigit():
                    assigned_ids.append(int(part))
        print(f"[ASSIGNED] parsed person IDs: {assigned_ids!r}")

        form_data = {
            "COL_SERVICE_REQUEST": linked_id,
            "COL_EMAIL": request.form.get("email"),
            "COL_SERVICE_START": request.form.get("service_start"),
            "COL_SERVICE_END": request.form.get("service_end"),
            "COL_LOGIN_DATE": request.form.get("login_date"),
            "COL_LOGOUT_DATE": request.form.get("logout_date"),
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

        # Track creating user
        if current_user.is_authenticated and os.getenv("COL_CREATED_BY"):
            form_data["COL_CREATED_BY"] = current_user.name

        # Build column_values dict (people column handled separately below)
        column_values = {}
        for env_var, form_value in form_data.items():
            col_id = os.getenv(env_var)
            if not col_id:
                continue
            formatted = monday.format_column_value(col_id, form_value)
            if formatted is not None:
                column_values[col_id] = formatted

        # Include people columns in create_item if we have IDs
        workwith_col_id = os.getenv("COL_TSP_WORKWITH")
        if workwith_ids and workwith_col_id:
            column_values[workwith_col_id] = {"personsIds": workwith_ids}
            print(f"[WORKWITH] included in create_item: {workwith_col_id} = {{'personsIds': {workwith_ids}}}")

        assigned_col_id = os.getenv("COL_TSP_ASSIGNED")
        if assigned_ids and assigned_col_id:
            column_values[assigned_col_id] = {"personsIds": assigned_ids}
            print(f"[ASSIGNED] included in create_item: {assigned_col_id} = {{'personsIds': {assigned_ids}}}")

        create_query = """
        mutation ($boardId: ID!, $itemName: String!, $columnVals: JSON!) {
            create_item (board_id: $boardId, item_name: $itemName, column_values: $columnVals) { id }
        }
        """
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

            # ── Guaranteed people column update ──────────────────────────
            # Some Monday.com accounts silently ignore people values in
            # create_item — call change_column_value explicitly to ensure
            # TSP WORKWITH is always assigned.
            if workwith_ids and workwith_col_id:
                update_q = """
                mutation ($itemId: ID!, $boardId: ID!, $colId: String!, $val: JSON!) {
                    change_column_value(item_id: $itemId, board_id: $boardId,
                        column_id: $colId, value: $val) { id }
                }
                """
                # change_column_value requires personsAndTeams format (not personsIds)
                persons_and_teams = [{"id": uid, "kind": "person"} for uid in workwith_ids]
                up_res = monday.graphql(update_q, {
                    "itemId": item_id,
                    "boardId": monday.MAIN_BOARD,
                    "colId": workwith_col_id,
                    "val": json.dumps({"personsAndTeams": persons_and_teams}),
                }, api_key=user_token)
                if (up_res or {}).get("errors"):
                    print(f"[WORKWITH] update error: {up_res['errors']}")
                else:
                    print(f"[WORKWITH] update OK — personsIds={workwith_ids} on item {item_id}")

            # Guaranteed update for TSP ASSIGNED
            if assigned_ids and assigned_col_id:
                update_q = """
                mutation ($itemId: ID!, $boardId: ID!, $colId: String!, $val: JSON!) {
                    change_column_value(item_id: $itemId, board_id: $boardId,
                        column_id: $colId, value: $val) { id }
                }
                """
                persons_and_teams = [{"id": uid, "kind": "person"} for uid in assigned_ids]
                up_res = monday.graphql(update_q, {
                    "itemId": item_id,
                    "boardId": monday.MAIN_BOARD,
                    "colId": assigned_col_id,
                    "val": json.dumps({"personsAndTeams": persons_and_teams}),
                }, api_key=user_token)
                if (up_res or {}).get("errors"):
                    print(f"[ASSIGNED] update error: {up_res['errors']}")
                else:
                    print(f"[ASSIGNED] update OK — personsIds={assigned_ids} on item {item_id}")

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
