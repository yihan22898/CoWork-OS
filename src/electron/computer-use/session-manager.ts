/**
 * Single active computer-use session with minimal guards:
 * - one task owns computer use at a time
 * - Esc aborts the active session
 * - no per-app approval, overlay, or isolation layer
 */

import type { BrowserWindow } from "electron";
import { ComputerUseHelperRuntime } from "./helper-runtime";
import { ShortcutGuard } from "./shortcut-guard";

export type ComputerUseSessionEndReason = "completed" | "aborted" | "manual";

export type ComputerUseSessionEvent =
  | { type: "session_started"; taskId: string }
  | {
      type: "session_ended";
      taskId: string;
      reason: ComputerUseSessionEndReason;
    };

/** Minimal daemon surface to avoid circular imports with AgentDaemon. */
export interface ComputerUseDaemonLike {
  requestApproval(
    taskId: string,
    approvalType: string,
    description: string,
    details: Record<string, unknown>,
    opts?: { allowAutoApprove?: boolean },
  ): Promise<boolean>;
  logEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void;
}

export class ComputerUseSessionManager {
  private static instance: ComputerUseSessionManager | null = null;

  static getInstance(): ComputerUseSessionManager {
    if (!ComputerUseSessionManager.instance) {
      ComputerUseSessionManager.instance = new ComputerUseSessionManager();
    }
    return ComputerUseSessionManager.instance;
  }

  static resetForTesting(): void {
    ComputerUseSessionManager.instance = null;
  }

  private activeTaskId: string | null = null;
  private daemon: ComputerUseDaemonLike | null = null;
  private readonly shortcutGuard = new ShortcutGuard();
  private aborted = false;
  private mainWindowGetter: (() => BrowserWindow | null) | null = null;
  private notifyHandler: ((e: ComputerUseSessionEvent) => void) | null = null;
  private sessionStateGetter:
    | ((taskId: string) => { aborted: boolean; activeTaskId: string | null })
    | null = null;

  private constructor() {}

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.mainWindowGetter = getter;
  }

  setNotifyHandler(handler: ((e: ComputerUseSessionEvent) => void) | null): void {
    this.notifyHandler = handler;
  }

  /**
   * Register a callback the helper-runtime dialog loop can call to check whether
   * the active task still owns the session. Returns null when the registry has
   * not been set (e.g. during tests) so callers can default safely.
   */
  setSessionStateGetter(
    getter: ((taskId: string) => { aborted: boolean; activeTaskId: string | null }) | null,
  ): void {
    this.sessionStateGetter = getter;
  }

  /**
   * Used by helper-runtime's interactive Linux install dialog loop to detect
   * that the user (Esc / End session / another task) has abandoned the loop.
   */
  getSessionStateForDialog(taskId: string): { aborted: boolean; activeTaskId: string | null } {
    return this.sessionStateGetter
      ? this.sessionStateGetter(taskId)
      : { aborted: this.aborted, activeTaskId: this.activeTaskId };
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  getAppPermissionManagerOrNull(): null {
    return null;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  acquire(taskId: string, daemon: ComputerUseDaemonLike): void {
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw new Error(
        "Computer use is already active for another task. Finish or cancel that task first.",
      );
    }

    if (this.activeTaskId) {
      return;
    }

    this.activeTaskId = taskId;
    this.daemon = daemon;
    this.aborted = false;
    void (this.mainWindowGetter?.() ?? null);

    this.shortcutGuard.enable(() => {
      void this.abortSession(taskId);
    });

    daemon.logEvent(taskId, "computer_use_session_started", { mode: "helper_runtime" });
    this.emitNotify({ type: "session_started", taskId });
  }

  updateActionStatus(_label: string): void {}

  checkNotAborted(): void {
    if (this.aborted) {
      throw new Error("Computer use was stopped (Esc). Start a new action when ready.");
    }
  }

  async refreshIsolation(): Promise<void> {}

  async onAppPermissionGranted(): Promise<void> {}

  endSessionIfOwner(taskId: string, reason: ComputerUseSessionEndReason = "completed"): void {
    if (this.activeTaskId !== taskId) return;
    void this.cleanupInternal(taskId, reason);
  }

  async abortSession(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId) return;
    this.aborted = true;
    this.daemon?.logEvent(taskId, "computer_use_session_aborted", { reason: "escape_or_manual" });
    await this.cleanupInternal(taskId, "aborted");
  }

  async endSessionManual(): Promise<void> {
    if (!this.activeTaskId) return;
    const taskId = this.activeTaskId;
    this.daemon?.logEvent(taskId, "computer_use_session_ended", { reason: "manual" });
    await this.cleanupInternal(taskId, "manual");
  }

  private emitNotify(event: ComputerUseSessionEvent): void {
    try {
      this.notifyHandler?.(event);
    } catch {
      // ignore renderer IPC failures
    }
  }

  private async cleanupInternal(
    taskId: string,
    reason: ComputerUseSessionEndReason,
  ): Promise<void> {
    if (this.activeTaskId !== taskId) return;

    this.shortcutGuard.disable();

    this.activeTaskId = null;
    const daemon = this.daemon;
    this.daemon = null;

    // Stop the helper subprocess on abort/manual end so any in-flight type_text or drag
    // terminates immediately instead of continuing after the user stopped. On completed
    // we leave it running so the next task can reuse the live process.
    if (reason !== "completed") {
      try {
        ComputerUseHelperRuntime.getInstance().stop();
      } catch {
        // helper-runtime can fail to resolve in tests that reset it; safe to ignore.
      }
    }

    if (reason === "completed") {
      daemon?.logEvent(taskId, "computer_use_session_ended", { reason: "task_finished" });
    }

    this.emitNotify({ type: "session_ended", taskId, reason });
    this.aborted = false;
  }
}
