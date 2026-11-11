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

/// What the manager's `status` command reports, reduced to what the window shows.
struct FactoryState {
    var installed = false
    var version = ""
    var components: [String] = []
    var healthy = false
    var loaded = false
    var workersRunning = false
    var pendingRecovery = false
    var channel = "preview"

    init() {}
    init(_ value: [String: Any]) {
        let install = value["installation"] as? [String: Any]
        installed = install != nil
        version = install?["version"] as? String ?? ""
        components = install?["components"] as? [String] ?? []
        healthy = value["core_healthy"] as? Bool == true
        loaded = value["core_loaded"] as? Bool == true
        workersRunning = value["skidbladnir_loaded"] as? Bool == true
        pendingRecovery = value["pending_recovery"] as? Bool == true
        channel = value["channel"] as? String ?? "preview"
    }

    var running: Bool { healthy || loaded }
    var hasWorkers: Bool { components.contains("skidbladnir") }
    var hasHulder: Bool { components.contains("hulder") }

    /// One line for the window, the menu and the menu bar tooltip.
    var headline: String {
        if pendingRecovery { return "An update was interrupted: finish or undo it under Updates" }
        if !installed { return "Not installed yet: install the factory under Updates" }
        if healthy { return "Running · version \(version)" }
        if loaded { return "Starting or unhealthy · version \(version): run Check health" }
        return "Stopped · version \(version): press Start factory"
    }
    var colour: NSColor {
        if pendingRecovery || (loaded && !healthy) { return .systemOrange }
        if healthy { return .systemGreen }
        return .secondaryLabelColor
    }
}

