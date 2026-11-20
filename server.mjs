#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(os.tmpdir(), "codex-cua-mcp-path-cache.txt");
const OVERLAY_PS_SCRIPT = path.join(SERVER_DIR, "overlay.ps1");
const WIN_TOOLS_PS_SCRIPT = path.join(SERVER_DIR, "win_tools.ps1");
const UIA_TREE_SCRIPT = path.join(SERVER_DIR, "uia_tree.ps1");
const OVERLAY_IDLE_MS = Number(process.env.CODEX_CUA_OVERLAY_IDLE_MS || 30000);
let overlayText = process.env.CODEX_CUA_OVERLAY_TEXT?.trim() || "AI 正在操作电脑";

const SKY_CLIENT_FROM_BIN = path.join(
  "node_modules",
  "@oai",
  "sky",
  "dist",
  "project",
  "cua",
  "sky_js",
  "src",
  "targets",
  "windows",
  "internal",
  "computer_use_client.js"
);
const SKY_CLIENT_FROM_PKG = path.join("app", "resources", "cua_node", "bin", SKY_CLIENT_FROM_BIN);

function findCodexSkyClientPath() {
  const override = process.env.CODEX_SKY_CLIENT_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  const sibling = path.join(path.dirname(process.execPath), SKY_CLIENT_FROM_BIN);
  if (existsSync(sibling)) {
    return sibling;
  }

  try {
    if (existsSync(CACHE_FILE)) {
      const cached = readFileSync(CACHE_FILE, "utf8").trim();
      if (cached && existsSync(cached)) {
        return cached;
      }
    }
  } catch {
    // Ignore cache read failures.
  }

  try {
    const installLoc = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    ).trim();
    if (installLoc) {
      const candidate = path.join(installLoc, SKY_CLIENT_FROM_PKG);
      if (existsSync(candidate)) {
        try {
          writeFileSync(CACHE_FILE, candidate, "utf8");
        } catch {
          // Ignore cache write failures.
        }
        return candidate;
      }
    }
  } catch {
    // Fall through.
  }

  throw new Error("Could not locate OpenAI.Codex WindowsDesktopClient. Set CODEX_SKY_CLIENT_PATH.");
}

function getJpegDimensions(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) break;
    const len = (bytes[offset] << 8) | bytes[offset + 1];
    if (len < 2 || offset + len > bytes.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 7 < bytes.length) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    offset += len;
  }
  return null;
}

let overlayProc = null;
let overlayIdleTimer = null;
let overlayVisible = false;
let escAbortedUntil = 0;
let lastScreenshotDims = { width: 1920, height: 1080 };
// Offset of the last screenshot's origin on the real desktop (non-zero when a window-cropped shot was taken).
let lastShotOrigin = { x: 0, y: 0 };

const ESC_ABORT_MSG =
  "Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.";

function isEscAborted() {
  return Date.now() < escAbortedUntil;
}

function assertNotAborted() {
  if (isEscAborted()) {
    throw new Error(ESC_ABORT_MSG);
  }
}

// Map caller coordinates (relative to the latest screenshot, or 0-1000 normalized) to full-desktop pixels.
function resolvePoint(x, y, normalized = false) {
  const px = normalized ? (x / 1000) * lastScreenshotDims.width : x;
  const py = normalized ? (y / 1000) * lastScreenshotDims.height : y;
  return {
    x: Math.round(px + lastShotOrigin.x),
    y: Math.round(py + lastShotOrigin.y),
  };
}

function spawnOverlay() {
  if (!existsSync(OVERLAY_PS_SCRIPT)) {
    return null;
  }
  try {
    const proc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        OVERLAY_PS_SCRIPT,
        "-Text",
        overlayText,
        "-Hidden",
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      }
    );
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("ESC_ABORT")) {
        overlayVisible = false;
        escAbortedUntil = Date.now() + 5000;
        void closeClient();
      }
    });
    proc.on("exit", () => {
      if (overlayProc === proc) {
        overlayProc = null;
        overlayVisible = false;
      }
    });
    proc.on("error", () => {
      if (overlayProc === proc) {
        overlayProc = null;
        overlayVisible = false;
      }
    });
    return proc;
  } catch {
    return null;
  }
}

