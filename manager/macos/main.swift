import AppKit
import ServiceManagement
import UniformTypeIdentifiers

@main
struct VikingMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = FactoryDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

final class FactoryDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private var output: NSTextView!
    private var summary: NSTextField!
    private var buttons: [NSButton] = []
    private var busy = false
    private var channelControl: NSPopUpButton!
    private var preferencesControls: [NSControl] = []
    private var timer: Timer?
    private var selected = Set<String>()
    private let manager = Bundle.main.url(forResource: "viking", withExtension: nil)!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = "V"
        statusItem.button?.setAccessibilityLabel("Viking Factory")
        let menu = NSMenu()
        for (title, action) in [("Open Viking Factory", #selector(showWindow)), ("Check for updates", #selector(checkUpdates)), ("Open Heimdall", #selector(openHeimdall)), ("Open updated companion", #selector(restartCompanion)), ("Quit companion", #selector(quit))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; menu.addItem(item)
        }
        statusItem.menu = menu
        buildWindow()
        showWindow()
        run(["status"])
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.backgroundCheck() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.backgroundCheck() }
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded; b.font = .systemFont(ofSize: 14)
        b.heightAnchor.constraint(equalToConstant: 34).isActive = true
        buttons.append(b); return b
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views); stack.orientation = .horizontal
        stack.spacing = 12; stack.distribution = .fillEqually; return stack
    }
    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 730), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Viking Factory"; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 660, height: 650); window.center()
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 16
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), root.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24), root.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24)])
        let heading = NSTextField(labelWithString: "Your local factory"); heading.font = .systemFont(ofSize: 27, weight: .bold)
        summary = NSTextField(wrappingLabelWithString: "Install a compatible bundle, connect your agents, then start the factory.")
        summary.font = .systemFont(ofSize: 15); summary.textColor = .secondaryLabelColor
        root.addArrangedSubview(heading); root.addArrangedSubview(summary)
        let options = row(["Skidbladnir", "Hulder", "Bifrost"].map { name -> NSButton in
            let b = NSButton(checkboxWithTitle: name, target: self, action: #selector(componentChanged(_:)))
            b.identifier = NSUserInterfaceItemIdentifier(name.lowercased()); preferencesControls.append(b); return b
        })
        root.addArrangedSubview(options)
        let rows = [row([button("Install bundle", #selector(installBundle)),button("Health check", #selector(doctor)),button("Access codes", #selector(access))]),row([button("Start factory", #selector(start)),button("Stop services", #selector(stop)),button("Open Heimdall", #selector(openHeimdall))]),row([button("Check updates", #selector(checkUpdates)),button("Apply update", #selector(update)),button("Roll back", #selector(rollback))]),row([button("Agent sign in", #selector(signIn)),button("Local logs", #selector(logs)),button("Export diagnostics", #selector(exportDiagnostics))]),row([button("Open Hulder", #selector(openHulder)),button("Start workers", #selector(startWorkers)),button("Recover update", #selector(recover))])]
        for r in rows {root.addArrangedSubview(r); r.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true}
        let preferences = NSStackView();preferences.orientation = .horizontal;preferences.spacing = 16
        let channel = NSPopUpButton(); channelControl = channel; preferencesControls.append(channel); channel.addItems(withTitles: ["Preview updates", "Stable updates"]);channel.target = self;channel.action = #selector(channelChanged(_:));preferences.addArrangedSubview(channel)
        let login = NSButton(checkboxWithTitle: "Open at login", target: self, action: #selector(loginChanged(_:)))
        if #available(macOS 13.0, *) {login.state = SMAppService.mainApp.status == .enabled ? .on : .off}
        preferencesControls.append(login);preferences.addArrangedSubview(login);root.addArrangedSubview(preferences)
        let scroll = NSScrollView();scroll.hasVerticalScroller = true;scroll.borderType = .bezelBorder
        output = NSTextView();output.isEditable = false;output.isSelectable = true;output.font = .monospacedSystemFont(ofSize: 13, weight: .regular);output.textContainerInset = NSSize(width: 12, height: 12)
        output.autoresizingMask = [.width];output.isHorizontallyResizable = false;output.textContainer?.widthTracksTextView = true
        output.setAccessibilityLabel("Factory status and command results");scroll.documentView = output
        root.addArrangedSubview(scroll);scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true;scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true
        let footer = NSTextField(wrappingLabelWithString: "Updates wait for settled missions. Project data stays on this Mac. Cloud provisioning is never part of installation.")
        footer.textColor = .secondaryLabelColor;root.addArrangedSubview(footer)
    }
    private func run(_ args: [String], quiet: Bool = false) {
        guard !busy else {return};busy = true;buttons.forEach {$0.isEnabled = false};preferencesControls.forEach {$0.isEnabled = false}
        if !quiet {summary.stringValue = "Working…"}
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process(); task.executableURL = self.manager;task.arguments = args
            let pipe = Pipe();task.standardOutput = pipe;task.standardError = pipe
            var env = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
            task.environment = env
            var message = "";var success = false
            do {try task.run();let data = pipe.fileHandleForReading.readDataToEndOfFile();task.waitUntilExit();message = String(data: data, encoding: .utf8) ?? "No output";success = task.terminationStatus == 0}
            catch {message = error.localizedDescription}
            DispatchQueue.main.async {
                if success && args == ["open", "companion"] { NSApp.terminate(nil); return }
                self.busy = false;self.buttons.forEach {$0.isEnabled = true};self.preferencesControls.forEach {$0.isEnabled = true}
                if !quiet || !success {self.output.string = self.readable(message);self.summary.stringValue = success ? "Ready" : "Action needs attention"}
                if let data = message.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let channel = (value["channel"] as? String) ?? ((value["status"] as? [String: Any])?["channel"] as? String) { self.channelControl.selectItem(at: channel == "stable" ? 1 : 0) }
                if args.first == "update", let data = message.data(using: .utf8),let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],value["available"] as? Bool == true, value["installable"] as? Bool == true {self.statusItem.button?.title = "V •";self.summary.stringValue = "A newer factory release is available. Review and apply it when ready."}
            }
        }
    }
    private func readable(_ message: String) -> String {
        guard let data = message.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return message }
        if let error = value["error"] as? String { return error }
        if let checks = value["checks"] as? [[String: Any]] {
            return "Health checks\n\n" + checks.map { item in
                let name = (item["name"] as? String ?? "Check").capitalized
                return name + ((item["ok"] as? Bool == true) ? ": Ready" : ": Needs attention\n" + (item["action"] as? String ?? ""))
            }.joined(separator: "\n\n") + "\n\n" + describeStatus(value["status"] as? [String: Any] ?? [:])
        }
        if value["installation"] != nil { return describeStatus(value) }
        if let repositories = value["repositories"] as? [[String: Any]] {
            return "Release checks\n\n" + repositories.map { repo in
                let release = repo["release"] as? [String: Any]
                return (repo["repo"] as? String ?? "Project") + ": " + (repo["error"] as? String ?? release?["tag_name"] as? String ?? "No release published")
            }.joined(separator: "\n\n") + "\n\n" + ((value["installable"] as? Bool == true) ? "A compatible bundle is published. Apply update verifies its signature before installation." : "No installable factory bundle is published for this channel yet.")
        }
        return message
    }
    private func describeStatus(_ value: [String: Any]) -> String {
        let install = value["installation"] as? [String: Any]
        let components = install?["components"] as? [String] ?? []
        let version = install?["version"] as? String ?? "Not installed"
        let healthy = value["core_healthy"] as? Bool == true
        let loaded = value["core_loaded"] as? Bool == true
        let serviceState = healthy ? "Healthy" : (loaded ? "Loaded, check health" : "Stopped")
        let componentNames = components.isEmpty ? "None selected" : components.joined(separator: ", ")
        let channel = value["channel"] as? String ?? "preview"
        var lines = ["Factory version: \(version)", "Services: \(serviceState)", "Components: \(componentNames)", "Updates: \(channel)"]
        if value["pending_recovery"] as? Bool == true { lines.append("An interrupted update needs recovery.") }
        return lines.joined(separator: "\n\n")
    }
    private func confirm(_ title: String, _ detail: String, action: () -> Void) {
        let alert = NSAlert();alert.messageText = title;alert.informativeText = detail;alert.addButton(withTitle: "Continue");alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {action()}
    }
    @objc private func componentChanged(_ sender: NSButton) {guard let id = sender.identifier?.rawValue else{return};if sender.state == .on {selected.insert(id)} else {selected.remove(id)}}
    @objc private func installBundle() {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("bundle/factory-manifest.json")
        if FileManager.default.fileExists(atPath: bundled.path) {run(["install",bundled.path]+selected.sorted());return}
        let dialog = NSOpenPanel();dialog.message = "Select factory-manifest.json from a trusted local release bundle.";dialog.allowedContentTypes = [.json];dialog.canChooseDirectories = false
        if dialog.runModal() == .OK,let url = dialog.url {confirm("Install this local bundle?", "Local packages contain executable software. Select only a bundle you built or obtained from a trusted release."){self.run(["install",url.path]+self.selected.sorted())}}
    }
    private func backgroundCheck(){run(["update","check"],quiet:true)}
    @objc private func showWindow(){window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)}
    @objc private func access(){run(["access"])}
    @objc private func status(){run(["status"])}
    @objc private func doctor(){run(["doctor"])}
    @objc private func start(){run(["start"])}
    @objc private func startWorkers(){run(["start","skidbladnir"])}
    @objc private func stop(){run(["stop"])}
    @objc private func openHeimdall(){run(["open","heimdall"])}
    @objc private func openHulder(){run(["open","hulder"])}
    @objc private func checkUpdates(){run(["update","check","--force"])}
    @objc private func update(){confirm("Apply the compatible factory update?","The manager verifies signatures and checks active work before replacing software. Existing project data is preserved."){self.run(["update","apply"])}}
    @objc private func rollback(){confirm("Restore the previous installation?","This restores the data backup made before the last update. Current data is retained in a separate backup. Services remain stopped."){self.run(["rollback"])}}
    @objc private func recover(){run(["recover"])}
    @objc private func logs(){run(["logs"])}
    @objc private func exportDiagnostics(){let dialog = NSSavePanel();dialog.nameFieldStringValue = "viking-diagnostics.json";if dialog.runModal() == .OK,let url = dialog.url {run(["diagnostics",url.path])}}
    @objc private func signIn(){output.string = "Install the official Codex and Claude Code CLIs, then sign in from Terminal:\n\ncodex login\nclaude auth login\n\nRun Health check afterward. The factory never asks for your account password.\n\nCodex: https://github.com/openai/codex\nClaude Code: https://code.claude.com/docs/en/setup\n\nIf your tools use a custom PATH, run:\nviking config path \"$PATH\"";summary.stringValue = "Agent setup"}
    @objc private func channelChanged(_ sender: NSPopUpButton){run(["channel",sender.indexOfSelectedItem == 0 ? "preview":"stable"])}
    @objc private func loginChanged(_ sender: NSButton){if #available(macOS 13.0, *) {do {if sender.state == .on {try SMAppService.mainApp.register()} else {try SMAppService.mainApp.unregister()}}catch {sender.state = .off;output.string = error.localizedDescription}}}
    @objc private func restartCompanion(){run(["open","companion"])}
    @objc private func quit(){NSApp.terminate(nil)}
}
