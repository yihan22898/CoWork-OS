#!/usr/bin/env python3
import atexit
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time


# Default per-call timeout for subprocess invocations. Helpers that may legitimately
# take longer (large screenshots, long type_text) should pass an explicit timeout.
SUBPROCESS_TIMEOUT_S = 10

# Cache for the X11 display scale factor. Invalidated at the start of every command
# so a freshly-attached monitor or compositor change is picked up.
_SCALE_FACTOR_CACHE = None


def command_exists(name):
    return shutil.which(name) is not None


def run(command, check=True, timeout=SUBPROCESS_TIMEOUT_S):
    return subprocess.run(command, check=check, capture_output=True, text=True, timeout=timeout)


def run_capture(command, check=True, timeout=SUBPROCESS_TIMEOUT_S):
    """Like run(), but returns raw bytes instead of decoded text."""
    return subprocess.run(command, check=check, capture_output=True, timeout=timeout)


def release_held_mouse():
    """Best-effort: release any held primary mouse button. Used by signal handlers
    and atexit so a crash mid-drag doesn't leave the user's mouse stuck."""
    try:
        subprocess.run(
            ["xdotool", "mouseup", "1"],
            capture_output=True,
            timeout=2,
            check=False,
        )
    except Exception:
        pass


def install_signal_handlers():
    def handler(signum, _frame):
        release_held_mouse()
        # Restore the default disposition and re-raise so the process exits with the
        # conventional signal-derived exit code (128 + signum).
        signal.signal(signum, signal.SIG_DFL)
        try:
            os.kill(os.getpid(), signum)
        except Exception:
            os._exit(128 + signum)

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


atexit.register(release_held_mouse)
install_signal_handlers()


def require_x11():
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("linux_x11_required: DISPLAY is not set; Computer Use needs an X11 desktop session.")
    if not command_exists("wmctrl") or not command_exists("xdotool"):
        raise RuntimeError("linux_tools_missing: Install wmctrl and xdotool for Linux Computer Use.")


def display_scale_factor():
    """Return the X11 display scale factor (1.0 = standard, >1.0 = HiDPI / fractional scaling).

    Uses xdpyinfo to read the server-reported DPI and divides by 96 (the standard).
    This covers `xrandr --scale 2x2` integer-HiDPI layouts. Fractional compositor scaling
    on Wayland-via-XWayland is out of scope for X11 support; Wayland sessions are rejected
    by require_x11()."""
    global _SCALE_FACTOR_CACHE
    if _SCALE_FACTOR_CACHE is not None:
        return _SCALE_FACTOR_CACHE
    factor = 1.0
    if command_exists("xdpyinfo"):
        try:
            out = run(["xdpyinfo"], check=False, timeout=5).stdout
            for line in out.splitlines():
                lowered = line.lower()
                if "resolution" in lowered and "dots per inch" in lowered:
                    # Typical: "  resolution:    96x96 dots per inch"
                    after_colon = line.split(":", 1)[-1].strip()
                    first_token = after_colon.split("x", 1)[0].strip()
                    try:
                        dpi = float(first_token)
                        if dpi > 0:
                            factor = round(dpi / 96.0, 2)
                    except ValueError:
                        pass
                    break
        except Exception:
            pass
    _SCALE_FACTOR_CACHE = factor
    return _SCALE_FACTOR_CACHE


def invalidate_scale_factor_cache():
    global _SCALE_FACTOR_CACHE
    _SCALE_FACTOR_CACHE = None


def wait_for_focus(window_id, timeout_ms=250, interval_ms=50):
    """Poll xdotool getactivewindow until it matches window_id or the timeout expires.
    Best-effort: returns False on timeout without raising."""
    target = int(window_id)
    deadline = time.monotonic() + (timeout_ms / 1000.0)
    while time.monotonic() < deadline:
        if active_window_id() == target:
            return True
        time.sleep(interval_ms / 1000.0)
    return False


def active_window_id():
    try:
        value = run(["xdotool", "getactivewindow"], check=False, timeout=5).stdout.strip()
        return int(value)
    except (subprocess.CalledProcessError, ValueError, subprocess.TimeoutExpired):
        return None