final class FactoryDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var menuStatus: NSMenuItem!
    private var window: NSWindow!
    private var output: NSTextView!
    private var headline: NSTextField!
    private var dot: NSTextField!
    private var busy = false
    private var state = FactoryState()
    private var updateAvailable = false
    private var controls: [NSControl] = []
    private var channelControl: NSPopUpButton!
    private var loginControl: NSButton!
    private var refreshTimer: Timer?
    private var more: NSStackView!
    private var moreToggle: NSButton!
    private var root: NSStackView!
    private var moreRowRef: NSView!
    private var updateTimer: Timer?
    private let manager = Bundle.main.url(forResource: "viking", withExtension: nil)!

    // Buttons whose availability follows the factory's state.
    private var startStop: NSButton!
    private var openHeimdallButton: NSButton!
    private var codesButton: NSButton!
    private var healthButton: NSButton!
    private var workersSection: NSStackView!
    private var workersButton: NSButton!
    private var openWorkersButton: NSButton!
    private var hulderButton: NSButton!
    private var installUpdateButton: NSButton!
    private var undoButton: NSButton!
    private var recoverButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "V"
        statusItem.button?.setAccessibilityLabel("Viking Factory")
        let menu = NSMenu()
        menuStatus = NSMenuItem(title: "Checking the factory…", action: nil, keyEquivalent: "")
        menuStatus.isEnabled = false
        menu.addItem(menuStatus)
        menu.addItem(.separator())
        for (title, action) in [("Open Heimdall", #selector(openHeimdall)), ("Show the Viking Factory window", #selector(showWindow)), ("Check for updates", #selector(checkUpdates))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; menu.addItem(item)
        }
        menu.addItem(.separator())
        for (title, action) in [("Open updated companion", #selector(restartCompanion)), ("Quit the companion (the factory keeps running)", #selector(quit))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; menu.addItem(item)
        }
        statusItem.menu = menu
        buildWindow()
        showWindow()
        refresh()
        // Status is cheap (launchctl and local ports); updates query GitHub, so hourly.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.backgroundUpdateCheck() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.backgroundUpdateCheck() }
    }

    // MARK: building the window

    private func button(_ title: String, _ action: Selector, tip: String, primary: Bool = false) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded; b.font = .systemFont(ofSize: 13)
        b.toolTip = tip
        if primary { b.keyEquivalent = "\r" }
        b.heightAnchor.constraint(equalToConstant: 30).isActive = true
        controls.append(b); return b
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views); stack.orientation = .horizontal
        stack.spacing = 10; stack.distribution = .fillEqually; return stack
    }
    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = .systemFont(ofSize: size, weight: weight)
        if secondary { l.textColor = .secondaryLabelColor }
        return l
    }
    /// A titled group: heading, one line of explanation, then its rows.
    private func section(_ title: String, _ explanation: String, _ rows: [NSView], in root: NSStackView) -> NSStackView {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 8
        box.addArrangedSubview(label(title, size: 15, weight: .semibold))
        box.addArrangedSubview(label(explanation, size: 12, secondary: true))
        for r in rows { box.addArrangedSubview(r); r.widthAnchor.constraint(equalTo: box.widthAnchor).isActive = true }
        root.addArrangedSubview(box)
        box.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        return box
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 460), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Viking Factory"; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 620, height: 420); window.center()
        root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 18
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), root.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 22), root.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -20)])

        root.addArrangedSubview(label("Your local factory", size: 24, weight: .bold))
        dot = NSTextField(labelWithString: "●"); dot.font = .systemFont(ofSize: 16)
        headline = label("Checking the factory…", size: 15)
        let status = NSStackView(views: [dot, headline]); status.orientation = .horizontal; status.spacing = 8
        root.addArrangedSubview(status)

        startStop = button("Start factory", #selector(startOrStop), tip: "Starts Sindri, Mimir and Heimdall as background services.")
        openHeimdallButton = button("Open Heimdall", #selector(openHeimdall), tip: "Opens the command center in your browser. Sign in with the code from Show sign-in codes.")
        codesButton = button("Show sign-in codes", #selector(access), tip: "Shows the Heimdall access token, the operator code that unlocks actions in Heimdall, and the Sindri pairing code for approvals. They change each time the factory starts.")
        healthButton = button("Check health", #selector(doctor), tip: "Checks that Git, Codex and Claude Code are installed and signed in, and that the factory's services answer.")
        _ = section("Everyday", "Start the factory, open it, and sign in.", [row([startStop, openHeimdallButton]), row([codesButton, healthButton])], in: root)

        // Things used rarely live behind one expander, closed by default.
        moreToggle = NSButton(title: "More options", target: self, action: #selector(toggleMore))
        moreToggle.setButtonType(.pushOnPushOff); moreToggle.bezelStyle = .disclosure; moreToggle.state = .off
        moreToggle.toolTip = "Shows workers, updates and help: things you will rarely need."
        let moreLabel = NSTextField(labelWithString: "More options: workers, updates and help")
        moreLabel.font = .systemFont(ofSize: 13, weight: .medium)
        let click = NSClickGestureRecognizer(target: self, action: #selector(toggleMoreFromLabel)); moreLabel.addGestureRecognizer(click)
        moreToggle.title = ""
        let moreRow = NSStackView(views: [moreToggle, moreLabel]); moreRow.orientation = .horizontal; moreRow.spacing = 6
        root.addArrangedSubview(moreRow)
        more = NSStackView(); more.orientation = .vertical; more.alignment = .leading; more.spacing = 18
        // Not in the window until expanded: a hidden subview of a stack view can still be laid out.
        moreRowRef = moreRow

        workersButton = button("Start workers", #selector(startWorkers), tip: "Starts Skidbladnir, which manages disposable worker machines. It simulates them unless you configure AWS.")
        openWorkersButton = button("Open workers", #selector(openWorkers), tip: "Opens Skidbladnir in your browser (127.0.0.1:4380).")
        hulderButton = button("Open Hulder", #selector(openHulder), tip: "Opens Hulder, the code editor, if it was installed with the factory.")
        workersSection = section("Workers and tools", "Optional parts. Only what you installed is shown.", [row([workersButton, openWorkersButton]), row([hulderButton, NSView()])], in: more)

        let check = button("Check for updates", #selector(checkUpdates), tip: "Looks on GitHub for a newer signed factory release on your release channel.")
        installUpdateButton = button("Install update", #selector(update), tip: "Downloads the newer release, verifies its signature, backs up your data and switches over. Waits until no run is in progress.")
        undoButton = button("Undo last update", #selector(rollback), tip: "Goes back to the version installed before the last update, restoring the data backup taken then.")
        recoverButton = button("Finish interrupted update", #selector(recover), tip: "Completes or reverses an update that stopped part way (for example the Mac shut down).")
        let fromFile = button("Install from a file…", #selector(installBundle), tip: "Installs a factory bundle you built or downloaded: choose its factory-manifest.json. Use only bundles you trust.")
        channelControl = NSPopUpButton(); channelControl.addItems(withTitles: ["Preview releases", "Stable releases"])
        channelControl.target = self; channelControl.action = #selector(channelChanged(_:))
        channelControl.toolTip = "Which releases Check for updates offers: Preview gets new versions first, Stable only tested ones."
        controls.append(channelControl)
        _ = section("Updates", "New versions keep your projects and history; each update is backed up first.", [row([check, installUpdateButton]), row([undoButton, recoverButton]), row([fromFile, channelControl])], in: more)

        let signIn = button("Agent sign-in help", #selector(signInHelp), tip: "How to sign Codex and Claude Code in, if Check health says they are not.")
        let logs = button("View logs", #selector(logs), tip: "Shows the factory services' recent log output.")
        let diagnostics = button("Save diagnostics…", #selector(exportDiagnostics), tip: "Saves a status report (no project content) to a file, for troubleshooting.")
        loginControl = NSButton(checkboxWithTitle: "Open this app at login", target: self, action: #selector(loginChanged(_:)))
        loginControl.toolTip = "Opens the Viking Factory app when you log in to the Mac."
        if #available(macOS 13.0, *) { loginControl.state = SMAppService.mainApp.status == .enabled ? .on : .off }
        controls.append(loginControl)
        _ = section("Help", "When something looks wrong.", [row([signIn, logs, diagnostics]), loginControl], in: more)

        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        output = NSTextView(); output.isEditable = false; output.isSelectable = true
        output.font = .monospacedSystemFont(ofSize: 12, weight: .regular); output.textContainerInset = NSSize(width: 10, height: 10)
        output.autoresizingMask = [.width]; output.isHorizontallyResizable = false; output.textContainer?.widthTracksTextView = true
        output.setAccessibilityLabel("Results of the last action"); scroll.documentView = output
        output.string = "Results of what you click appear here.\n\nHover over any button to see what it does."
        root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        root.addArrangedSubview(label("Your projects and their data stay on this Mac.", size: 11, secondary: true))
    }

    // MARK: state

    /// Enables what can work now; a disabled control's tooltip says why.
    private func applyState() {
        let s = state
        dot.textColor = s.colour
        menuStatus.title = s.headline
        statusItem.button?.title = updateAvailable ? "V •" : "V"
        statusItem.button?.toolTip = "Viking Factory: " + s.headline
        // While an action runs its "Working…" text stays; a background refresh must not replace it.
        guard !busy else { return }
        headline.stringValue = s.headline
        controls.forEach { $0.isEnabled = true }

        startStop.title = s.running ? "Stop factory" : "Start factory"
        startStop.toolTip = s.running
            ? "Stops the factory's services. It waits until no run is in progress."
            : "Starts Sindri, Mimir and Heimdall as background services."
        startStop.isEnabled = s.installed && !s.pendingRecovery
        // The highlighted button is the safe next step: open it while running, start it while stopped.
        startStop.keyEquivalent = !s.running && startStop.isEnabled ? "\r" : ""
        openHeimdallButton.keyEquivalent = s.healthy ? "\r" : ""
        openHeimdallButton.isEnabled = s.healthy
        codesButton.isEnabled = s.installed
        if !s.healthy { openHeimdallButton.toolTip = "Start the factory first." }
        else { openHeimdallButton.toolTip = "Opens the command center in your browser. Sign in with the code from Show sign-in codes." }

        workersSection.isHidden = !(s.hasWorkers || s.hasHulder)
        workersButton.isHidden = !s.hasWorkers; openWorkersButton.isHidden = !s.hasWorkers
        workersButton.title = s.workersRunning ? "Workers running" : "Start workers"
        workersButton.isEnabled = s.hasWorkers && !s.workersRunning
        openWorkersButton.isEnabled = s.workersRunning
        openWorkersButton.toolTip = s.workersRunning ? "Opens Skidbladnir in your browser (127.0.0.1:4380)." : "Start workers first."
        hulderButton.isHidden = !s.hasHulder

        installUpdateButton.isEnabled = updateAvailable && !s.pendingRecovery
        installUpdateButton.toolTip = updateAvailable
            ? "Downloads the newer release, verifies its signature, backs up your data and switches over. Waits until no run is in progress."
            : "No newer release found yet. Press Check for updates."
        undoButton.isEnabled = s.installed && !s.pendingRecovery
        recoverButton.isEnabled = s.pendingRecovery
        recoverButton.toolTip = s.pendingRecovery
            ? "Completes or reverses an update that stopped part way (for example the Mac shut down)."
            : "Nothing to finish: no update was interrupted."
        channelControl.selectItem(at: s.channel == "stable" ? 1 : 0)
    }

    private func refresh() {
        guard !busy else { return }
        execute(["status"]) { ok, value, _ in
            if ok, let value { self.state = FactoryState(value) }
            self.applyState()
        }
    }

    // MARK: running manager commands

    /// Runs the embedded manager CLI off the main thread and hands back its JSON.
    private func execute(_ args: [String], done: @escaping (Bool, [String: Any]?, String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process(); task.executableURL = self.manager; task.arguments = args
            let pipe = Pipe(); task.standardOutput = pipe; task.standardError = pipe
            var env = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
            task.environment = env
            var message = ""; var success = false
            do { try task.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit(); message = String(data: data, encoding: .utf8) ?? ""; success = task.terminationStatus == 0 }
            catch { message = error.localizedDescription }
            let value = message.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(success, value, message) }
        }
    }

    /// A user action: shows progress, the result, then the refreshed state.
    private func act(_ args: [String], working: String) {
        guard !busy else { return }
        busy = true; controls.forEach { $0.isEnabled = false }
        headline.stringValue = working
        execute(args) { ok, value, message in
            if ok && args == ["open", "companion"] { NSApp.terminate(nil); return }
            self.busy = false
            self.output.string = self.readable(value, message, ok: ok)
            if args.starts(with: ["update", "check"]), ok, let value {
                self.updateAvailable = value["available"] as? Bool == true && value["installable"] as? Bool == true
            }
            if args == ["update", "apply"], ok { self.updateAvailable = false }
            self.refresh()
        }
    }

    private func readable(_ value: [String: Any]?, _ message: String, ok: Bool) -> String {
        guard let value else { return message.isEmpty ? (ok ? "Done." : "That did not work.") : message }
        if let error = value["error"] as? String { return "That did not work:\n\n" + error }
        if let checks = value["checks"] as? [[String: Any]] {
            return "Health check\n\n" + checks.map { item in
                let name = (item["name"] as? String ?? "Check")
                let pretty = ["git": "Git", "codex": "Codex", "claude": "Claude Code", "managed runtime": "Installed factory"][name] ?? name.capitalized
                return pretty + ((item["ok"] as? Bool == true) ? ": ready" : ": needs attention. " + (item["action"] as? String ?? ""))
            }.joined(separator: "\n") + "\n\n" + FactoryState(value["status"] as? [String: Any] ?? [:]).headline
        }
        if value["heimdallToken"] != nil {
            return "Sign-in codes (they change each time the factory starts)\n\n"
                + "Heimdall access token: \(value["heimdallToken"] as? String ?? "")\n"
                + "Operator code (unlocks actions in Heimdall): \(value["operatorCode"] as? String ?? "")\n"
                + "Sindri pairing code (for approvals): \(value["sindriPairingCode"] as? String ?? "")"
        }
        if value["installation"] != nil { return FactoryState(value).headline }
        if let repositories = value["repositories"] as? [[String: Any]] {
            let found = (value["installable"] as? Bool == true)
            return (found ? "A newer factory release is available. Press Install update when ready." : "You have the latest release on this channel.")
                + "\n\nReleases checked:\n" + repositories.map { repo in
                    let release = repo["release"] as? [String: Any]
                    return "• " + (repo["repo"] as? String ?? "Project") + ": " + (repo["error"] as? String ?? release?["tag_name"] as? String ?? "none published")
                }.joined(separator: "\n")
        }
        if value["running"] as? Bool == true { return "Running." }
        if value["running"] as? Bool == false { return "Stopped." }
        return message
    }

    private func confirm(_ title: String, _ detail: String, action: () -> Void) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { action() }
    }

    // MARK: actions

    @objc private func startOrStop() {
        if state.running {
            confirm("Stop the factory?", "Sindri, Mimir and Heimdall stop until you start them again. The manager refuses while a run is in progress.") { self.act(["stop"], working: "Stopping the factory…") }
        } else { act(["start"], working: "Starting the factory…") }
    }
    @objc private func installBundle() {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("bundle/factory-manifest.json")
        let chosen: URL
        if FileManager.default.fileExists(atPath: bundled.path) { chosen = bundled } else {
            let dialog = NSOpenPanel(); dialog.message = "Choose factory-manifest.json from a factory bundle you trust."
            dialog.allowedContentTypes = [.json]; dialog.canChooseDirectories = false
            guard dialog.runModal() == .OK, let url = dialog.url else { return }
            chosen = url
        }
        // Optional parts are asked here, where they matter, instead of sitting in the window.
        let alert = NSAlert(); alert.messageText = "Install this factory bundle?"
        alert.informativeText = "It contains software that will run on this Mac. The core factory is always installed; choose any optional parts the bundle includes."
        let options = NSStackView(); options.orientation = .vertical; options.alignment = .leading
        let parts = [("skidbladnir", "Skidbladnir: worker machines"), ("hulder", "Hulder: code editor"), ("bifrost", "Bifrost")]
        let boxes = parts.map { id, title -> NSButton in let b = NSButton(checkboxWithTitle: title, target: nil, action: nil); b.identifier = NSUserInterfaceItemIdentifier(id); b.state = id == "skidbladnir" ? .on : .off; return b }
        boxes.forEach { options.addArrangedSubview($0) }
        options.frame = NSRect(x: 0, y: 0, width: 280, height: 70); alert.accessoryView = options
        alert.addButton(withTitle: "Install"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let selected = boxes.filter { $0.state == .on }.compactMap { $0.identifier?.rawValue }
        act(["install", chosen.path] + selected, working: "Installing…")
    }
    private func backgroundUpdateCheck() {
        guard !busy else { return }
        execute(["update", "check"]) { ok, value, _ in
            if ok, let value { self.updateAvailable = value["available"] as? Bool == true && value["installable"] as? Bool == true }
            self.applyState()
        }
    }
    @objc private func toggleMoreFromLabel() { moreToggle.state = moreToggle.state == .on ? .off : .on; toggleMore() }
    @objc private func toggleMore() {
        if moreToggle.state == .on {
            guard more.superview == nil, let at = root.arrangedSubviews.firstIndex(of: moreRowRef) else { return }
            root.insertArrangedSubview(more, at: at + 1)
            more.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        } else {
            root.removeArrangedSubview(more); more.removeFromSuperview()
        }
        // Grow or shrink the window to fit, keeping its top edge where it is.
        root.layoutSubtreeIfNeeded()
        let height = max(window.minSize.height, root.fittingSize.height + 42)
        var frame = window.frame
        let content = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: frame.width, height: height))
        frame.origin.y += frame.height - content.height; frame.size.height = content.height
        window.setFrame(frame, display: true, animate: true)
    }
    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func access() { act(["access"], working: "Reading the sign-in codes…") }
    @objc private func doctor() { act(["doctor"], working: "Checking health…") }
    @objc private func startWorkers() { act(["start", "skidbladnir"], working: "Starting workers…") }
    @objc private func openWorkers() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4380/")!) }
    @objc private func openHeimdall() { act(["open", "heimdall"], working: "Opening Heimdall…") }
    @objc private func openHulder() { act(["open", "hulder"], working: "Opening Hulder…") }
    @objc private func checkUpdates() { act(["update", "check", "--force"], working: "Checking for updates…") }
    @objc private func update() { confirm("Install the update?", "The manager verifies the release's signature and waits for runs to finish before replacing the factory. Your projects and history are kept, and a backup is taken first.") { self.act(["update", "apply"], working: "Installing the update…") } }
    @objc private func rollback() { confirm("Undo the last update?", "This goes back to the previous version and restores the data backup taken before the update. Today's data is kept in a separate backup. The factory stays stopped afterwards.") { self.act(["rollback"], working: "Undoing the last update…") } }
    @objc private func recover() { act(["recover"], working: "Finishing the interrupted update…") }
    @objc private func logs() { act(["logs"], working: "Reading logs…") }
    @objc private func exportDiagnostics() { let dialog = NSSavePanel(); dialog.nameFieldStringValue = "viking-diagnostics.json"; if dialog.runModal() == .OK, let url = dialog.url { act(["diagnostics", url.path], working: "Saving diagnostics…") } }
    @objc private func signInHelp() { output.string = "Sign the agents in from Terminal:\n\ncodex login\nclaude auth login\n\nThen press Check health. The factory never asks for your account password.\n\nCodex: https://github.com/openai/codex\nClaude Code: https://code.claude.com/docs/en/setup" }
    @objc private func channelChanged(_ sender: NSPopUpButton) { act(["channel", sender.indexOfSelectedItem == 0 ? "preview" : "stable"], working: "Changing the release channel…") }
    @objc private func loginChanged(_ sender: NSButton) { if #available(macOS 13.0, *) { do { if sender.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { sender.state = .off; output.string = error.localizedDescription } } }
    @objc private func restartCompanion() { act(["open", "companion"], working: "Opening the updated companion…") }
    @objc private func quit() { NSApp.terminate(nil) }
}
