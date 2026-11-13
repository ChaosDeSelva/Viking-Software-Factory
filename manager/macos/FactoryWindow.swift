import AppKit
import WebKit

/// Shown instead of a page when its service is not running or did not answer.
final class FactoryPlaceholderView: NSView {
    private let image = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let button = NSButton(title: "", target: nil, action: nil)
    private var handler: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        image.symbolConfiguration = .init(pointSize: 40, weight: .light)
        image.contentTintColor = .secondaryLabelColor
        title.font = .systemFont(ofSize: 17, weight: .semibold); title.alignment = .center
        message.font = .systemFont(ofSize: 13); message.textColor = .secondaryLabelColor; message.alignment = .center
        message.preferredMaxLayoutWidth = 420
        button.bezelStyle = .rounded; button.controlSize = .large; button.target = self; button.action = #selector(pressed)
        let stack = NSStackView(views: [image, title, message, button])
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 10
        stack.setCustomSpacing(16, after: message)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
        ])
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    struct Action { var title: String; var tip: String; var enabled = true; var run: () -> Void }

    func configure(symbol: String, title: String, message: String, action: Action?) {
        image.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        self.title.stringValue = title
        self.message.stringValue = message
        button.isHidden = action == nil
        button.title = action?.title ?? ""
        button.toolTip = action?.tip
        button.isEnabled = action?.enabled ?? false
        button.keyEquivalent = action?.enabled == true ? "\r" : ""
        handler = action?.run
    }
    @objc private func pressed() { handler?() }
}

/// A strip along the bottom of the window reporting a finished or failed download.
final class FactoryNoticeView: NSVisualEffectView {
    private let text = NSTextField(labelWithString: "")
    private let reveal = NSButton(title: "Show in Finder", target: nil, action: nil)
    private var file: URL?
    private var hide: DispatchWorkItem?

    override init(frame: NSRect) {
        super.init(frame: frame)
        material = .headerView; blendingMode = .withinWindow
        text.lineBreakMode = .byTruncatingMiddle; text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        reveal.bezelStyle = .rounded; reveal.controlSize = .small; reveal.target = self; reveal.action = #selector(showInFinder)
        reveal.toolTip = "Shows the downloaded file in Finder."
        let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss")!, target: self, action: #selector(dismiss))
        close.isBordered = false; close.toolTip = "Hides this message."
        let stack = NSStackView(views: [text, reveal, close]); stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor), heightAnchor.constraint(equalToConstant: 34),
        ])
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ message: String, file: URL?) {
        text.stringValue = message; self.file = file; reveal.isHidden = file == nil; isHidden = false
        hide?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.isHidden = true }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }
    @objc private func showInFinder() { if let file { NSWorkspace.shared.activateFileViewerSelecting([file]) } }
    @objc private func dismiss() { hide?.cancel(); isHidden = true }
}

