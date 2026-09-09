import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseHelperRuntime } from "../helper-runtime";

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const chmodMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    access: accessMock,
    chmod: chmodMock,
    mkdir: mkdirMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
  };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("../utils/user-data-dir", () => ({
  getUserDataDir: () => "/tmp/cowork-user-data",
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function mockBundledSource(bridgeContent = "#!/usr/bin/env python3\nprint('hi')\n"): void {
  existsSyncMock.mockImplementation((target: unknown) => {
    // path.resolve uses backslashes on Windows; normalize for cross-platform matching.
    const value = String(target).replace(/\\/g, "/");
    return value.endsWith("/resources/computer-use/bridge.py");
  });
  readFileMock.mockImplementation(async (target: unknown) => {
    const value = String(target).replace(/\\/g, "/");
    if (value.endsWith("/bridge.py")) return Buffer.from(bridgeContent);
    if (value.endsWith("/bridge.sha256")) return "";
    throw new Error(`Unexpected read: ${value}`);
  });
}

describe("ComputerUseHelperRuntime Linux install path", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("linux");
    ComputerUseHelperRuntime.resetForTesting();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    chmodMock.mockResolvedValue(undefined);
    accessMock.mockRejectedValue(new Error("ENOENT"));
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "ok\n", stderr: "" });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    ComputerUseHelperRuntime.resetForTesting();
  });

  it("resolves bridge.py as the bundled helper source on Linux", () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    mockBundledSource();

    const sourcePath = runtime.getHelperSourcePath();
    expect(sourcePath).not.toBeNull();
    expect(sourcePath).toMatch(/bridge\.py$/);
  });

  it("writes bridge.py and chmods 0o755 it on Linux install", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    const helperPath = runtime.getHelperPath();
    mockBundledSource();

    await (runtime as { ensureHelperInstalled: () => Promise<void> }).ensureHelperInstalled();

    expect(writeFileMock).toHaveBeenCalledWith(
      helperPath,
      expect.any(Buffer),
      "utf8",
    );
    expect(chmodMock).toHaveBeenCalledWith(helperPath, 0o755);
  });

  it("does not invoke xcrun/swiftc when installing on Linux", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    mockBundledSource();

    await (runtime as { ensureHelperInstalled: () => Promise<void> }).ensureHelperInstalled();

    const calls = spawnSyncMock.mock.calls;
    const xcrunCall = calls.find((call) => call[0] === "xcrun");
    expect(xcrunCall).toBeUndefined();
    // Only the Python smoke-test should invoke spawnSync on Linux.
    const pythonCalls = calls.filter((call) => call[0] === "python3");
    expect(pythonCalls.length).toBe(1);
  });

  it("runs a Python syntax smoke-test after writing the helper file", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    mockBundledSource();

    await (runtime as { ensureHelperInstalled: () => Promise<void> }).ensureHelperInstalled();

    const pythonCall = spawnSyncMock.mock.calls.find((call) => call[0] === "python3");
    expect(pythonCall).toBeDefined();
    const args = pythonCall?.[1] as string[];
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("ast.parse");
  });

  it("returns installed:false from getStatus when no helper is present", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    existsSyncMock.mockReturnValue(false);
    readFileMock.mockResolvedValue(Buffer.from(""));

    const status = await runtime.getStatus();
    expect(status.installed).toBe(false);
    expect(status.platform).toBe("linux");
  });

  it("throws when the Python syntax smoke-test fails after install", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    mockBundledSource("def broken(:\n");
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "SyntaxError: invalid syntax",
    });

    await expect(
      (runtime as { ensureHelperInstalled: () => Promise<void> }).ensureHelperInstalled(),
    ).rejects.toThrow(/Python syntax check/);
  });
});