def app_name(pid):
    """Resolve the human-readable name for a PID.

    Tries in order:
      1. xdotool search --pid → xdotool getwindowclassname (WM_CLASS, e.g. "code", "Code")
      2. xdotool getwindowname (window title — usually more descriptive than binary)
      3. xprop WM_CLASS (fallback for WMs that don't expose class via xdotool)
      4. ps comm (binary basename — least friendly)
    """
    try:
        search_result = run(["xdotool", "search", "--pid", str(pid)], check=False, timeout=5)
        if search_result.returncode == 0 and search_result.stdout.strip():
            for line in search_result.stdout.splitlines():
                wid = line.strip()
                if not wid:
                    continue
                cls = run(["xdotool", "getwindowclassname", wid], check=False, timeout=5).stdout.strip()
                if cls:
                    return cls
                title = run(["xdotool", "getwindowname", wid], check=False, timeout=5).stdout.strip()
                if title:
                    return title
                xprop_out = run(["xprop", "-id", wid, "WM_CLASS"], check=False, timeout=5).stdout.strip()
                if xprop_out and "=" in xprop_out:
                    # "WM_CLASS(STRING) = "code", "Code""
                    rhs = xprop_out.split("=", 1)[-1].strip().strip('"')
                    if rhs:
                        return rhs.split('", "', 1)[0] if '", "' in rhs else rhs
                break  # only consult the first matching window
    except Exception:
        pass
    try:
        return run(["ps", "-p", str(pid), "-o", "comm="], check=False, timeout=5).stdout.strip() or "Unknown App"
    except Exception:
        return "Unknown App"


def window_rows():
    require_x11()
    result = run(["wmctrl", "-lpG"], check=False, timeout=5)
    if result.returncode != 0:
        return []
    active = active_window_id()
    rows = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue
        try:
            window_id = int(parts[0], 16)
            pid = int(parts[2])
            x, y, width, height = [int(value) for value in parts[3:7]]
        except ValueError:
            continue
        title = parts[8].strip()
        # wmctrl signals minimized windows with -1 x -1 geometry on some WMs.
        minimized = width == -1 or height == -1
        if minimized:
            # Report the row so callers can filter on isMinimized; otherwise skip
            # windows with no usable bounds.
            width = max(0, width)
            height = max(0, height)
        if pid <= 0 or width <= 0 or height <= 0 or not title:
            continue
        rows.append({
            "windowId": window_id,
            "title": title,
            "framePoints": {"x": x, "y": y, "w": width, "h": height},
            "scaleFactor": display_scale_factor(),
            "isMinimized": minimized,
            "isOnscreen": True,
            "isMain": False,
            "isFocused": window_id == active,
            "pid": pid,
        })
    return rows


def list_apps():
    apps = {}
    for row in window_rows():
        pid = row["pid"]
        apps.setdefault(pid, {
            "appName": app_name(pid),
            "pid": pid,
            "isFrontmost": row["isFocused"],
        })
    return list(apps.values())


def list_windows(pid):
    rows = [row for row in window_rows() if row["pid"] == pid]
    for row in rows:
        row["isMain"] = len(rows) > 0 and row is rows[0]
        row.pop("pid", None)
    return rows


def get_frontmost():
    window_id = active_window_id()
    if not window_id:
        raise RuntimeError("window_not_found: No active window is available.")
    rows = [row for row in window_rows() if row["windowId"] == window_id]
    if not rows:
        raise RuntimeError("window_not_found: The active window has no usable title or bounds.")
    row = rows[0]
    return {
        "appName": app_name(row["pid"]),
        "pid": row["pid"],
        "windowTitle": row["title"],
        "windowId": window_id,
    }


def window_row(window_id):
    for row in window_rows():
        if row["windowId"] == int(window_id):
            return row
    raise RuntimeError("window_not_found: The target window no longer exists.")


def activate(window_id):
    row = window_row(window_id)
    run(["wmctrl", "-ia", hex(row["windowId"])], check=False, timeout=5)
    run(["xdotool", "windowactivate", "--sync", str(row["windowId"])], check=False, timeout=5)


def screenshot(window_id):
    row = window_row(window_id)
    activate(window_id)
    factor = display_scale_factor()
    if command_exists("scrot"):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as file:
            output = file.name
        try:
            run(["scrot", "-u", output])
            with open(output, "rb") as captured:
                data = captured.read()
        finally:
            try:
                os.unlink(output)
            except OSError:
                pass
    elif command_exists("import"):
        data = run_capture(["import", "-window", hex(window_id), "png:-"]).stdout
    else:
        raise RuntimeError("linux_tools_missing: Install scrot or ImageMagick for Linux screenshots.")
    # On scaled displays the capture is in physical pixels (e.g. 3840x2160 for a 2x layout)
    # while wmctrl reports logical pixels. Resize down to logical so the model sees a PNG
    # whose dimensions match framePoints.w/h and clicks map predictably to physical screen
    # coords via point().
    target_w = max(1, int(round(row["framePoints"]["w"])))
    target_h = max(1, int(round(row["framePoints"]["h"])))
    if abs(factor - 1.0) > 0.01:
        if not command_exists("convert"):
            # No ImageMagick available — return the raw capture. Width/height are still
            # reported in logical units so the model coordinates agree with framePoints,
            # but clicks will need to map through point()'s scaleFactor-aware conversion.
            return {
                "pngBase64": base64.b64encode(data).decode("ascii"),
                "width": target_w,
                "height": target_h,
                "scaleFactor": factor,
            }
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as raw_file:
            raw_path = raw_file.name
        try:
            with open(raw_path, "wb") as raw_f:
                raw_f.write(data)
            resized = run_capture(
                [
                    "convert",
                    raw_path,
                    "-filter",
                    "Lanczos",
                    "-resize",
                    f"{target_w}x{target_h}!",
                    "png:-",
                ],
                check=True,
                timeout=SUBPROCESS_TIMEOUT_S,
            )
            data = resized.stdout
        finally:
            try:
                os.unlink(raw_path)
            except OSError:
                pass
    return {
        "pngBase64": base64.b64encode(data).decode("ascii"),
        "width": target_w,
        "height": target_h,
        "scaleFactor": factor,
    }


