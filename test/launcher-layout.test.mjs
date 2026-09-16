import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('SKIP AppKit layout on non-Mac host');
} else {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-layout-'));
  try {
    const source = await fs.readFile('scripts/launcher.swift', 'utf8');
    // Instantiate only the view: never start/stop a server or read live config.
    const checks = `
let application = NSApplication.shared
let launcher = Launcher()
launcher.buildWindow()
let content = launcher.window.contentView!
let stack = content.subviews.compactMap { $0 as? NSStackView }.first!
for message in ["Checking…", "Private HTTPS route configured; phone reachability unverified.",
                "Tailscale unavailable. Install and open Tailscale on this host, then check again. Custom installations can set ORCHESTRATOR_TAILSCALE_BIN and ORCHESTRATOR_TAILSCALE_SOCKET."] {
    launcher.phoneStatus.stringValue = message
    launcher.phoneLink.stringValue = "https://distributed-orchestrator-with-a-long-machine-name.tail5785a3.ts.net:8443/"
    content.layoutSubtreeIfNeeded()
    let frames = stack.arrangedSubviews.map { $0.convert($0.bounds, to: content) }
    for (i, frame) in frames.enumerated() {
        precondition(content.bounds.contains(frame), "Row outside window: \\(i)")
        for other in frames.dropFirst(i + 1) {
            precondition(!frame.intersects(other), "Overlapping rows")
        }
    }
    precondition(launcher.copyButton.frame.height >= 44)
    precondition(launcher.stopButton.frame.height >= 44)
    precondition(abs(launcher.copyButton.frame.width - launcher.stopButton.frame.width) < 1)
    precondition(launcher.copyButton.frame.minY == launcher.stopButton.frame.minY)
}
precondition(!launcher.copyButton.isEnabled, "No URL must mean no copy action")
print("PASS native launcher layout: aligned actions, contained rows, long status and addresses")
`;
    const file = path.join(dir, 'layout.swift');
    const binary = path.join(dir, 'layout');
    await fs.writeFile(file, source.slice(0, source.lastIndexOf('\nlet app =')) + checks);
    const build = spawnSync('swiftc', [file, '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    console.log(run.stdout.trim());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
