import { useCallback, useEffect, useState } from "react";
import { MousePointer2, RefreshCw } from "lucide-react";

type ScreenStatus = "granted" | "denied" | "not-determined" | "unknown";

interface ComputerUseLinuxStatus {
  pythonAvailable: boolean;
  displayAuth: boolean;
  convertAvailable: boolean;
  tools: {
    wmctrl: boolean;
    xdotool: boolean;
    scrot: boolean;
    import: boolean;
    convert: boolean;
  };
}

interface ComputerUseStatus {
  activeTaskId: string | null;
  platform: string;
  helperPath: string;
  sourcePath: string | null;
  installed: boolean;
  accessibilityTrusted: boolean;
  screenCaptureStatus: ScreenStatus;
  linux?: ComputerUseLinuxStatus;
  error: string | null;
}

const LINUX_INSTALL_COMMANDS: Array<{ family: string; cmd: string }> = [
  { family: "apt (Debian/Ubuntu/Mint/Pop)", cmd: "sudo apt install wmctrl xdotool scrot imagemagick python3" },
  { family: "dnf (Fedora/RHEL/Rocky/Alma)", cmd: "sudo dnf install wmctrl xdotool scrot ImageMagick python3" },
  { family: "pacman (Arch/Manjaro/Endeavour)", cmd: "sudo pacman -S --needed wmctrl xdotool scrot imagemagick python" },
  { family: "zypper (openSUSE)", cmd: "sudo zypper install wmctrl xdotool scrot imagemagick python3" },
  { family: "apk (Alpine)", cmd: "sudo apk add wmctrl xdotool scrot imagemagick python3" },
];

function linuxMissingTools(linux: ComputerUseLinuxStatus | undefined): string[] {
  if (!linux) return ["wmctrl", "xdotool", "scrot or ImageMagick", "python3"];
  const missing: string[] = [];
  if (!linux.pythonAvailable) missing.push("python3");
  if (!linux.tools.wmctrl) missing.push("wmctrl");
  if (!linux.tools.xdotool) missing.push("xdotool");
  if (!linux.tools.scrot && !linux.tools.import) missing.push("scrot or ImageMagick (capture)");
  if (!linux.convertAvailable && !linux.tools.convert) missing.push("ImageMagick (for HiDPI resize)");
  return missing;
}

function statusLabel(ok: boolean): string {
  return ok ? "Granted" : "Not granted";
}

function screenStatusLabel(s: ScreenStatus): string {
  switch (s) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not determined — open System Settings to allow";
    default:
      return "Unknown";
  }
}

