import Cocoa
import Foundation

final class Launcher: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "Checking server…")
    var stopButton: NSButton!
    var child: Process?
    var timer: Timer?
    var log: FileHandle?
    var active = false
    var checking = false
    // Finder supplies no project argument; the app bundle lives beside the source.
    let root = CommandLine.arguments.count > 1
        ? URL(fileURLWithPath: CommandLine.arguments[1])
        : Bundle.main.bundleURL.deletingLastPathComponent()
    var env = ProcessInfo.processInfo.environment
    var address: String { "http://127.0.0.1:\(env["HARNESS_PORT"] ?? "8787")" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")

        if let config = try? String(contentsOf: root.appendingPathComponent(".orchestrator-node.env"), encoding: .utf8) {
            for line in config.components(separatedBy: .newlines) {
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("#") { continue }
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                if parts.count == 2 && env[parts[0]] == nil {
                    env[parts[0]] = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
                }
            }
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 490, height: 210),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Distributed Orchestrator"
        window.appearance = NSAppearance(named: .darkAqua)
        let content = window.contentView!
        status.frame = NSRect(x: 20, y: 155, width: 450, height: 24)
        content.addSubview(status)
        let link = NSButton(title: address, target: self, action: #selector(openBrowser))
        link.frame = NSRect(x: 20, y: 100, width: 450, height: 44)
        link.bezelStyle = .rounded
        content.addSubview(link)
        stopButton = NSButton(title: "Stop server", target: self, action: #selector(stop))
        stopButton.frame = NSRect(x: 170, y: 35, width: 150, height: 44)
        stopButton.bezelStyle = .rounded
        content.addSubview(stopButton)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        check { found in
            if found {
                self.status.stringValue = "Active — managed by an existing service"
                self.stopButton.title = "Close launcher"
            } else { self.start() }
        }
    }

    func check(_ completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: address)!)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                completion(code == 401 || (error == nil && text.contains("Distributed Orchestrator")))
            }
        }.resume()
    }

    func start() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "server/index.js"]
        process.currentDirectoryURL = root
        process.environment = env
        let path = root.appendingPathComponent(".launcher.log").path
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        log = FileHandle(forWritingAtPath: path)
        log?.seekToEndOfFile()
        process.standardOutput = log
        process.standardError = log
        do {
            try process.run()
            child = process
            status.stringValue = "Starting…"
            timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
                guard process.isRunning else {
                    self.status.stringValue = "Stopped — details in .launcher.log"
                    self.stopButton.title = "Close launcher"
                    self.stopButton.isEnabled = true
                    self.timer?.invalidate()
                    return
                }
                if self.checking { return }
                self.checking = true
                self.check { found in
                    self.checking = false
                    self.status.stringValue = found ? "Active" : "Waiting for server — see .launcher.log"
                }
            }
        } catch {
            status.stringValue = "Could not start Node.js: \(error.localizedDescription)"
            stopButton.title = "Close launcher"
        }
    }

    @objc func openBrowser() {
        var components = URLComponents(string: address)!
        var token = env["HARNESS_TOKEN"] ?? ""
        if token == "auto" {
            let data = env["HARNESS_DATA_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/harness"
            token = (try? String(contentsOfFile: data + "/server-token", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        if !token.isEmpty { components.queryItems = [URLQueryItem(name: "t", value: token)] }
        NSWorkspace.shared.open(components.url!)
    }
    @objc func stop() {
        if let process = child, process.isRunning {
            process.terminate()
            stopButton.isEnabled = false
            status.stringValue = "Stopping…"
        } else { NSApp.terminate(nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let process = child, process.isRunning {
            let alert = NSAlert()
            alert.messageText = "Stop this server?"
            alert.informativeText = "Phone access through this machine will also stop."
            alert.addButton(withTitle: "Stop server")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
            process.terminate()
        }
        return .terminateNow
    }
}
let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