function overlayCommand(cmd) {
  try {
    overlayProc?.stdin?.write(`${cmd}\n`, "utf8");
  } catch {
    // Ignore.
  }
}

function ensureOverlayProcess() {
  if (process.env.CODEX_CUA_NO_OVERLAY === "1" || !existsSync(OVERLAY_PS_SCRIPT)) {
    return false;
  }
  if (!overlayProc || overlayProc.exitCode !== null || overlayProc.killed) {
    overlayProc = spawnOverlay();
    overlayVisible = false;
  }
  return Boolean(overlayProc);
}

// Hide (not kill) so the next burst shows instantly without Python/Tk startup cost.
function stopOverlay() {
  if (overlayIdleTimer) {
    clearTimeout(overlayIdleTimer);
    overlayIdleTimer = null;
  }
  if (overlayVisible) {
    overlayCommand("HIDE");
    overlayVisible = false;
  }
}

function killOverlay() {
  stopOverlay();
  const proc = overlayProc;
  overlayProc = null;
  if (proc && !proc.killed) {
    try {
      proc.stdin?.write("QUIT\n");
      proc.stdin?.end();
    } catch {
      // Ignore.
    }
    try {
      proc.kill();
    } catch {
      // Ignore.
    }
  }
}

function bumpOverlay() {
  if (!ensureOverlayProcess()) {
    return;
  }
  if (!overlayVisible) {
    overlayCommand("SHOW");
    overlayVisible = true;
  }
  if (overlayIdleTimer) {
    clearTimeout(overlayIdleTimer);
  }
  overlayIdleTimer = setTimeout(() => {
    stopOverlay();
  }, OVERLAY_IDLE_MS);
  overlayIdleTimer.unref?.();
}

// ---- Screenshot compression using the sharp build bundled inside Codex's cua_node ----
const SHOT_QUALITY = Number(process.env.CODEX_CUA_JPEG_QUALITY || 55);
const SHOT_MAX_WIDTH = Number(process.env.CODEX_CUA_MAX_WIDTH || 0); // 0 = keep native resolution
let sharpModule;

function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  sharpModule = null;
  try {
    const clientPath = findCodexSkyClientPath();
    const binDir = clientPath.slice(0, clientPath.toLowerCase().indexOf(`${path.sep}node_modules${path.sep}`.toLowerCase()));
    const req = createRequire(pathToFileURL(path.join(binDir, "node_modules", "noop.js")).href);
    sharpModule = req("sharp");
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

async function processShot(bytes, crop) {
  const sharp = loadSharp();
  const buf = Buffer.from(bytes);
  if (!sharp) {
    return { buf, dims: getJpegDimensions(bytes) };
  }
  let pipe = sharp(buf);
  if (crop) {
    pipe = pipe.extract(crop);
  }
  if (SHOT_MAX_WIDTH > 0) {
    pipe = pipe.resize({ width: SHOT_MAX_WIDTH, withoutEnlargement: true });
  }
  const out = await pipe.jpeg({ quality: SHOT_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buf: out.data, dims: { width: out.info.width, height: out.info.height } };
}

let desktopClientPromise = null;
let desktopClient = null;
let activeDragHandle = null;

async function getClient() {
  if (desktopClient) {
    return desktopClient;
  }
  if (!desktopClientPromise) {
    desktopClientPromise = (async () => {
      const clientPath = findCodexSkyClientPath();
      const mod = await import(pathToFileURL(clientPath).href);
      const client = mod.WindowsComputerUseClient.createDesktopClient({});
      desktopClient = client;
      return client;
    })().catch((err) => {
      desktopClientPromise = null;
      throw err;
    });
  }
  return desktopClientPromise;
}

async function closeClient() {
  stopOverlay();
  activeDragHandle = null;
  const current = desktopClient;
  desktopClient = null;
  desktopClientPromise = null;
  if (current) {
    try {
      await current.close();
    } catch {
      // Ignore cleanup errors on exit.
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JsonLineDaemon {
  constructor(spawnFn, name) {
    this.spawnFn = spawnFn;
    this.name = name;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
  }

  ensureStarted() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return;
    }
    const proc = this.spawnFn();
    this.proc = proc;
    this.buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            if (msg.ok) entry.resolve(msg.result);
            else entry.reject(new Error(msg.error || `${this.name} request failed`));
          }
        } catch {
          // Ignore non-JSON noise.
        }
      }
    });
    const failAll = (err) => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
        this.pending.delete(id);
      }
      if (this.proc === proc) this.proc = null;
    };
    proc.on("exit", () => failAll(new Error(`${this.name} daemon exited`)));
    proc.on("error", (err) => failAll(err));
  }

  request(payload, timeoutMs = 15000) {
    this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} request timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, "utf8");
    });
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      try {
        proc.stdin?.end();
      } catch {
        // Ignore.
      }
      try {
        proc.kill();
      } catch {
        // Ignore.
      }
    }
  }
}

