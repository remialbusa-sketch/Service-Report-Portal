"""
Monday.com API helpers.
All calls go through this module so request logic is centralised.
"""
import os
import sys
import traceback
import requests

API_KEY: str = os.getenv("MONDAY_API_KEY", "")
MAIN_BOARD: str = os.getenv("MAIN_BOARD_ID", "")
LINK_BOARD: str = os.getenv("LINKED_BOARD_ID", "")
URL = "https://api.monday.com/v2"
FILE_URL = "https://api.monday.com/v2/file"

_HEADERS = {"Authorization": API_KEY, "API-Version": "2023-10"}


def graphql(query: str, variables: dict | None = None, api_key: str | None = None) -> dict:
    """Execute a Monday.com GraphQL query/mutation.
    Pass api_key to use a specific user's token instead of the admin key.
    """
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    key = api_key or os.getenv("MONDAY_API_KEY", API_KEY)
    headers = {"Authorization": key, "API-Version": "2023-10"}
    try:
        resp = requests.post(URL, json=payload, headers=headers, timeout=15)
        result = resp.json()
        return result if isinstance(result, dict) else {}
    except Exception as exc:
        print(f"[graphql] request/parse error: {exc}")
        return {}


def upload_file(item_id: str, column_id: str, file_data: bytes, filename: str, api_key: str | None = None) -> tuple[bool, str]:
    """
    Upload binary PNG data to a Monday.com file/signature column.
    Returns (success: bool, file_id_or_error: str).
    """
    try:
        print(f"[SIGNATURE] Uploading {filename} → item {item_id}, col {column_id}, {len(file_data)} bytes")
        mutation = (
            'mutation ($file: File!) { add_file_to_column '
            f'(item_id: {item_id}, column_id: "{column_id}", file: $file) {{ id }} }}'
        )
        key = api_key or os.getenv("MONDAY_API_KEY", API_KEY)
        headers = {"Authorization": key, "API-Version": "2023-10"}
        res = requests.post(
            FILE_URL,
            headers=headers,
            data={"query": mutation},
            files={"variables[file]": (filename, file_data, "image/png")},
            timeout=30,
        )
        print(f"[SIGNATURE] HTTP {res.status_code}")
        try:
            resp = res.json()
        except Exception:
            return False, f"Non-JSON response: {res.text[:200]}"

        if resp.get("errors"):
            msg = resp["errors"][0].get("message", "Unknown error")
            print(f"[SIGNATURE] Error: {msg}")
            return False, msg
        if resp.get("error_message"):
            print(f"[SIGNATURE] Error: {resp['error_message']}")
            return False, resp["error_message"]
        if resp.get("data", {}).get("add_file_to_column"):
            fid = resp["data"]["add_file_to_column"].get("id")
            print(f"[SIGNATURE] Success — file_id={fid}")
            return True, fid

        return False, f"Unexpected response: {str(resp)[:200]}"
    except Exception as e:
        print(f"[SIGNATURE] Exception: {e}")
        print(traceback.format_exc())
        return False, str(e)


# Column IDs whose types are ambiguous (e.g. start with "signature" but store email).
# Maps column_id → forced type string.
_COLUMN_TYPE_OVERRIDES: dict[str, str] = {}


def _build_column_type_overrides() -> None:
    """Populate _COLUMN_TYPE_OVERRIDES from environment at first use."""
    global _COLUMN_TYPE_OVERRIDES
    biomed_email_col = os.getenv("COL_BIOMED_PERSON_EMAIL", "")
    if biomed_email_col:
        _COLUMN_TYPE_OVERRIDES[biomed_email_col] = "email"


def format_column_value(col_id: str, value) -> dict | str | None:
    """
    Convert a form value to the correct Monday.com column value format.
    Returns None to skip the column.
    """
    if not value or value == "":
        return None

    if not _COLUMN_TYPE_OVERRIDES:
        _build_column_type_overrides()

    forced_type = _COLUMN_TYPE_OVERRIDES.get(col_id)
    if forced_type == "email":
        val_str = str(value).strip()
        return {"email": val_str, "text": val_str}

    col_lower = str(col_id).lower()
    val_str = str(value).strip()

    # Long text — plain string
    if col_lower.startswith("long_text_") or col_lower == "long_text":
        return val_str

    # Text
    if col_lower.startswith("text_") or "text" in col_lower:
        return {"text": val_str}

    # Email
    if "email" in col_lower:
        return {"email": val_str, "text": val_str}

    # Datetime (datetime-local → "YYYY-MM-DD HH:mm:ss")
    if "datetime" in col_lower:
        if "T" in val_str:
            date_part, time_part = val_str.split("T")
            if time_part.count(":") == 1:
                time_part += ":00"
            val_str = f"{date_part} {time_part}"
        return val_str

    # Date only
    if "date" in col_lower:
        if "T" in val_str:
            val_str = val_str.split("T")[0]
        return val_str

    # Status / color index
    if "status" in col_lower or "color" in col_lower:
        try:
            return {"index": int(value)}
        except (ValueError, TypeError):
            return None

    # Single select
    if "single_select" in col_lower:
        try:
            return {"index": int(value)}
        except (ValueError, TypeError):
            return {"text": val_str}

    # Board relation
    if "relation" in col_lower:
        try:
            return {"item_ids": [int(value)]}
        except (ValueError, TypeError):
            return None

    # Multiple person
    if "multiple_person" in col_lower or "person" in col_lower:
        try:
            if isinstance(value, list):
                ids = [int(v) for v in value]
            else:
                ids = [int(value)]
            return {"personsIds": ids}
        except (ValueError, TypeError):
            return None

    # File / signature — uploaded separately, never via column values
    if "file" in col_lower or "signature" in col_lower:
        return None

    # Default: treat as text
    return {"text": val_str}