def point(window_id, x, y):
    """Translate capture-relative (logical) coords to physical screen coords for xdotool.
    On scaled displays, logical coords must be multiplied by the scale factor before
    xdotool can hit the same pixel the model saw in the screenshot."""
    row = window_row(window_id)
    factor = display_scale_factor()
    px = row["framePoints"]["x"] + int(round(x * factor))
    py = row["framePoints"]["y"] + int(round(y * factor))
    return px, py


def mouse_click(request):
    x, y = point(request["windowId"], request["x"], request["y"])
    activate(request["windowId"])
    wait_for_focus(request["windowId"])
    button = {"left": "1", "middle": "2", "right": "3"}.get(request.get("button", "left"))
    if not button:
        raise RuntimeError("unsupported_button: Linux X11 bridge supports left, middle, and right buttons.")
    run(["xdotool", "mousemove", "--sync", str(x), str(y)])
    run(["xdotool", "click", "--repeat", str(max(1, int(request.get("clickCount", 1)))), button])


def mouse_move(request):
    x, y = point(request["windowId"], request["x"], request["y"])
    run(["xdotool", "mousemove", str(x), str(y)])


def mouse_drag(request):
    path = request.get("path") or []
    if len(path) < 2:
        raise RuntimeError("invalid_args: Drag requires at least two points.")
    first = point(request["windowId"], path[0]["x"], path[0]["y"])
    activate(request["windowId"])
    if not wait_for_focus(request["windowId"]):
        raise RuntimeError("drag_focus_timeout: target window did not gain focus within 250ms.")
    try:
        run(["xdotool", "mousemove", str(first[0]), str(first[1]), "mousedown", "1"])
        for item in path[1:]:
            x, y = point(request["windowId"], item["x"], item["y"])
            run(["xdotool", "mousemove", str(x), str(y)])
    finally:
        # Single mouseup regardless of where the body failed. xdotool ignores double mouseups.
        release_held_mouse()


def scroll(request):
    x, y = point(request["windowId"], request["x"], request["y"])
    activate(request["windowId"])
    wait_for_focus(request["windowId"])
    run(["xdotool", "mousemove", "--sync", str(x), str(y)])
    vertical = int(request.get("scrollY", 0))
    horizontal = int(request.get("scrollX", 0))
    if vertical:
        run(["xdotool", "click", "--repeat", str(abs(vertical)), "4" if vertical < 0 else "5"])
    if horizontal:
        run(["xdotool", "click", "--repeat", str(abs(horizontal)), "6" if horizontal < 0 else "7"])


def keypress(request):
    activate(request["windowId"])
    key = str(request.get("keyText") or "")
    if not key:
        raise RuntimeError("invalid_args: Linux keypress requires keyText.")
    aliases = {
        "return": "Return",
        "enter": "Return",
        "escape": "Escape",
        "esc": "Escape",
        "space": "space",
        "tab": "Tab",
        "delete": "BackSpace",
        "backspace": "BackSpace",
        "del": "Delete",
        "insert": "Insert",
        "ins": "Insert",
        "home": "Home",
        "end": "End",
        "pageup": "Page_Up",
        "pagedown": "Page_Down",
        "up": "Up",
        "down": "Down",
        "left": "Left",
        "right": "Right",
        "capslock": "Caps_Lock",
        "caps_lock": "Caps_Lock",
        "numlock": "Num_Lock",
        "num_lock": "Num_Lock",
        "printscreen": "Print",
        "print": "Print",
        "menu": "Menu",
        "super": "super",
    }
    for i in range(1, 13):
        aliases[f"f{i}"] = f"F{i}"
    key = aliases.get(key.lower(), key)
    modifiers = {"control": "ctrl", "ctrl": "ctrl", "command": "super", "cmd": "super", "windows": "super", "win": "super", "option": "alt", "alt": "alt", "shift": "shift"}
    combo = "+".join([modifiers.get(str(item).lower(), str(item)) for item in request.get("modifiers", [])] + [key])
    run(["xdotool", "key", "--clearmodifiers", combo])


