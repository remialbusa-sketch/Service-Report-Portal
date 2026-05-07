import os
import json
import base64
import traceback

import requests
from flask import (
    Blueprint, render_template, request, redirect,
    url_for, flash, session, make_response,
)
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash

from ..extensions import oauth
from ..models import User
from ..user_store import read_users, write_users

auth_bp = Blueprint("auth", __name__)

ALLOWED_DOMAIN = "mcbtsi.com"


def _is_allowed_email(email: str) -> bool:
    """Return True only for @mcbtsi.com addresses."""
    return email.strip().lower().endswith(f"@{ALLOWED_DOMAIN}")


# ── Password login / signup ───────────────────────────────────────────────────

@auth_bp.route("/signup")
def signup():
    """Signup is handled via OAuth or admin — redirect straight to login."""
    return redirect(url_for("auth.login"))


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        users = read_users()
        user_data = next(
            (u for u in users if u.get("username", "").lower() == email or u.get("email", "").lower() == email),
            None,
        )
        if user_data and user_data.get("password") and check_password_hash(user_data["password"], password):
            session.permanent = True
            # Load stored personal Monday.com API token into session if available
            if user_data.get("monday_api_token"):
                session["monday_token"] = user_data["monday_api_token"]
            login_user(User(user_data["username"], user_data.get("name", email)), remember=True)
            flash(f"Welcome, {user_data.get('name', email)}!", "success")
            return redirect(url_for("main.index"))
        flash("Invalid email or password.", "error")
        return redirect(url_for("auth.login"))

    google_enabled = bool(os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_CLIENT_SECRET"))
    response = make_response(render_template("auth/login.html", google_enabled=google_enabled))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


# ── Profile ──────────────────────────────────────────────────────────────────

@auth_bp.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    users = read_users()
    user_data = next((u for u in users if u.get("username") == current_user.id), None)
    if request.method == "POST":
        token = request.form.get("monday_api_token", "").strip()
        if user_data is not None:
            user_data["monday_api_token"] = token
            write_users(users)
            session["monday_token"] = token or None
            flash("Monday.com API token saved. Items will now be created under your account.", "success")
        return redirect(url_for("auth.profile"))
    stored_token = (user_data or {}).get("monday_api_token", "") if user_data else ""
    return render_template("auth/profile.html", has_token=bool(stored_token))


# ── Admin user management ─────────────────────────────────────────────────────

@auth_bp.route("/admin/users", methods=["GET", "POST"])
def admin_users():
    admin_password = os.getenv("ADMIN_PASSWORD", "")
    if not admin_password:
        flash("Admin access is not configured.", "error")
        return redirect(url_for("auth.login"))

    # Simple session-based admin auth
    if request.method == "POST":
        action = request.form.get("action")

        # Admin login
        if action == "admin_login":
            if request.form.get("admin_password") == admin_password:
                session["is_admin"] = True
            else:
                flash("Incorrect admin password.", "error")
            return redirect(url_for("auth.admin_users"))

        if not session.get("is_admin"):
            flash("Admin authentication required.", "error")
            return redirect(url_for("auth.admin_users"))

        # Create user
        if action == "create_user":
            name = request.form.get("name", "").strip()
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            if not name or not email or not password:
                flash("Name, email, and password are all required.", "error")
                return redirect(url_for("auth.admin_users"))
            users = read_users()
            if any(u.get("username") == email for u in users):
                flash(f"User {email} already exists.", "error")
                return redirect(url_for("auth.admin_users"))
            users.append({
                "username": email, "email": email, "name": name,
                "provider": "password",
                "password": generate_password_hash(password),
            })
            write_users(users)
            flash(f"User {email} created successfully.", "success")
            return redirect(url_for("auth.admin_users"))

        # Delete user
        if action == "delete_user":
            email = request.form.get("email", "").strip().lower()
            users = read_users()
            users = [u for u in users if u.get("username") != email]
            write_users(users)
            flash(f"User {email} deleted.", "success")
            return redirect(url_for("auth.admin_users"))

        # Reset password
        if action == "reset_password":
            email = request.form.get("email", "").strip().lower()
            new_password = request.form.get("new_password", "")
            if not new_password:
                flash("New password cannot be empty.", "error")
                return redirect(url_for("auth.admin_users"))
            users = read_users()
            user_data = next((u for u in users if u.get("username") == email), None)
            if not user_data:
                flash(f"User {email} not found.", "error")
                return redirect(url_for("auth.admin_users"))
            user_data["password"] = generate_password_hash(new_password)
            write_users(users)
            flash(f"Password reset for {email}.", "success")
            return redirect(url_for("auth.admin_users"))

        # Sync from Monday.com
        if action == "sync_monday":
            default_pw = os.getenv("DEFAULT_USER_PASSWORD", "")
            if not default_pw:
                flash("Set DEFAULT_USER_PASSWORD in environment variables first.", "error")
                return redirect(url_for("auth.admin_users"))
            api_key = os.getenv("MONDAY_API_KEY", "")
            if not api_key:
                flash("MONDAY_API_KEY is not configured.", "error")
                return redirect(url_for("auth.admin_users"))
            try:
                resp = requests.post(
                    "https://api.monday.com/v2",
                    json={"query": "{ users { id name email } }"},
                    headers={"Authorization": api_key, "Content-Type": "application/json"},
                    timeout=15,
                )
                resp.raise_for_status()
                monday_users = resp.json().get("data", {}).get("users", [])
            except Exception as e:
                flash(f"Failed to fetch Monday.com users: {e}", "error")
                return redirect(url_for("auth.admin_users"))

            users = read_users()
            existing = {u.get("username") for u in users}
            added = 0
            hashed_pw = generate_password_hash(default_pw)
            for mu in monday_users:
                email = (mu.get("email") or "").strip().lower()
                if not email or email in existing:
                    continue
                users.append({
                    "username": email, "email": email,
                    "name": mu.get("name") or email,
                    "monday_id": str(mu.get("id", "")),
                    "provider": "password",
                    "password": hashed_pw,
                })
                existing.add(email)
                added += 1
            write_users(users)
            flash(f"Synced {added} new users from Monday.com. Default password set.", "success")
            return redirect(url_for("auth.admin_users"))

    if not session.get("is_admin"):
        return render_template("auth/admin_login.html")

    users = read_users()
    return render_template("auth/admin_users.html", users=users)


@auth_bp.route("/logout")
def logout():
    logout_user()
    flash("You have been logged out.", "info")
    return redirect(url_for("auth.login"))


# ── Monday.com OAuth ──────────────────────────────────────────────────────────

@auth_bp.route("/auth/monday")
def monday_login():
    monday = oauth.create_client("monday")
    if not monday:
        flash("Monday.com login is not configured.", "error")
        return redirect(url_for("auth.login"))
    redirect_uri = url_for("auth.monday_callback", _external=True)
    try:
        return monday.authorize_redirect(redirect_uri)
    except Exception as e:
        print(f"[OAUTH] authorize_redirect error: {e}")
        flash(f"Authentication error: {e}", "error")
        return redirect(url_for("auth.login"))


@auth_bp.route("/auth/monday/callback")
def monday_callback():
    try:
        error = request.args.get("error")
        if error:
            flash(f"Monday.com auth failed: {request.args.get('error_description', error)}", "error")
            return redirect(url_for("auth.login"))

        code = request.args.get("code")
        if not code:
            flash("No authorization code received.", "error")
            return redirect(url_for("auth.login"))

        token_data = {
            "client_id": os.getenv("MONDAY_OAUTH_CLIENT_ID"),
            "client_secret": os.getenv("MONDAY_OAUTH_CLIENT_SECRET"),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": url_for("auth.monday_callback", _external=True),
        }
        token_response = requests.post(
            "https://auth.monday.com/oauth2/token", data=token_data, timeout=10
        )
        token_response.raise_for_status()
        token = token_response.json()

        access_token = token.get("access_token")
        if not access_token:
            flash("Failed to get access token from Monday.com.", "error")
            return redirect(url_for("auth.login"))

        # Decode JWT to extract user ID without an extra API call
        parts = access_token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid JWT format")
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        claims = json.loads(base64.urlsafe_b64decode(payload))

        monday_user_id = claims.get("uid")
        monday_account_id = claims.get("actid")
        if not monday_user_id:
            flash("Failed to extract user info from Monday.com token.", "error")
            return redirect(url_for("auth.login"))

        # Fetch this user's email from Monday API and validate domain
        try:
            me_resp = requests.post(
                "https://api.monday.com/v2",
                json={"query": "{ me { email name } }"},
                headers={"Authorization": access_token, "Content-Type": "application/json"},
                timeout=10,
            )
            me_data = me_resp.json().get("data", {}).get("me") or {}
            monday_email = (me_data.get("email") or "").strip().lower()
            monday_name = me_data.get("name") or ""
        except Exception:
            monday_email = ""
            monday_name = ""

        if monday_email and not _is_allowed_email(monday_email):
            flash(f"Only @{ALLOWED_DOMAIN} Monday.com accounts may sign in.", "error")
            return redirect(url_for("auth.login"))

        username = monday_email or f"monday_{monday_user_id}"
        name = monday_name or f"Monday User {monday_user_id}"

        users = read_users()
        user_db = next((u for u in users if u.get("username") == username), None)
        if not user_db:
            users.append({
                "username": username, "email": username, "name": name,
                "monday_id": monday_user_id, "monday_account_id": monday_account_id,
                "provider": "monday", "password": None,
            })
        else:
            user_db.update({"monday_id": monday_user_id, "monday_account_id": monday_account_id, "provider": "monday"})
        write_users(users)

        session["monday_token"] = access_token
        session["monday_user_id"] = monday_user_id
        session["monday_account_id"] = monday_account_id
        session.permanent = True

        login_user(User(username, name), remember=True)
        flash(f"Welcome, {name}!", "success")
        return redirect(url_for("main.index"))

    except Exception as e:
        print(f"[OAUTH] Monday callback error: {e}")
        print(traceback.format_exc())
        flash("Authentication failed. Check server logs for details.", "error")
        return redirect(url_for("auth.login"))


# ── Google OAuth ──────────────────────────────────────────────────────────────

@auth_bp.route("/auth/google")
def google_login():
    if not os.getenv("GOOGLE_CLIENT_ID") or not os.getenv("GOOGLE_CLIENT_SECRET"):
        flash("Google sign-in is not configured yet. Please contact your administrator.", "error")
        return redirect(url_for("auth.login"))
    google = oauth.create_client("google")
    if not google:
        flash("Google sign-in is not available. Please contact your administrator.", "error")
        return redirect(url_for("auth.login"))
    redirect_uri = url_for("auth.google_callback", _external=True)
    return google.authorize_redirect(redirect_uri)


@auth_bp.route("/auth/google/callback")
def google_callback():
    try:
        google = oauth.create_client("google")
        token = google.authorize_access_token()
        userinfo = token.get("userinfo") or google.userinfo(token=token)

        email = (userinfo.get("email") or "").strip().lower()
        name = userinfo.get("name") or email
        google_sub = userinfo.get("sub")

        if not email:
            flash("Could not retrieve email from Google.", "error")
            return redirect(url_for("auth.login"))
        if not userinfo.get("email_verified", True):
            flash("Your Google account email is not verified.", "error")
            return redirect(url_for("auth.login"))
        if not _is_allowed_email(email):
            flash(f"Only @{ALLOWED_DOMAIN} Google accounts may sign in.", "error")
            return redirect(url_for("auth.login"))

        users = read_users()
        user_data = next((u for u in users if u.get("email") == email or u.get("username") == email), None)
        if not user_data:
            users.append({
                "username": email, "email": email, "name": name,
                "google_sub": google_sub, "provider": "google", "password": None,
            })
        else:
            user_data["google_sub"] = google_sub
            user_data["provider"] = "google"
            if not user_data.get("name"):
                user_data["name"] = name
        write_users(users)

        session.permanent = True
        login_user(User(email, name), remember=True)
        flash(f"Welcome, {name}!", "success")
        return redirect(url_for("main.index"))

    except Exception as e:
        print(f"[GOOGLE] Callback error: {e}")
        print(traceback.format_exc())
        flash("Google authentication failed. Please try again.", "error")
        return redirect(url_for("auth.login"))