/// One window with a tab per factory web page. Each page keeps its web view, and so its state, once opened.
final class FactoryWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var onStart: () -> Void = {}
    var onStartWorkers: () -> Void = {}
    var onShowCompanion: () -> Void = {}
    var onRefresh: () -> Void = {}

    private final class Page {
        let webView: WKWebView
        var loaded = false
        var failure: String?
        var lastCrash: Date?
        var observations: [NSKeyValueObservation] = []
        init(_ webView: WKWebView) { self.webView = webView }
    }

    private static let tabKey = "FactoryWindow.tab"
    private static func locationKey(_ tab: FactoryTab) -> String { "FactoryWindow.location.\(tab.key)" }

    private(set) var ports = FactoryPorts.load()
    private var state: FactoryState?
    private var statusError: String?
    private var busy = false
    private var current: FactoryTab
    private var pages: [FactoryTab: Page] = [:]
    private var pending: [FactoryTab: URL] = [:]
    private var popups: [NSWindow] = []
    private var downloads: [ObjectIdentifier: URL] = [:]
    private let container = NSView()
    private let placeholder = FactoryPlaceholderView()
    private let notice = FactoryNoticeView()
    private let tabs = NSSegmentedControl(labels: FactoryTab.allCases.map(\.title), trackingMode: .selectOne, target: nil, action: nil)
    private var items: [NSToolbarItem.Identifier: NSToolbarItem] = [:]

    private enum Item {
        static let back = NSToolbarItem.Identifier("back"), forward = NSToolbarItem.Identifier("forward")
        static let tabs = NSToolbarItem.Identifier("tabs"), reload = NSToolbarItem.Identifier("reload")
        static let browser = NSToolbarItem.Identifier("browser")
    }

    init() {
        current = FactoryTab(rawValue: UserDefaults.standard.integer(forKey: Self.tabKey)) ?? .heimdall
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
        window.title = "Viking Factory"; window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false; window.minSize = NSSize(width: 760, height: 480)
        window.tabbingMode = .disallowed
        super.init(window: window)
        window.delegate = self

        tabs.target = self; tabs.action = #selector(tabChosen(_:))
        tabs.setAccessibilityLabel("Factory page")
        for tab in FactoryTab.allCases {
            tabs.setToolTip("\(tab.summary) (Command-\(tab.rawValue + 1))", forSegment: tab.rawValue)
        }
        let toolbar = NSToolbar(identifier: "FactoryWindow")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
        toolbar.centeredItemIdentifiers = [Item.tabs]
        window.toolbar = toolbar; window.toolbarStyle = .unified

        window.contentView = container
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(placeholder)
        pin(placeholder)
        notice.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(notice, positioned: .above, relativeTo: placeholder)
        NSLayoutConstraint.activate([
            notice.leadingAnchor.constraint(equalTo: container.leadingAnchor), notice.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            notice.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        if !window.setFrameUsingName("FactoryWindow") { window.center() }
        window.setFrameAutosaveName("FactoryWindow")
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    private func pin(_ view: NSView) {
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor), view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor), view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }

    // MARK: showing pages

    /// Brings the window forward on a tab (or the last one used), optionally at a specific page of it.
    func present(_ tab: FactoryTab? = nil, url: URL? = nil) {
        if let tab { current = tab; UserDefaults.standard.set(tab.rawValue, forKey: Self.tabKey) }
        if let url { pending[current] = url; pages[current]?.loaded = false; pages[current]?.failure = nil }
        // While a factory window is open the app behaves like a normal app, in the Dock and Command-Tab.
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
            NSApp.applicationIconImage = Self.icon
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        update()
        if let webView = visibleWebView { window?.makeFirstResponder(webView) }
    }

    /// The companion's latest view of the factory; pages reload when their service comes back.
    func apply(_ next: FactoryState, busy: Bool) {
        let previous = state
        state = next; statusError = nil; self.busy = busy
        let latest = FactoryPorts.load()
        let portsChanged = latest != ports
        ports = latest
        for (tab, page) in pages where portsChanged || (available(tab, next) && !(previous.map { available(tab, $0) } ?? false)) {
            page.loaded = false; page.failure = nil
        }
        if window?.isVisible == true { update() }
    }

    /// The manager could not report status. Before the first answer this replaces "Checking the factory…".
    func statusFailed(_ message: String) {
        statusError = message
        if window?.isVisible == true { update() }
    }

    private func available(_ tab: FactoryTab, _ s: FactoryState) -> Bool {
        tab == .skidbladnir ? s.hasWorkers && s.workersRunning : s.healthy
    }

    private func update() {
        tabs.selectedSegment = current.rawValue
        let name = current.title
        var showing: Page?
        if let s = state, available(current, s) {
            let page = page(for: current)
            if let failure = page.failure {
                placeholder.configure(symbol: "exclamationmark.triangle", title: "\(name) didn't answer", message: failure,
                                      action: .init(title: "Retry", tip: "Tries to load \(name) again.") { [weak self] in self?.retry() })
            } else {
                if !page.loaded { load(page, current) }
                showing = page
            }
        } else {
            configureUnavailable(name)
        }
        for (tab, page) in pages { page.webView.isHidden = page !== showing || tab != current }
        placeholder.isHidden = showing != nil
        refreshToolbar()
    }

    private func configureUnavailable(_ name: String) {
        let companion = FactoryPlaceholderView.Action(title: "Show companion", tip: "Opens the companion window, where the factory is installed and updated.") { [weak self] in self?.onShowCompanion() }
        guard let s = state else {
            if let statusError {
                placeholder.configure(symbol: "exclamationmark.triangle", title: "Couldn't read the factory's status", message: statusError + "\n\nThis is retried every 30 seconds.",
                                      action: .init(title: "Retry", tip: "Asks the manager for the factory's status now.", enabled: !busy) { [weak self] in self?.onRefresh() })
            } else {
                placeholder.configure(symbol: "hourglass", title: "Checking the factory…", message: "This takes a moment.", action: nil)
            }
            return
        }
        if s.pendingRecovery {
            placeholder.configure(symbol: "exclamationmark.triangle", title: "An update was interrupted", message: "Finish or undo it in the companion window before opening \(name).", action: companion)
        } else if !s.installed {
            placeholder.configure(symbol: "shippingbox", title: "The factory isn't installed", message: "Install it from the companion window, then start it.", action: companion)
        } else if current == .skidbladnir {
            if !s.hasWorkers {
                placeholder.configure(symbol: "server.rack", title: "Workers aren't installed", message: "Skidbladnir is optional. Reinstall the factory bundle with it selected to use workers.", action: companion)
            } else {
                placeholder.configure(symbol: "server.rack", title: "Workers are stopped", message: "Start Skidbladnir to manage worker machines. It simulates them unless you configure AWS.",
                                      action: .init(title: busy ? "Working…" : "Start workers", tip: "Starts Skidbladnir as a background service.", enabled: !busy) { [weak self] in self?.onStartWorkers() })
            }
        } else if s.loaded {
            placeholder.configure(symbol: "stethoscope", title: "The factory isn't answering yet", message: "It is starting or unhealthy. If this lasts, run Check health in the companion window.",
                                  action: .init(title: "Check again", tip: "Asks the manager for the factory's status now.", enabled: !busy) { [weak self] in self?.onRefresh() })
        } else {
            placeholder.configure(symbol: "power", title: "The factory is stopped", message: "Start it to open \(name). Sindri, Mimir and Heimdall run in the background until you stop them.",
                                  action: .init(title: busy ? "Working…" : "Start factory", tip: "Starts Sindri, Mimir and Heimdall as background services.", enabled: !busy) { [weak self] in self?.onStart() })
        }
    }

    private func configure(_ webView: WKWebView) {
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true; webView.allowsMagnification = true
        #if DEBUG
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif
    }

    private func page(for tab: FactoryTab) -> Page {
        if let page = pages[tab] { return page }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        configure(webView)
        webView.setAccessibilityLabel(tab.title)
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView, positioned: .below, relativeTo: placeholder)
        pin(webView)
        let page = Page(webView)
        page.observations = [
            webView.observe(\.url) { [weak self] view, _ in MainActor.assumeIsolated { self?.remember(view, tab) } },
            webView.observe(\.canGoBack) { [weak self] _, _ in MainActor.assumeIsolated { self?.refreshToolbar() } },
            webView.observe(\.canGoForward) { [weak self] _, _ in MainActor.assumeIsolated { self?.refreshToolbar() } },
        ]
        pages[tab] = page
        return page
    }

    private func load(_ page: Page, _ tab: FactoryTab) {
        page.loaded = true; page.failure = nil
        let url = pending.removeValue(forKey: tab) ?? FactoryLinks.restore(UserDefaults.standard.string(forKey: Self.locationKey(tab)), in: tab, ports: ports)
        page.webView.load(URLRequest(url: url))
    }

    private func remember(_ webView: WKWebView, _ tab: FactoryTab) {
        guard let url = webView.url, let location = FactoryLinks.location(of: url, in: tab, ports: ports) else { return }
        UserDefaults.standard.set(location, forKey: Self.locationKey(tab))
    }

    private func retry() {
        guard let page = pages[current] else { return }
        page.loaded = false; page.failure = nil
        update()
    }

    /// The tab a web view belongs to; nil for popup windows.
    private func pageTab(of webView: WKWebView) -> FactoryTab? {
        pages.first { $0.value.webView === webView }?.key
    }

    /// The page on screen, if the current tab is showing one rather than a placeholder.
    private var visibleWebView: WKWebView? {
        guard let page = pages[current], !page.webView.isHidden else { return nil }
        return page.webView
    }

    private func route(_ decision: FactoryLinks.Decision) -> WKNavigationActionPolicy {
        switch decision {
        case .allow: return .allow
        case .show(let tab, let url): DispatchQueue.main.async { self.present(tab, url: url) }
        case .browser(let url): NSWorkspace.shared.open(url)
        case .cancel: break
        }
        return .cancel
    }

    // MARK: windows and the Dock

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        popups.removeAll { $0 === closing }
        DispatchQueue.main.async { self.leaveDockIfDone() }
    }

    private func leaveDockIfDone() {
        let mainOpen = window.map { $0.isVisible || $0.isMiniaturized } ?? false
        if !mainOpen && popups.isEmpty && NSApp.activationPolicy() == .regular { NSApp.setActivationPolicy(.accessory) }
    }

    /// A drawn "V", matching the menu bar item, since the bundle carries no icon file.
    private static let icon: NSImage = NSImage(size: NSSize(width: 512, height: 512), flipped: false) { rect in
        let tile = NSBezierPath(roundedRect: rect.insetBy(dx: 50, dy: 50), xRadius: 92, yRadius: 92)
        NSGradient(starting: NSColor(calibratedRed: 0.16, green: 0.29, blue: 0.47, alpha: 1), ending: NSColor(calibratedRed: 0.07, green: 0.12, blue: 0.22, alpha: 1))?.draw(in: tile, angle: -90)
        let text = NSAttributedString(string: "V", attributes: [.font: NSFont.systemFont(ofSize: 280, weight: .heavy), .foregroundColor: NSColor.white])
        let size = text.size()
        text.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
        return true
    }

    // MARK: toolbar and menu actions

    @objc private func tabChosen(_ sender: NSSegmentedControl) {
        guard let tab = FactoryTab(rawValue: sender.selectedSegment) else { return }
        present(tab)
    }
    @objc func factoryBack(_ sender: Any?) { visibleWebView?.goBack() }
    @objc func factoryForward(_ sender: Any?) { visibleWebView?.goForward() }
    @objc func factoryReload(_ sender: Any?) {
        if let webView = visibleWebView { webView.reload() } else { retry(); onRefresh() }
    }
    @objc func openPageInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(visibleWebView?.url ?? ports.startURL(current))
    }
    @objc func copyPageAddress(_ sender: Any?) {
        guard let url = visibleWebView?.url else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(factoryBack(_:)): return visibleWebView?.canGoBack == true
        case #selector(factoryForward(_:)): return visibleWebView?.canGoForward == true
        case #selector(copyPageAddress(_:)): return visibleWebView?.url != nil
        default: return true
        }
    }

    private func refreshToolbar() {
        let web = visibleWebView
        items[Item.back]?.isEnabled = web?.canGoBack == true
        items[Item.forward]?.isEnabled = web?.canGoForward == true
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Item.back, Item.forward, .flexibleSpace, Item.tabs, .flexibleSpace, Item.reload, Item.browser]
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        func button(_ label: String, _ symbol: String, _ action: Selector, _ tip: String) {
            item.label = label; item.paletteLabel = label; item.toolTip = tip
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            item.isBordered = true; item.target = self; item.action = action; item.autovalidates = false
        }
        switch id {
        case Item.back: button("Back", "chevron.backward", #selector(factoryBack(_:)), "Goes back to the previous page in this tab (Command-[)."); item.isNavigational = true
        case Item.forward: button("Forward", "chevron.forward", #selector(factoryForward(_:)), "Goes forward again in this tab (Command-])."); item.isNavigational = true
        case Item.reload: button("Reload", "arrow.clockwise", #selector(factoryReload(_:)), "Reloads this page, or checks the factory again if it isn't showing (Command-R).")
        case Item.browser: button("Open in Browser", "safari", #selector(openPageInBrowser(_:)), "Opens this page in your default browser. You may need to sign in there separately (Shift-Command-O).")
        case Item.tabs:
            item.label = "Page"; item.paletteLabel = "Page"; item.toolTip = "Switches between the factory's pages."
            item.view = tabs
        default: return nil
        }
        items[id] = item
        return item
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        let decision = FactoryLinks.decide(navigationAction.request.url, mainFrame: navigationAction.targetFrame?.isMainFrame ?? true, in: pageTab(of: webView) ?? current, ports: ports)
        decisionHandler(route(decision))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = disposition.lowercased().hasPrefix("attachment") || (navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType)
        decisionHandler(download ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }

    private func failed(_ webView: WKWebView, _ error: Error) {
        let e = error as NSError
        // Cancelled loads and loads replaced by a policy decision (including downloads) are not failures.
        if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        guard let tab = pageTab(of: webView), let page = pages[tab] else { return }
        let unreachable = e.domain == NSURLErrorDomain && [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotFindHost].contains(e.code)
        page.failure = unreachable ? "Nothing answered at \(ports.startURL(tab).host ?? "127.0.0.1"):\(ports.port(tab)). The service may have stopped." : e.localizedDescription
        if tab == current { update() }
        onRefresh()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let tab = pageTab(of: webView), let page = pages[tab] else {
            popups.first { $0.contentView === webView }?.close(); return
        }
        // Reload once; a second crash within 30 seconds waits for the person to retry.
        if let last = page.lastCrash, Date().timeIntervalSince(last) < 30 {
            page.failure = "The page stopped unexpectedly twice in a row."
            if tab == current { update() }
        } else {
            page.lastCrash = Date()
            webView.reload()
        }
    }

    // MARK: downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        guard let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { completionHandler(nil); return }
        let destination = uniqueDownloadURL(in: folder, suggested: suggestedFilename)
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        notice.show("Downloaded \(file.lastPathComponent) to Downloads.", file: file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let file = downloads.removeValue(forKey: ObjectIdentifier(download))
        notice.show("Couldn't download \(file?.lastPathComponent ?? "the file"): \(error.localizedDescription)", file: nil)
    }

    // MARK: new windows and page dialogs

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        let scheme = url.flatMap { $0.absoluteString.isEmpty ? nil : $0.scheme?.lowercased() } ?? "about"
        if scheme == "javascript" { return nil }
        // Content the page builds itself (about:blank, blob:, data:) needs a real window it can script and close.
        if ["about", "blob", "data"].contains(scheme) { return popup(configuration, windowFeatures) }
        let decision = FactoryLinks.decide(url, mainFrame: true, in: pageTab(of: webView) ?? current, ports: ports)
        if case .allow = decision, let url { webView.load(URLRequest(url: url)) } else { _ = route(decision) }
        return nil
    }

    private func popup(_ configuration: WKWebViewConfiguration, _ features: WKWindowFeatures) -> WKWebView {
        let size = NSSize(width: features.width.map { CGFloat($0.doubleValue) } ?? 640, height: features.height.map { CGFloat($0.doubleValue) } ?? 480)
        let webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        configure(webView)
        let popup = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        popup.title = "Viking Factory"; popup.isReleasedWhenClosed = false; popup.delegate = self
        popup.contentView = webView
        if let parent = window { popup.setFrameTopLeftPoint(NSPoint(x: parent.frame.minX + 60, y: parent.frame.maxY - 60)) } else { popup.center() }
        popups.append(popup)
        popup.makeKeyAndOrderFront(nil)
        return webView
    }

    func webViewDidClose(_ webView: WKWebView) {
        popups.first { $0.contentView === webView }?.close()
    }

    private func sheetWindow(for webView: WKWebView) -> NSWindow? { webView.window ?? window }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK")
        guard let host = sheetWindow(for: webView) else { completionHandler(); return }
        alert.beginSheetModal(for: host) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        guard let host = sheetWindow(for: webView) else { completionHandler(false); return }
        alert.beginSheetModal(for: host) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        guard let host = sheetWindow(for: webView) else { completionHandler(nil); return }
        alert.layout()
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: host) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
        alert.window.makeFirstResponder(field)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        guard let host = sheetWindow(for: webView) else { completionHandler(nil); return }
        panel.beginSheetModal(for: host) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}
