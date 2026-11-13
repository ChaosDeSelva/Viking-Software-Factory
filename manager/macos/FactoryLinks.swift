import Foundation

/// The factory's web pages, in the order the window's tab switcher shows them.
enum FactoryTab: Int, CaseIterable {
    case heimdall, sindri, mimir, skidbladnir, docs

    var title: String { ["Heimdall", "Sindri", "Mimir", "Skidbladnir", "Docs"][rawValue] }
    var key: String { ["heimdall", "sindri", "mimir", "skidbladnir", "docs"][rawValue] }
    var startPath: String { self == .docs ? "/docs" : "/" }
    var summary: String {
        [
            "Heimdall, the command center: projects, runs and approvals.",
            "Sindri, which plans and builds: specs, plans and reviews.",
            "Mimir, the factory's memory of projects and decisions.",
            "Skidbladnir, which manages worker machines.",
            "The factory's documentation, served by Heimdall.",
        ][rawValue]
    }
}

/// Where the manager keeps its state: VIKING_HOME, as the CLI reads it (relative to the current directory), or the default root.
func factoryRoot(environment: [String: String] = ProcessInfo.processInfo.environment, currentDirectory: String = FileManager.default.currentDirectoryPath) -> URL {
    if let home = environment["VIKING_HOME"] {
        return URL(fileURLWithPath: home, isDirectory: true, relativeTo: URL(fileURLWithPath: currentDirectory, isDirectory: true)).standardizedFileURL
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Viking Factory", isDirectory: true)
}

/// The ports the manager starts services on, from its config.json (`viking config ports`).
struct FactoryPorts: Equatable {
    var mimir = 7700, sindri = 4310, heimdall = 4320, skidbladnir = 4380

    init() {}
    init(config: [String: Any]) {
        func valid(_ key: String) -> Int? { (config[key] as? Int).flatMap { (1...65535).contains($0) ? $0 : nil } }
        mimir = valid("mimir_port") ?? mimir
        sindri = valid("sindri_port") ?? sindri
        heimdall = valid("heimdall_port") ?? heimdall
        skidbladnir = valid("skidbladnir_port") ?? skidbladnir
    }
    static func load(from root: URL = factoryRoot()) -> FactoryPorts {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("config.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return FactoryPorts() }
        return FactoryPorts(config: config)
    }

    func port(_ tab: FactoryTab) -> Int {
        switch tab {
        case .heimdall, .docs: return heimdall
        case .sindri: return sindri
        case .mimir: return mimir
        case .skidbladnir: return skidbladnir
        }
    }
    func tab(forPort port: Int) -> FactoryTab? {
        [FactoryTab.heimdall, .sindri, .mimir, .skidbladnir].first { self.port($0) == port }
    }
    func startURL(_ tab: FactoryTab) -> URL { URL(string: "http://127.0.0.1:\(port(tab))\(tab.startPath)")! }
}

/// Which links stay in the factory window and which go to the browser. Pure, so it is tested on its own.
enum FactoryLinks {
    enum Decision: Equatable {
        case allow
        case show(FactoryTab, URL)
        case browser(URL)
        case cancel
    }

    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]

    /// The port of an http(s) loopback URL served by one of the factory's services.
    static func factoryPort(of url: URL, ports: FactoryPorts) -> Int? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host?.lowercased(), loopbackHosts.contains(host),
              let port = parts.port, ports.tab(forPort: port) != nil else { return nil }
        return port
    }

    /// The tab that owns a factory page: Heimdall's port serves both Heimdall and, under /docs, the docs.
    static func tab(for url: URL, ports: FactoryPorts) -> FactoryTab? {
        guard let port = factoryPort(of: url, ports: ports), let tab = ports.tab(forPort: port) else { return nil }
        guard tab == .heimdall, let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path else { return tab }
        return path == "/docs" || path.hasPrefix("/docs/") ? .docs : .heimdall
    }

    static func decide(_ url: URL?, mainFrame: Bool, in tab: FactoryTab, ports: FactoryPorts) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return mainFrame ? .cancel : .allow }
        switch scheme {
        case "about", "data", "blob", "javascript":
            return .allow
        case "file":
            return .cancel
        case "http", "https":
            if let target = self.tab(for: url, ports: ports) {
                if !mainFrame || target == tab { return .allow }
                return .show(target, url)
            }
            // Embedded content may come from elsewhere; leaving the factory goes to the browser.
            return mainFrame ? .browser(url) : .allow
        default:
            return mainFrame ? .browser(url) : .cancel
        }
    }

    /// A page of the tab without its port (the host is kept, since cookies are scoped to it), so a port change keeps the place.
    static func location(of url: URL, in tab: FactoryTab, ports: FactoryPorts) -> String? {
        guard self.tab(for: url, ports: ports) == tab,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.port = nil; parts.user = nil; parts.password = nil
        if parts.percentEncodedPath.isEmpty { parts.percentEncodedPath = "/" }
        return parts.string
    }

    static func restore(_ location: String?, in tab: FactoryTab, ports: FactoryPorts) -> URL {
        guard var text = location else { return ports.startURL(tab) }
        // Locations saved before hosts were kept are paths on 127.0.0.1.
        if text.hasPrefix("/") && !text.hasPrefix("//") { text = "http://127.0.0.1" + text }
        guard var parts = URLComponents(string: text), parts.port == nil, parts.user == nil, parts.password == nil else { return ports.startURL(tab) }
        parts.port = ports.port(tab)
        guard let url = parts.url, self.tab(for: url, ports: ports) == tab else { return ports.startURL(tab) }
        return url
    }
}

/// A file name in `folder` that is not taken yet: "report.pdf", then "report 2.pdf", and so on.
func uniqueDownloadURL(in folder: URL, suggested: String, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
    var name = (suggested as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty || name == "." || name == ".." || name == "/" { name = "download" }
    let stem = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var candidate = folder.appendingPathComponent(name)
    var n = 2
    while exists(candidate) {
        candidate = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
        n += 1
    }
    return candidate
}
