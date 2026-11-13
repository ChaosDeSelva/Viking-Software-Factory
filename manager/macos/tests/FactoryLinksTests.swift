import Foundation

// Built and run by scripts/build-app.sh together with FactoryLinks.swift; exits non-zero on failure.
@main
struct FactoryLinksTests {
    static var failures = 0

    static func check<T: Equatable>(_ actual: T, _ expected: T, _ name: String, line: Int = #line) {
        if actual != expected { failures += 1; print("FAIL line \(line) \(name): got \(actual), expected \(expected)") }
    }

    static func main() {
        let ports = FactoryPorts()
        func decide(_ text: String, main: Bool = true, in tab: FactoryTab = .heimdall) -> FactoryLinks.Decision {
            FactoryLinks.decide(URL(string: text), mainFrame: main, in: tab, ports: ports)
        }
        let u = { (text: String) in URL(string: text)! }

        check(decide("http://127.0.0.1:4320/"), .allow, "same service")
        check(decide("http://127.0.0.1:4320/?project=abc123"), .allow, "deep link")
        check(decide("http://localhost:4320/runs"), .allow, "localhost")
        check(decide("http://[::1]:4320/runs"), .allow, "IPv6 loopback")
        check(decide("http://127.0.0.1:4320/docs/setup", in: .docs), .allow, "docs page in docs tab")
        check(decide("http://127.0.0.1:4320/", in: .docs), .show(.heimdall, u("http://127.0.0.1:4320/")), "Heimdall page from docs switches tab")
        check(decide("http://127.0.0.1:4320/docs", in: .heimdall), .show(.docs, u("http://127.0.0.1:4320/docs")), "docs link from Heimdall switches tab")
        check(decide("http://127.0.0.1:4320/docsearch", in: .heimdall), .allow, "docs prefix needs a path boundary")
        check(decide("http://127.0.0.1:4320/docs", main: false, in: .heimdall), .allow, "docs subframe stays")
        check(decide("http://127.0.0.1:4310/#/reviews?project=a"), .show(.sindri, u("http://127.0.0.1:4310/#/reviews?project=a")), "other service switches tab")
        check(decide("http://127.0.0.1:4380/"), .show(.skidbladnir, u("http://127.0.0.1:4380/")), "workers")
        check(decide("http://127.0.0.1:7700/", main: false), .allow, "subframe on another service")
        check(decide("https://github.com/x/y"), .browser(u("https://github.com/x/y")), "external")
        check(decide("http://127.0.0.1:9999/"), .browser(u("http://127.0.0.1:9999/")), "unmanaged local port")
        check(decide("http://127.0.0.1/"), .browser(u("http://127.0.0.1/")), "no port")
        check(decide("http://192.168.1.5:4320/"), .browser(u("http://192.168.1.5:4320/")), "LAN host is external")
        check(decide("http://127.0.0.1.example.com:4320/"), .browser(u("http://127.0.0.1.example.com:4320/")), "lookalike host")
        check(decide("https://www.youtube.com/embed/x", main: false), .allow, "external subframe")
        check(decide("mailto:someone@example.com"), .browser(u("mailto:someone@example.com")), "mailto")
        check(decide("file:///etc/passwd"), .cancel, "file")
        check(decide("about:blank"), .allow, "about")
        check(FactoryLinks.decide(nil, mainFrame: true, in: .heimdall, ports: ports), .cancel, "no URL")

        var custom = FactoryPorts(config: ["heimdall_port": 44320, "sindri_port": 44310, "mimir_port": 0])
        check(custom.heimdall, 44320, "configured port")
        check(custom.mimir, 7700, "invalid port falls back")
        check(FactoryLinks.decide(u("http://127.0.0.1:4320/"), mainFrame: true, in: .heimdall, ports: custom), .browser(u("http://127.0.0.1:4320/")), "default port is not managed when reconfigured")
        custom.skidbladnir = 44380
        check(custom.tab(forPort: 44380), .skidbladnir, "tab for port")

        check(FactoryLinks.location(of: u("http://127.0.0.1:4320/?project=p1#top"), in: .heimdall, ports: ports), "http://127.0.0.1/?project=p1#top", "location")
        check(FactoryLinks.location(of: u("http://127.0.0.1:4320"), in: .heimdall, ports: ports), "http://127.0.0.1/", "empty path")
        check(FactoryLinks.location(of: u("http://localhost:4320/runs"), in: .heimdall, ports: ports), "http://localhost/runs", "host kept")
        check(FactoryLinks.location(of: u("http://127.0.0.1:4320/docs/setup"), in: .heimdall, ports: ports), nil, "docs not saved as Heimdall")
        check(FactoryLinks.location(of: u("http://127.0.0.1:4320/docs/setup"), in: .docs, ports: ports), "http://127.0.0.1/docs/setup", "docs location")
        check(FactoryLinks.location(of: u("http://127.0.0.1:4320/runs"), in: .docs, ports: ports), nil, "Heimdall page not saved as docs")
        check(FactoryLinks.location(of: u("http://127.0.0.1:4310/"), in: .heimdall, ports: ports), nil, "other service not remembered")
        check(FactoryLinks.location(of: u("https://example.com/"), in: .heimdall, ports: ports), nil, "external not remembered")
        check(FactoryLinks.restore("/?project=p1", in: .heimdall, ports: ports), u("http://127.0.0.1:4320/?project=p1"), "restore legacy path")
        check(FactoryLinks.restore("http://localhost/runs?x=1#y", in: .heimdall, ports: ports), u("http://localhost:4320/runs?x=1#y"), "restore with host")
        check(FactoryLinks.restore("http://[::1]/runs", in: .heimdall, ports: ports), u("http://[::1]:4320/runs"), "restore IPv6")
        check(FactoryLinks.restore("http://evil.example/", in: .heimdall, ports: ports), u("http://127.0.0.1:4320/"), "external host rejected")
        check(FactoryLinks.restore("http://127.0.0.1:9999/", in: .heimdall, ports: ports), u("http://127.0.0.1:4320/"), "saved port rejected")
        check(FactoryLinks.restore("http://127.0.0.1/runs", in: .docs, ports: ports), u("http://127.0.0.1:4320/docs"), "non-docs page rejected for docs")
        check(FactoryLinks.restore("http://localhost/docs/a", in: .docs, ports: ports), u("http://localhost:4320/docs/a"), "docs restore")
        check(FactoryLinks.restore("/?project=p1", in: .heimdall, ports: custom), u("http://127.0.0.1:44320/?project=p1"), "restore after port change")
        check(FactoryLinks.restore(nil, in: .docs, ports: ports), u("http://127.0.0.1:4320/docs"), "docs start")
        check(FactoryLinks.restore("//evil.example/", in: .heimdall, ports: ports), u("http://127.0.0.1:4320/"), "protocol-relative rejected")
        check(FactoryLinks.restore("@evil.example/", in: .heimdall, ports: ports), u("http://127.0.0.1:4320/"), "userinfo trick rejected")

        check(factoryRoot(environment: ["VIKING_HOME": "/srv/vf"], currentDirectory: "/tmp").path, "/srv/vf", "absolute VIKING_HOME")
        check(factoryRoot(environment: ["VIKING_HOME": "state/vf"], currentDirectory: "/work").path, "/work/state/vf", "relative VIKING_HOME")
        check(factoryRoot(environment: ["VIKING_HOME": "../vf"], currentDirectory: "/work/a").path, "/work/vf", "relative parent VIKING_HOME")
        check(factoryRoot(environment: [:], currentDirectory: "/work").path.hasSuffix("/Library/Application Support/Viking Factory"), true, "default root")

        let downloads = URL(fileURLWithPath: "/Users/x/Downloads")
        let taken: Set<String> = ["report.pdf", "report 2.pdf", "notes"]
        let exists = { (url: URL) in taken.contains(url.lastPathComponent) }
        check(uniqueDownloadURL(in: downloads, suggested: "plan.txt", exists: exists).path, "/Users/x/Downloads/plan.txt", "free name")
        check(uniqueDownloadURL(in: downloads, suggested: "report.pdf", exists: exists).path, "/Users/x/Downloads/report 3.pdf", "numbered name")
        check(uniqueDownloadURL(in: downloads, suggested: "notes", exists: exists).path, "/Users/x/Downloads/notes 2", "no extension")
        check(uniqueDownloadURL(in: downloads, suggested: "../../etc/passwd", exists: exists).path, "/Users/x/Downloads/passwd", "no traversal")
        check(uniqueDownloadURL(in: downloads, suggested: "", exists: exists).path, "/Users/x/Downloads/download", "empty name")
        check(uniqueDownloadURL(in: downloads, suggested: "a:b.txt", exists: exists).path, "/Users/x/Downloads/a-b.txt", "colon")

        if failures > 0 { print("\(failures) factory link test(s) failed"); exit(1) }
        print("Factory link tests passed")
    }
}
