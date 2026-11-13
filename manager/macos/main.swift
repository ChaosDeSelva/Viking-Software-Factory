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
    private var codesRow: NSStackView!
    private var codes: [String: String] = [:]
    private var copyTitles: [String: String] = [:]
    private var moreRowRef: NSView!
    private var updateTimer: Timer?
    private var stateKnown = false
    private var statusError: String?
    private var factoryWindowController: FactoryWindowController?
    private let manager = Bundle.main.url(forResource: "viking", withExtension: nil)!

    // Buttons whose availability follows the factory's state.
    private var startStop: NSButton!
    private var openHeimdallButton: NSButton!
    private var codesButton: NSButton!
    private var healthButton: NSButton!
    private var workersSection: NSStackView!
    private var workersButton: NSButton!
    private var openWorkersButton: NSButton!
    private var pageButtons: [NSButton] = []
    private var hulderButton: NSButton!
    private var installUpdateButton: NSButton!
    private var undoButton: NSButton!
    private var recoverButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "V"
        statusItem.button?.setAccessibilityLabel("Viking Factory")
        let menu = NSMenu()
        menuStatus = NSMenuItem(title: "Checking the factory…", action: nil, keyEquivalent: "")
        menuStatus.isEnabled = false
        menu.addItem(menuStatus)
        menu.addItem(.separator())
        for (title, action, key) in [("Open Factory Window", #selector(openFactoryWindow), "o"), ("Show the companion window", #selector(showWindow), ""), ("Check for updates", #selector(checkUpdates), "")] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
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

    /// A menu bar app shows no menus, but its main menu still routes Cmd+C, Cmd+A and the rest to the window.
    private func installEditMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(withTitle: "Open Factory Window", action: #selector(openFactoryWindow), keyEquivalent: "o").target = self
        // Shown in the menu bar while the factory window puts the app in the Dock.
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Viking Factory (the factory keeps running)", action: #selector(quit), keyEquivalent: "q").target = self
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        // Page switching targets the factory window directly, so it works from the companion window too.
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        for tab in FactoryTab.allCases {
            let item = view.addItem(withTitle: tab.title, action: #selector(selectFactoryTab(_:)), keyEquivalent: "\(tab.rawValue + 1)")
            item.tag = tab.rawValue; item.target = self
        }
        view.addItem(.separator())
        view.addItem(withTitle: "Back", action: #selector(FactoryWindowController.factoryBack(_:)), keyEquivalent: "[")
        view.addItem(withTitle: "Forward", action: #selector(FactoryWindowController.factoryForward(_:)), keyEquivalent: "]")
        view.addItem(withTitle: "Reload Page", action: #selector(FactoryWindowController.factoryReload(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Copy Page Address", action: #selector(FactoryWindowController.copyPageAddress(_:)), keyEquivalent: "l")
        view.addItem(withTitle: "Open Page in Browser", action: #selector(FactoryWindowController.openPageInBrowser(_:)), keyEquivalent: "O")
        viewItem.submenu = view
        NSApp.mainMenu = main
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
        window.title = "Viking Factory Companion"; window.isReleasedWhenClosed = false
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
        openHeimdallButton = button("Open Heimdall", #selector(openHeimdall), tip: Self.heimdallTip)
        codesButton = button("Show sign-in codes", #selector(access), tip: "Shows the Heimdall access token, the operator code that unlocks actions in Heimdall, and the Sindri pairing code for approvals. They change each time the factory starts.")
        healthButton = button("Check health", #selector(doctor), tip: "Checks that Git, Codex and Claude Code are installed and signed in, and that the factory's services answer.")
        _ = section("Everyday", "Start the factory, open it, and sign in.", [row([startStop, openHeimdallButton]), row([codesButton, healthButton])], in: root)

        // Things used rarely live behind one expander, closed by default.
        moreToggle = NSButton(title: "More options", target: self, action: #selector(toggleMore))
        moreToggle.setButtonType(.pushOnPushOff); moreToggle.bezelStyle = .disclosure; moreToggle.state = .off
        moreToggle.toolTip = "Shows the other factory pages, workers, updates and help: things you will rarely need."
        let moreLabel = NSTextField(labelWithString: "More options: pages, workers, updates and help")
        moreLabel.font = .systemFont(ofSize: 13, weight: .medium)
        let click = NSClickGestureRecognizer(target: self, action: #selector(toggleMoreFromLabel)); moreLabel.addGestureRecognizer(click)
        moreToggle.title = ""
        let moreRow = NSStackView(views: [moreToggle, moreLabel]); moreRow.orientation = .horizontal; moreRow.spacing = 6
        root.addArrangedSubview(moreRow)
        more = NSStackView(); more.orientation = .vertical; more.alignment = .leading; more.spacing = 18
        // Not in the window until expanded: a hidden subview of a stack view can still be laid out.
        moreRowRef = moreRow

        let openSindri = button("Open Sindri", #selector(openSindri), tip: "Opens Sindri, where specs and plans are approved, in the factory window.")
        let openMimir = button("Open Mimir", #selector(openMimir), tip: "Opens Mimir, the factory's memory, in the factory window.")
        let openDocs = button("Open docs", #selector(openDocs), tip: "Opens the factory's documentation in the factory window.")
        let inBrowser = NSPopUpButton(frame: .zero, pullsDown: true)
        inBrowser.addItem(withTitle: "Open in browser")
        for tab in FactoryTab.allCases { inBrowser.addItem(withTitle: tab.title); inBrowser.lastItem?.tag = tab.rawValue; inBrowser.lastItem?.toolTip = tab.summary }
        inBrowser.target = self; inBrowser.action = #selector(openInBrowser(_:))
        inBrowser.toolTip = "Opens a factory page in your default browser instead of the factory window. You sign in there separately."
        controls.append(inBrowser)
        pageButtons = [openSindri, openMimir, openDocs]
        _ = section("Pages", "Each opens as a tab of the factory window (Command-1 to Command-5 switch between them).", [row([openSindri, openMimir]), row([openDocs, inBrowser])], in: more)

        workersButton = button("Start workers", #selector(startWorkers), tip: "Starts Skidbladnir, which manages disposable worker machines. It simulates them unless you configure AWS.")
        openWorkersButton = button("Open workers", #selector(openWorkers), tip: "Opens Skidbladnir in the factory window.")
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
        // One-click copies of each sign-in code, shown after Show sign-in codes.
        codesRow = NSStackView(); codesRow.orientation = .horizontal; codesRow.spacing = 8; codesRow.distribution = .fillEqually; codesRow.isHidden = true
        for (key, title, tip) in [("heimdall", "Copy Heimdall token", "Copies the token you paste into Heimdall's sign-in page."), ("operator", "Copy operator code", "Copies the code that unlocks actions in Heimdall."), ("pairing", "Copy pairing code", "Copies the Sindri pairing code used to approve specs and plans."), ("sindri", "Copy Sindri token", "Copies the token you paste into Sindri's sign-in page (127.0.0.1:4310)."), ("mimir", "Copy Mimir token", "Copies the token you paste into Mimir's sign-in page (127.0.0.1:7700).")] {
            let b = NSButton(title: title, target: self, action: #selector(copyCode(_:)))
            b.bezelStyle = .rounded; b.font = .systemFont(ofSize: 11); b.toolTip = tip
            b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            b.identifier = NSUserInterfaceItemIdentifier(key); copyTitles[key] = title; codesRow.addArrangedSubview(b)
        }
        root.addArrangedSubview(codesRow)
        codesRow.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        root.addArrangedSubview(label("Your projects and their data stay on this Mac.", size: 11, secondary: true))
    }

    // MARK: state

    /// Enables what can work now; a disabled control's tooltip says why.
    private func applyState() {
        let s = state
        if stateKnown { factoryWindowController?.apply(s, busy: busy) }
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
        openHeimdallButton.isEnabled = s.installed
        openHeimdallButton.toolTip = s.installed ? Self.heimdallTip : "Install the factory first."
        pageButtons.forEach { $0.isEnabled = s.installed }
        codesButton.isEnabled = s.installed

        workersSection.isHidden = !(s.hasWorkers || s.hasHulder)
        workersButton.isHidden = !s.hasWorkers; openWorkersButton.isHidden = !s.hasWorkers
        workersButton.title = s.workersRunning ? "Workers running" : "Start workers"
        workersButton.isEnabled = s.hasWorkers && !s.workersRunning
        openWorkersButton.isEnabled = s.hasWorkers
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
        execute(["status"]) { ok, value, message in
            if ok, let value {
                let next = FactoryState(value)
                // Started or stopped elsewhere: the shown codes may no longer be valid.
                if next.running != self.state.running { self.codesRow.isHidden = true; self.codes = [:] }
                self.state = next; self.stateKnown = true; self.statusError = nil
            } else {
                let error = value?["error"] as? String ?? message.trimmingCharacters(in: .whitespacesAndNewlines)
                self.statusError = error.isEmpty ? "The manager did not answer." : error
                self.factoryWindowController?.statusFailed(self.statusError!)
            }
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
        if stateKnown { factoryWindowController?.apply(state, busy: true) }
        // Codes change when the factory restarts; never leave old ones one click away.
        if args != ["access"] { codesRow.isHidden = true; codes = [:] }
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
            codes = ["heimdall": value["heimdallToken"] as? String ?? "", "operator": value["operatorCode"] as? String ?? "", "pairing": value["sindriPairingCode"] as? String ?? "", "sindri": token("sindri"), "mimir": token("mimir")]
            codesRow.isHidden = false
            for case let b as NSButton in codesRow.arrangedSubviews { b.isEnabled = !(codes[b.identifier?.rawValue ?? ""] ?? "").isEmpty }
            let shown = codes.mapValues { $0.isEmpty ? "not available" : $0 }
            return "Sign-in codes. Use the Copy buttons above, or select text here and press Cmd+C.\n\n"
                + "Heimdall access token: \(shown["heimdall"]!)\n"
                + "Operator code (unlocks actions in Heimdall): \(shown["operator"]!)\n"
                + "Sindri pairing code (for approvals): \(shown["pairing"]!)\n"
                + "Sindri access token: \(shown["sindri"]!)\n"
                + "Mimir access token: \(shown["mimir"]!)\n\n"
                + "The Heimdall token, operator code and pairing code change each time the factory starts."
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
    /// The Sindri and Mimir tokens live in the installed factory's data folder (owner-only files).
    private func token(_ service: String) -> String {
        let url = factoryRoot().appendingPathComponent("data/\(service)/auth-token")
        return (try? String(contentsOf: url, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    @objc private func copyCode(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue, let code = codes[key], !code.isEmpty else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
        let title = copyTitles[key] ?? sender.title; sender.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { sender.title = title }
    }
    @objc private func access() { act(["access"], working: "Reading the sign-in codes…") }
    @objc private func doctor() { act(["doctor"], working: "Checking health…") }
    @objc private func startWorkers() { act(["start", "skidbladnir"], working: "Starting workers…") }
    private static let heimdallTip = "Opens the command center in the factory window. Sign in with the code from Show sign-in codes."
    private var factoryWindow: FactoryWindowController {
        if let existing = factoryWindowController { return existing }
        let controller = FactoryWindowController()
        controller.onStart = { [weak self] in if self?.state.running == false { self?.act(["start"], working: "Starting the factory…") } }
        controller.onStartWorkers = { [weak self] in self?.startWorkers() }
        controller.onShowCompanion = { [weak self] in self?.showWindow() }
        controller.onRefresh = { [weak self] in self?.refresh() }
        if stateKnown { controller.apply(state, busy: busy) } else if let statusError { controller.statusFailed(statusError) }
        factoryWindowController = controller
        return controller
    }
    @objc private func openFactoryWindow() { factoryWindow.present() }
    @objc private func selectFactoryTab(_ sender: NSMenuItem) { factoryWindow.present(FactoryTab(rawValue: sender.tag)) }
    @objc private func openHeimdall() { factoryWindow.present(.heimdall) }
    @objc private func openSindri() { factoryWindow.present(.sindri) }
    @objc private func openMimir() { factoryWindow.present(.mimir) }
    @objc private func openDocs() { factoryWindow.present(.docs) }
    @objc private func openWorkers() { factoryWindow.present(.skidbladnir) }
    @objc private func openInBrowser(_ sender: NSPopUpButton) {
        guard let tab = FactoryTab(rawValue: sender.selectedTag()), sender.indexOfSelectedItem > 0 else { return }
        NSWorkspace.shared.open(FactoryPorts.load().startURL(tab))
    }
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