const winDaemon = new JsonLineDaemon(
  () =>
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WIN_TOOLS_PS_SCRIPT, "-Daemon"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }),
  "win_tools"
);

const uiaDaemon = new JsonLineDaemon(
  () =>
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", UIA_TREE_SCRIPT, "-Daemon"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }),
  "uia_tree"
);

function runWinTool(action, payload = {}) {
  return winDaemon.request({ action, payload }, 15000);
}

function getUiTree({ hwnd = 0, max_elements = 80, filter = "" } = {}) {
  return uiaDaemon.request(
    {
      op: "tree",
      hwnd: hwnd || 0,
      max_elements: max_elements || 80,
      filter: filter || "",
    },
    15000
  );
}

async function clickUiElement(client, { hwnd = 0, name = "", automation_id = "", control_type = "", index = 0, method = "auto" } = {}) {
  const res = await uiaDaemon.request(
    { op: "invoke", hwnd: hwnd || 0, name, automation_id, control_type, index, method },
    15000
  );
  if (!res.invoked && res.center) {
    overlayCommand(`CLICK:${res.center.x},${res.center.y}`);
    await client.click({ x: res.center.x, y: res.center.y });
    res.invoked = true;
    res.method = "mouse_fallback";
  } else if (res.center) {
    overlayCommand(`CLICK:${res.center.x},${res.center.y}`);
  }
  return res;
}

async function setUiElementValue(client, { hwnd = 0, name = "", automation_id = "", control_type = "", index = 0, value = "" } = {}) {
  const res = await uiaDaemon.request(
    { op: "set_value", hwnd: hwnd || 0, name, automation_id, control_type, index, value },
    15000
  );
  if (!res.set && res.center) {
    await client.click({ x: res.center.x, y: res.center.y });
    await client.press_key({ key: "Control+a" });
    await client.paste({ text: String(value) });
    res.set = true;
    res.method = "paste_fallback";
  }
  return res;
}

async function waitForWindow({ title_contains, timeout_ms = 10000, poll_ms = 150, activate = true }) {
  const needle = String(title_contains || "").toLowerCase();
  const deadline = Date.now() + Math.min(Math.max(Number(timeout_ms) || 10000, 200), 60000);
  const interval = Math.min(Math.max(Number(poll_ms) || 150, 50), 2000);

  while (Date.now() <= deadline) {
    assertNotAborted();
    const wins = await runWinTool("list_windows", {});
    const found = wins.find((w) => String(w.title || "").toLowerCase().includes(needle));
    if (found) {
      if (activate) {
        try {
          await runWinTool("activate_window", { hwnd: found.hwnd });
        } catch {
          // Non-fatal if already active.
        }
      }
      return { found: true, window: found };
    }
    await sleep(interval);
  }
  return { found: false, window: null };
}

async function resolveWindowCrop(fullDims, { window_only = false, hwnd = 0 } = {}) {
  if (!window_only && !hwnd) return null;
  try {
    const wins = await runWinTool("list_windows", {});
    const win = hwnd ? wins.find((w) => w.hwnd === hwnd) : wins.find((w) => w.foreground);
    if (!win || !win.bounds) return null;
    const left = Math.max(0, Math.min(win.bounds.x, fullDims.width - 1));
    const top = Math.max(0, Math.min(win.bounds.y, fullDims.height - 1));
    const right = Math.max(left + 1, Math.min(win.bounds.x + win.bounds.width, fullDims.width));
    const bottom = Math.max(top + 1, Math.min(win.bounds.y + win.bounds.height, fullDims.height));
    const width = right - left;
    const height = bottom - top;
    if (width < 20 || height < 20) return null;
    return { left, top, width, height };
  } catch {
    return null;
  }
}