def type_text(request):
    activate(request["windowId"])
    # 12ms per char is a common xdotool recommendation; the 2ms default drops characters
    # under IBus/Fcitx and on slow X servers. The runtime still enforces a generous overall
    # timeout via typeText's length-based formula.
    run(["xdotool", "type", "--clearmodifiers", "--delay", "12", str(request.get("text", ""))])


def check_permissions_full():
    """Return the full permission/diagnostic state as a dict suitable for IPC."""
    tools = command_exists("wmctrl") and command_exists("xdotool")
    capture = command_exists("scrot") or command_exists("import")
    convert = command_exists("convert")
    python_available = command_exists("python3")
    display_auth = False
    if command_exists("wmctrl"):
        try:
            res = run(["wmctrl", "-l"], check=False, timeout=5)
            display_auth = res.returncode == 0
        except Exception:
            display_auth = False
    return {
        "accessibility": tools,
        "screenRecording": capture,
        "display": bool(os.environ.get("DISPLAY")),
        "pythonAvailable": python_available,
        "displayAuth": display_auth,
        "convertAvailable": convert,
        "tools": {
            "wmctrl": command_exists("wmctrl"),
            "xdotool": command_exists("xdotool"),
            "scrot": command_exists("scrot"),
            "import": command_exists("import"),
            "convert": convert,
        },
    }


def preflight():
    """Run mandatory preflight checks. Raises RuntimeError on hard failures."""
    if not command_exists("python3"):
        # Should never happen since this script IS python3, but guard against env corruption.
        raise RuntimeError("python_missing: python3 was not found on PATH; Computer Use cannot start.")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("linux_x11_required: DISPLAY is not set; Computer Use needs an X11 desktop session.")


def main(request):
    cmd = request.get("cmd")
    if cmd == "checkPermissions":
        return check_permissions_full()
    if cmd == "listApps":
        return list_apps()
    if cmd == "listWindows":
        return list_windows(int(request["pid"]))
    if cmd == "getFrontmost":
        return get_frontmost()
    if cmd == "screenshot":
        return screenshot(int(request["windowId"]))
    if cmd in ("activateApp", "raiseWindow", "unminimizeWindow"):
        if cmd == "activateApp":
            rows = list_windows(int(request["pid"]))
            if not rows:
                raise RuntimeError("window_not_found: No visible window is available.")
            activate(rows[0]["windowId"])
        else:
            activate(int(request["windowId"]))
        return {}
    if cmd == "mouseClick":
        mouse_click(request)
        return {}
    if cmd == "mouseMove":
        mouse_move(request)
        return {}
    if cmd == "mouseDrag":
        mouse_drag(request)
        return {}
    if cmd == "scrollAtPoint":
        scroll(request)
        return {}
    if cmd == "typeText":
        type_text(request)
        return {}
    if cmd == "keyPress":
        keypress(request)
        return {}
    if cmd in (
        "axPressAtPoint",
        "axFocusAtPoint",
        "axDescribeAtPoint",
        "axFindTextInput",
        "axFocusTextInput",
        "axFindFocusableElement",
        "axFindActionableElement",
        "focusedElement",
    ):
        return {
            "pressed": False,
            "focused": False,
            "exists": False,
            "found": False,
            "reason": "Linux X11 bridge does not provide accessibility-tree actions.",
        }
    if cmd == "setValue":
        raise RuntimeError("unsupported: Linux X11 bridge does not provide accessibility-tree values.")
    if cmd == "openPermissionPane":
        return {"opened": False, "reason": "Linux uses desktop session permissions and installed helper tools."}
    raise RuntimeError("unknown_command: Unsupported command: " + str(cmd))


for line in sys.stdin:
    # Invalidate any cached state per-request so a freshly-attached monitor or compositor
    # change is reflected in subsequent commands.
    invalidate_scale_factor_cache()
    try:
        preflight()
        request = json.loads(line)
        response = {"id": request.get("id", "invalid"), "ok": True, "result": main(request)}
    except Exception as error:
        message = str(error)
        code = message.split(":", 1)[0] if ":" in message else "internal_error"
        response = {"id": locals().get("request", {}).get("id", "invalid"), "ok": False, "error": {"message": message, "code": code}}
    print(json.dumps(response, separators=(",", ":")), flush=True)