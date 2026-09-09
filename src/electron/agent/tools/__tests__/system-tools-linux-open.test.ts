import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const readdirMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    readdir: readdirMock,
    readFile: readFileMock,
  };
});

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: () => ({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    }),
  },
}));

import { SystemTools } from "../system-tools";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function makeSystemTools(): SystemTools {
  return new SystemTools(
    {
      id: "ws-1",
      name: "test",
      path: "/tmp",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: false, shell: true },
    },
    { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
    "task-1",
  );
}

function noDesktopFiles() {
  // Each .desktop dir readdir throws ENOENT so the walk is a no-op
  // unless a test injects a specific entry.
  readdirMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

/**
 * `system-tools.ts` does `const execFileAsync = promisify(execFile)`. The
 * promisified wrapper expects `execFile` to invoke a trailing callback,
 * not to return a Promise — Node even warns about this. So our mock has to
 * honor the callback contract. We also fall back to a rejected Promise
 * when called without a callback (defensive).
 */
function execFileSuccess(...args: unknown[]): void {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === "function") {
      (args[i] as (err: unknown, result: unknown) => void)(null, {
        stdout: "",
        stderr: "",
      });
      return;
    }
  }
}

function execFileFailure(err: NodeJS.ErrnoException): void {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === "function") {
      (args[i] as (err: unknown, result: unknown) => void)(err, undefined);
      return;
    }
  }
}

describe("SystemTools.openApplication on Linux", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    execFileMock.mockImplementation((...args: unknown[]) => execFileSuccess(...args));
    noDesktopFiles();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("executes an absolute path directly without falling back to PATH or .desktop", async () => {
    const tools = makeSystemTools();
    await tools.openApplication("/opt/google/chrome/chrome");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "/opt/google/chrome/chrome",
      [],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function), // trailing callback added by promisify(execFile)
    );
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it("resolves a tilde-prefixed path against the user's home", async () => {
    const tools = makeSystemTools();
    await tools.openApplication("~/.local/bin/myapp");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin] = execFileMock.mock.calls[0];
    expect(String(bin)).toMatch(/myapp$/);
  });

  it("prefers a direct PATH exec over walking .desktop files", async () => {
    const tools = makeSystemTools();
    await tools.openApplication("firefox");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "firefox",
      [],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    // We never had to consult .desktop.
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it("falls back to a .desktop Name= match when the PATH exec fails", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementationOnce((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    readdirMock.mockResolvedValueOnce(["firefox.desktop"]);
    readFileMock.mockResolvedValueOnce(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Firefox Web Browser",
        "Exec=/usr/bin/firefox %u",
        "Icon=firefox",
      ].join("\n"),
    );

    await tools.openApplication("Firefox Web Browser");

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenLastCalledWith(
      "/usr/bin/firefox",
      [],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("matches the .desktop file by Exec= basename even when Name differs", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementationOnce((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    readdirMock.mockResolvedValueOnce(["chromium.desktop"]);
    readFileMock.mockResolvedValueOnce(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Chromium",
        "Exec=/usr/bin/chromium-browser --no-sandbox %U",
      ].join("\n"),
    );

    await tools.openApplication("chromium-browser");

    expect(execFileMock).toHaveBeenLastCalledWith(
      "/usr/bin/chromium-browser",
      ["--no-sandbox"],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("strips Exec field codes before exec", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementationOnce((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    readdirMock.mockResolvedValueOnce(["code.desktop"]);
    readFileMock.mockResolvedValueOnce(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Visual Studio Code",
        "Exec=/usr/bin/code --new-window %F",
      ].join("\n"),
    );

    await tools.openApplication("Visual Studio Code");

    expect(execFileMock).toHaveBeenLastCalledWith(
      "/usr/bin/code",
      ["--new-window"],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("skips .desktop files marked Hidden=true or NoDisplay=true", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementationOnce((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    readdirMock.mockResolvedValueOnce([
      "hidden-firefox.desktop",
      "nodisplay-firefox.desktop",
      "real-firefox.desktop",
    ]);
    readFileMock
      .mockResolvedValueOnce(
        ["[Desktop Entry]", "Type=Application", "Name=Firefox", "Exec=/opt/firefox %u", "Hidden=true"].join("\n"),
      )
      .mockResolvedValueOnce(
        ["[Desktop Entry]", "Type=Application", "Name=Firefox", "Exec=/opt/firefox %u", "NoDisplay=true"].join("\n"),
      )
      .mockResolvedValueOnce(
        ["[Desktop Entry]", "Type=Application", "Name=Firefox", "Exec=/usr/bin/firefox %u"].join("\n"),
      );

    await tools.openApplication("Firefox");

    // Two reads (Hidden + NoDisplay) before the matching one, plus one final exec.
    expect(readFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenLastCalledWith(
      "/usr/bin/firefox",
      [],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("throws a clear error when nothing matches", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementation((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    readdirMock.mockResolvedValueOnce([
      "some-other-app.desktop",
    ]);
    readFileMock.mockResolvedValueOnce(
      ["[Desktop Entry]", "Type=Application", "Name=Some Other App", "Exec=/opt/other"].join("\n"),
    );

    await expect(tools.openApplication("NonexistentApp")).rejects.toThrow(
      /Could not resolve "NonexistentApp"/,
    );
  });

  it("falls back gracefully if every .desktop directory is unreadable", async () => {
    const tools = makeSystemTools();
    execFileMock.mockImplementation((...args: unknown[]) =>
      execFileFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    // readdir is already rejecting ENOENT for every dir.

    await expect(tools.openApplication("Mystery")).rejects.toThrow(
      /Could not resolve "Mystery"/,
    );
  });
});