async function captureScreenshotContent(client, opts = {}) {
  const shots = await client.get_screenshot();
  const content = [];
  for (const shot of shots) {
    let rawBytes = shot.bytes ? Buffer.from(shot.bytes) : null;
    if (!rawBytes && shot.data_url?.startsWith("data:")) {
      rawBytes = Buffer.from(shot.data_url.slice(shot.data_url.indexOf(",") + 1), "base64");
    }
    if (!rawBytes) continue;

    const fullDims = getJpegDimensions(rawBytes) ?? lastScreenshotDims;
    const crop = await resolveWindowCrop(fullDims, opts);
    let outBuf = rawBytes;
    let outDims = fullDims;

    if (!opts.raw || crop) {
      try {
        const processed = await processShot(rawBytes, crop);
        outBuf = processed.buf;
        outDims = processed.dims ?? outDims;
      } catch {
        // Fallback to raw bytes if sharp fails.
      }
    }

    lastScreenshotDims = outDims;
    lastShotOrigin = crop ? { x: crop.left, y: crop.top } : { x: 0, y: 0 };

    content.push({ type: "image", data: outBuf.toString("base64"), mimeType: "image/jpeg" });
    content.push({
      type: "text",
      text: JSON.stringify({
        filepath: shot.filepath,
        width: outDims.width,
        height: outDims.height,
        origin: lastShotOrigin,
        bytes: outBuf.length,
        orig_bytes: rawBytes.length,
      }),
    });
  }
  return content;
}

const SCREENSHOT_AFTER_PROP = {
  type: "boolean",
  description: "If true, immediately capture and return an updated screenshot after the action.",
};

const NORMALIZED_PROP = {
  type: "boolean",
  description: "If true, treat x/y as 0-1000 normalized coordinates and map to screenshot pixels automatically.",
};