export function ComputerUseSettings() {
  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const isLinux = platform === "linux";

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const plat = await window.electronAPI.getPlatform();
      setPlatform(plat);
      const s = await window.electronAPI.getComputerUseStatus();
      setStatus({
        ...s,
        screenCaptureStatus: s.screenCaptureStatus as ScreenStatus,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load computer use status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = window.electronAPI.onComputerUseEvent(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const openAccessibility = async () => {
    try {
      await window.electronAPI.openComputerUseAccessibilitySettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open settings");
    }
  };

  const openScreen = async () => {
    try {
      await window.electronAPI.openComputerUseScreenRecordingSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open settings");
    }
  };

  const endSession = async () => {
    try {
      setEnding(true);
      await window.electronAPI.endComputerUseSession();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end session");
    } finally {
      setEnding(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading computer use…</div>;
  }

  return (
    <div className="computer-use-settings">
      <div className="settings-section computer-use-settings-heading">
        <h3>
          <span className="computer-use-settings-heading-icon" aria-hidden="true">
            <MousePointer2 size={18} strokeWidth={1.5} />
          </span>
          Computer use
        </h3>
        <p className="settings-description">
          Pi-style native desktop control for macOS, Windows, and Linux X11. The agent targets one controlled
          window at a time through `screenshot()`, then uses screenshot-relative mouse, keyboard,
          scroll, and typing actions.
        </p>
      </div>

      {error ? <div className="settings-error">{error}</div> : null}

      {!isMac && !isWindows && !isLinux ? (
        <div className="computer-use-platform-note">
          Computer use is available on macOS, Windows, and Linux X11 desktop builds. This platform
          is not currently supported.
        </div>
      ) : null}

      {isLinux ? (
        <div className="computer-use-platform-note">
          Linux support requires an X11 session plus <code>wmctrl</code>, <code>xdotool</code>, and
          <code>scrot</code> or ImageMagick. Wayland-only sessions are not supported yet.
        </div>
      ) : null}

      {isLinux && status?.linux ? (
        <div className="computer-use-status-card computer-use-linux-diagnostics">
          <div className="computer-use-status-title">X11 helper tools</div>
          <ul className="computer-use-linux-tool-list">
            <li className={status.linux.pythonAvailable ? "ok" : "bad"}>
              <span className="computer-use-linux-tool-label">python3</span>
              <span className="computer-use-linux-tool-state">
                {status.linux.pythonAvailable ? "Installed" : "Missing"}
              </span>
            </li>
            <li className={status.linux.tools.wmctrl ? "ok" : "bad"}>
              <span className="computer-use-linux-tool-label">wmctrl</span>
              <span className="computer-use-linux-tool-state">
                {status.linux.tools.wmctrl ? "Installed" : "Missing"}
              </span>
            </li>
            <li className={status.linux.tools.xdotool ? "ok" : "bad"}>
              <span className="computer-use-linux-tool-label">xdotool</span>
              <span className="computer-use-linux-tool-state">
                {status.linux.tools.xdotool ? "Installed" : "Missing"}
              </span>
            </li>
            <li
              className={
                status.linux.tools.scrot || status.linux.tools.import ? "ok" : "bad"
              }
            >
              <span className="computer-use-linux-tool-label">
                {status.linux.tools.scrot ? "scrot" : status.linux.tools.import ? "ImageMagick (import)" : "scrot or ImageMagick"}
              </span>
              <span className="computer-use-linux-tool-state">
                {status.linux.tools.scrot || status.linux.tools.import
                  ? "Installed"
                  : "Missing"}
              </span>
            </li>
            <li className={status.linux.convertAvailable ? "ok" : "bad"}>
              <span className="computer-use-linux-tool-label">ImageMagick (convert — HiDPI resize)</span>
              <span className="computer-use-linux-tool-state">
                {status.linux.convertAvailable ? "Installed" : "Missing"}
              </span>
            </li>
            <li className={status.linux.displayAuth ? "ok" : "bad"}>
              <span className="computer-use-linux-tool-label">X11 display authorization</span>
              <span className="computer-use-linux-tool-state">
                {status.linux.displayAuth ? "OK" : "Cannot reach display"}
              </span>
            </li>
          </ul>
          {linuxMissingTools(status.linux).length > 0 ? (
            <div className="computer-use-linux-install-hint">
              <div className="computer-use-linux-install-title">Install with:</div>
              {LINUX_INSTALL_COMMANDS.map((entry) => (
                <div key={entry.family} className="computer-use-linux-install-row">
                  <span className="computer-use-linux-install-family">{entry.family}</span>
                  <code className="computer-use-linux-install-cmd">{entry.cmd}</code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isWindows ? (
        <div className="computer-use-platform-note">
          Windows computer use supports visible, non-minimized native windows in v1. It may fall
          back to foreground input for apps that block background capture or control.
        </div>
      ) : null}

      <div className="computer-use-status-grid">
        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Helper</div>
          <div className={`computer-use-status-value ${status?.installed ? "ok" : "bad"}`}>
            {status?.installed ? "Installed" : "Not installed yet"}
          </div>
          <div className="computer-use-session-id">
            <code>{status?.helperPath}</code>
          </div>
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">
            {isWindows ? "Input control" : "Accessibility"}
          </div>
          <div
            className={`computer-use-status-value ${status?.accessibilityTrusted ? "ok" : "bad"}`}
          >
            {statusLabel(Boolean(status?.accessibilityTrusted))}
          </div>
          {isMac ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void openAccessibility()}
            >
              Open Accessibility settings
            </button>
          ) : null}
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">
            {isWindows ? "Window capture" : "Screen Recording"}
          </div>
          <div
            className={`computer-use-status-value ${
              status?.screenCaptureStatus === "granted" ? "ok" : "bad"
            }`}
          >
            {screenStatusLabel(status?.screenCaptureStatus ?? "unknown")}
          </div>
          {isMac ? (
            <button type="button" className="button-secondary" onClick={() => void openScreen()}>
              Open Screen Recording settings
            </button>
          ) : null}
        </div>
      </div>

      {isMac ? (
        <p className="computer-use-restart-hint">
          Inline bootstrap will prompt for missing helper permissions at first use. After changing
          Screen Recording, macOS may still require <strong>restarting CoWork</strong> before
          capture works reliably.
        </p>
      ) : null}

      {status?.sourcePath ? (
        <div className="computer-use-platform-note">
          Helper source bundle: <code>{status.sourcePath}</code>
        </div>
      ) : null}

      {status?.error ? <div className="settings-error">{status.error}</div> : null}

      <div className="computer-use-active-row">
        <div>
          <div className="computer-use-status-title">Active session</div>
          <div className="computer-use-session-id">
            {status?.activeTaskId ? (
              <>
                Task <code>{status.activeTaskId}</code>
              </>
            ) : (
              "None"
            )}
          </div>
        </div>
        <div className="computer-use-active-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void refresh()}
            title="Refresh status"
          >
            <RefreshCw size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={!status?.activeTaskId || ending}
            onClick={() => void endSession()}
          >
            {ending ? "Ending…" : "End session"}
          </button>
        </div>
      </div>
    </div>
  );
}