const TOOLS = [
  {
    name: "get_screenshot",
    description:
      "Capture a compressed screenshot of the Windows desktop (or just the foreground/specified window when window_only=true) and return the image plus exact {width, height, origin} pixel metadata.",
    inputSchema: {
      type: "object",
      properties: {
        window_only: { type: "boolean", description: "If true, crop to the active foreground window (much smaller & faster)." },
        hwnd: { type: "integer", description: "Optional window handle to crop to." },
        raw: { type: "boolean", description: "If true, skip JPEG compression and return raw bytes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click at an (x, y) coordinate relative to the latest screenshot (or 0-1000 if normalized=true).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        mouse_button: { type: "string", enum: ["left", "right", "middle"] },
        click_count: { type: "integer", minimum: 1, maximum: 3 },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "move",
    description: "Move the mouse cursor to (x, y).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag",
    description: "Drag with the left mouse button through a path of {x, y} points.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_start",
    description: "Press and hold the left mouse button at (x, y) to begin an interactive multi-step drag.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_move",
    description: "Move the held mouse button to (x, y) during an active drag_start session.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_end",
    description: "Release the held mouse button to complete an active drag_start session.",
    inputSchema: {
      type: "object",
      properties: {
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll at (x, y); 120 is one wheel notch (positive delta_y scrolls down).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        delta_x: { type: "number" },
        delta_y: { type: "number" },
        normalized: NORMALIZED_PROP,
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Type Unicode text into the currently focused control.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: "Press a key or plus-separated chord (e.g., 'Enter', 'Control+c', 'Alt+Tab').",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "paste",
    description: "Paste text into the focused control (replaces the Windows clipboard).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "batch_actions",
    description:
      "Execute multiple GUI actions sequentially in a single call for much faster multi-step workflows, optionally returning a screenshot at the end.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "move", "drag", "scroll", "type_text", "press_key", "paste", "wait"],
              },
              x: { type: "number" },
              y: { type: "number" },
              mouse_button: { type: "string", enum: ["left", "right", "middle"] },
              click_count: { type: "integer", minimum: 1, maximum: 3 },
              path: {
                type: "array",
                items: {
                  type: "object",
                  properties: { x: { type: "number" }, y: { type: "number" } },
                  required: ["x", "y"],
                },
              },
              delta_x: { type: "number" },
              delta_y: { type: "number" },
              text: { type: "string" },
              key: { type: "string" },
              ms: { type: "integer", minimum: 0, maximum: 10000 },
              normalized: NORMALIZED_PROP,
            },
            required: ["type"],
          },
        },
        screenshot_after: {
          type: "boolean",
          description: "Capture a final screenshot after all actions complete (default: true).",
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
  {
    name: "list_windows",
    description: "List visible top-level desktop windows with hwnd, pid, title, bounds, minimized, and foreground status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "activate_window",
    description: "Restore and bring a desktop window to the foreground by hwnd or case-insensitive title substring.",
    inputSchema: {
      type: "object",
      properties: {
        hwnd: { type: "integer" },
        title_contains: { type: "string" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_window",
    description:
      "Poll until a visible window whose title contains title_contains appears, optionally activating it and returning a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        title_contains: { type: "string" },
        timeout_ms: { type: "integer", minimum: 200, maximum: 60000 },
        activate: { type: "boolean" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["title_contains"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ui_tree",
    description:
      "Inspect the Windows UI Automation accessibility tree of the foreground (or specified hwnd) window in a single fast call, returning visible UI controls with exact clickable center {x, y} coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        hwnd: { type: "integer", description: "Optional window handle; defaults to foreground window." },
        filter: { type: "string", description: "Optional case-insensitive substring filter on name/control_type/automation_id." },
        max_elements: { type: "integer", minimum: 1, maximum: 300 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "click_element",
    description:
      "Directly invoke/click a UI control by name or automation_id using Windows UI Automation (no screenshot needed; automatically falls back to exact center mouse click if UIA invoke isn't supported).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Control name (exact match preferred, substring fallback)." },
        automation_id: { type: "string", description: "Optional UIA AutomationId." },
        control_type: { type: "string", description: "Optional UIA ControlType (e.g. Button, TabItem, MenuItem, Edit)." },
        hwnd: { type: "integer", description: "Optional target window handle." },
        index: { type: "integer", minimum: 0, description: "Match index if multiple controls match (default 0)." },
        method: { type: "string", enum: ["auto", "mouse"], description: "auto tries UIA Invoke/Select/Toggle first; mouse clicks center." },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_element_value",
    description:
      "Set text directly into an input/Edit control by name or automation_id via Windows UI Automation (falls back to click + Ctrl+A + paste).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        automation_id: { type: "string" },
        control_type: { type: "string" },
        hwnd: { type: "integer" },
        index: { type: "integer", minimum: 0 },
        value: { type: "string" },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "list_apps",
    description: "List installed Windows Start Menu / Store apps with name and app_id.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "launch_app",
    description: "Launch a Windows application by executable path/name or Start Menu app_id (from list_apps).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "run_js",
    description:
      "Codex node_repl-style async JavaScript runner with `cua` helper (click, move, drag, scroll, type_text, press_key, paste, get_screenshot, sleep, list_windows, activate_window, wait_for_window, get_ui_tree, list_apps, launch_app). Execute complex multi-step loops in one turn.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Async JavaScript body using `cua` and optional `return` value." },
        screenshot_after: SCREENSHOT_AFTER_PROP,
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "close_session",
    description: "Close and reset the active Codex Computer Use desktop session and hide the screen overlay.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

async function executeSingleAction(client, type, args) {
  assertNotAborted();
  switch (type) {
    case "click": {
      const pt = resolvePoint(args.x, args.y, args.normalized);
      overlayCommand(`CLICK:${pt.x},${pt.y}`);
      await client.click({
        x: pt.x,
        y: pt.y,
        ...(args.mouse_button ? { mouse_button: args.mouse_button } : {}),
        ...(args.click_count ? { click_count: args.click_count } : {}),
      });
      return `Clicked at (${pt.x}, ${pt.y}).`;
    }
    case "move": {
      const pt = resolvePoint(args.x, args.y, args.normalized);
      overlayCommand(`MOVE:${pt.x},${pt.y}`);
      await client.move(pt);
      return `Moved cursor to (${pt.x}, ${pt.y}).`;
    }
    case "drag": {
      const mappedPath = args.path.map((p) => resolvePoint(p.x, p.y, args.normalized));
      if (mappedPath.length > 0) {
        overlayCommand(`CLICK:${mappedPath[0].x},${mappedPath[0].y}`);
      }
      await client.drag({ path: mappedPath });
      return `Dragged through ${mappedPath.length} points.`;
    }
    case "drag_start": {
      if (activeDragHandle) {
        throw new Error("A drag handle is already active; call drag_end first.");
      }
      const pt = resolvePoint(args.x, args.y, args.normalized);
      overlayCommand(`CLICK:${pt.x},${pt.y}`);
      const handle = client.drag_handle();
      activeDragHandle = handle;
      try {
        await handle.start(pt);
      } catch (err) {
        activeDragHandle = null;
        throw err;
      }
      return `Drag started at (${pt.x}, ${pt.y}).`;
    }
    case "drag_move": {
      if (!activeDragHandle) {
        throw new Error("No active drag handle; call drag_start first.");
      }
      const pt = resolvePoint(args.x, args.y, args.normalized);
      overlayCommand(`MOVE:${pt.x},${pt.y}`);
      await activeDragHandle.move_to(pt);
      return `Dragged to (${pt.x}, ${pt.y}).`;
    }
    case "drag_end": {
      if (!activeDragHandle) {
        throw new Error("No active drag handle; call drag_start first.");
      }
      const handle = activeDragHandle;
      activeDragHandle = null;
      await handle.end();
      return "Drag ended.";
    }
    case "scroll": {
      const pt = resolvePoint(args.x, args.y, args.normalized);
      await client.scroll({
        x: pt.x,
        y: pt.y,
        ...(args.delta_x !== undefined ? { delta_x: args.delta_x } : {}),
        ...(args.delta_y !== undefined ? { delta_y: args.delta_y } : {}),
      });
      return `Scrolled at (${pt.x}, ${pt.y}) dx=${args.delta_x ?? 0} dy=${args.delta_y ?? 0}.`;
    }
    case "type_text":
      await client.type_text({ text: args.text });
      return `Typed ${args.text.length} characters.`;
    case "press_key":
      await client.press_key({ key: args.key });
      return `Pressed key '${args.key}'.`;
    case "paste":
      await client.paste({ text: args.text });
      return `Pasted ${args.text.length} characters.`;
    case "wait": {
      const ms = Math.min(Math.max(Number(args.ms ?? 250), 0), 10000);
      await sleep(ms);
      return `Waited ${ms}ms.`;
    }
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

async function runJsSnippet(code) {
  const client = await getClient();
  const cua = {
    get_screenshot: async () => {
      assertNotAborted();
      return client.get_screenshot();
    },
    click: (a) => executeSingleAction(client, "click", a),
    move: (a) => executeSingleAction(client, "move", a),
    drag: (a) => executeSingleAction(client, "drag", a),
    scroll: (a) => executeSingleAction(client, "scroll", a),
    type_text: (a) => executeSingleAction(client, "type_text", typeof a === "string" ? { text: a } : a),
    press_key: (a) => executeSingleAction(client, "press_key", typeof a === "string" ? { key: a } : a),
    paste: (a) => executeSingleAction(client, "paste", typeof a === "string" ? { text: a } : a),
    sleep: async (ms) => {
      assertNotAborted();
      await sleep(ms);
    },
    list_windows: () => {
      assertNotAborted();
      return runWinTool("list_windows", {});
    },
    activate_window: (a) => {
      assertNotAborted();
      return runWinTool("activate_window", a);
    },
    wait_for_window: (a) => waitForWindow(a),
    get_ui_tree: (a) => {
      assertNotAborted();
      return getUiTree(a);
    },
    click_element: (a) => {
      assertNotAborted();
      return clickUiElement(client, typeof a === "string" ? { name: a } : a);
    },
    set_element_value: (a) => {
      assertNotAborted();
      return setUiElementValue(client, a);
    },
    list_apps: () => {
      assertNotAborted();
      return runWinTool("list_apps", {});
    },
    launch_app: (a) => {
      assertNotAborted();
      return runWinTool("launch_app", typeof a === "string" ? { target: a } : a);
    },
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("cua", code);
  return fn(cua);
}

async function handleToolCall(name, args = {}) {
  if (name === "close_session") {
    escAbortedUntil = 0;
    await closeClient();
    return { content: [{ type: "text", text: "Desktop session closed and overlay hidden." }] };
  }

  assertNotAborted();

  if (name === "list_windows" || name === "list_apps") {
    const data = await runWinTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  if (name === "get_ui_tree") {
    const data = await getUiTree(args);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  if (name === "click_element" || name === "set_element_value") {
    bumpOverlay();
    const client = await getClient();
    const data =
      name === "click_element"
        ? await clickUiElement(client, args)
        : await setUiElementValue(client, args);
    const content = [{ type: "text", text: JSON.stringify(data) }];
    if (args.screenshot_after) {
      assertNotAborted();
      content.push(...(await captureScreenshotContent(client)));
    }
    return { content };
  }

  if (name === "activate_window" || name === "launch_app") {
    bumpOverlay();
    const data = await runWinTool(name, args);
    const content = [{ type: "text", text: JSON.stringify(data) }];
    if (args.screenshot_after) {
      assertNotAborted();
      const client = await getClient();
      content.push(...(await captureScreenshotContent(client)));
    }
    return { content };
  }

  if (name === "wait_for_window") {
    bumpOverlay();
    const data = await waitForWindow(args);
    const content = [{ type: "text", text: JSON.stringify(data) }];
    if (args.screenshot_after) {
      assertNotAborted();
      const client = await getClient();
      content.push(...(await captureScreenshotContent(client)));
    }
    return { content };
  }

  if (name === "run_js") {
    bumpOverlay();
    const result = await runJsSnippet(args.code);
    const content = [{ type: "text", text: JSON.stringify(result ?? "ok") }];
    if (args.screenshot_after) {
      assertNotAborted();
      const client = await getClient();
      content.push(...(await captureScreenshotContent(client)));
    }
    return { content };
  }

  bumpOverlay();
  const client = await getClient();

  if (name === "get_screenshot") {
    return { content: await captureScreenshotContent(client, args) };
  }

  if (name === "batch_actions") {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    const logs = [];
    for (const act of actions) {
      assertNotAborted();
      logs.push(await executeSingleAction(client, act.type, act));
    }
    const content = [{ type: "text", text: logs.join("\n") }];
    if (args.screenshot_after !== false) {
      assertNotAborted();
      content.push(...(await captureScreenshotContent(client)));
    }
    return { content };
  }

  const summary = await executeSingleAction(client, name, args);
  const content = [{ type: "text", text: summary }];
  if (args.screenshot_after) {
    assertNotAborted();
    content.push(...(await captureScreenshotContent(client)));
  }
  return { content };
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      if (!process.env.CODEX_CUA_OVERLAY_TEXT?.trim() && params?.clientInfo?.name) {
        overlayText = `${params.clientInfo.name} 正在操作电脑`;
        if (overlayProc) {
          overlayCommand(`TEXT:${overlayText}`);
        }
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "codex-cua-mcp", version: "2.1.0" },
        },
      });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const result = await handleToolCall(params?.name, params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      });
    }
  }
}

void getClient().catch(() => {});
try {
  winDaemon.ensureStarted();
  uiaDaemon.ensureStarted();
  ensureOverlayProcess();
} catch {
  // Lazy start on first call if pre-warm fails.
}

let messageQueue = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    messageQueue = messageQueue.then(() => handleMessage(parsed)).catch(() => {});
  } catch (err) {
    process.stderr.write(`Invalid JSON-RPC line: ${err}\n`);
  }
});

function shutdownAll() {
  winDaemon.close();
  uiaDaemon.close();
  killOverlay();
  return closeClient();
}

rl.on("close", () => {
  void messageQueue
    .then(() => shutdownAll())
    .finally(() => process.exit(0));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void shutdownAll().finally(() => process.exit(0));
  });
}
