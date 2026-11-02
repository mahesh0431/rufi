import QuickLook
import SwiftUI

/// One page in a tab's stack. Its address and title can change as the page
/// says (a page that leads elsewhere).
struct Screen: Hashable, Identifiable {
    let id = UUID()
}

/// The tab bar and each tab's stack of screens, around Rufi's screens. The
/// web view moves to the screen on top; a screen below shows a still of
/// itself, taken as it was covered, so Back and the edge swipe show it at
/// once; when it is on top again, the page is opened there.
@Observable
final class Shell {
    enum State: Equatable {
        case opening
        case open
        case unreachable
        case problem(String)
    }

    let pairing: Pairing
    let screens: Screens
    let door: Door
    private let unpaired: () -> Void

    var state = State.opening
    var tab = Tab.chat {
        didSet { if tab != oldValue { Task { await moved(from: oldValue) } } }
    }
    /// Each tab's pushed screens, above its first page.
    var stacks: [Tab: [Screen]] = [:]
    let roots: [Tab: Screen] = Dictionary(uniqueKeysWithValues: Tab.allCases.map { ($0, Screen()) })
    /// Each screen's address and title.
    private(set) var pages: [Screen.ID: (path: String, title: String)] = [:]
    private(set) var stills: [Screen.ID: UIImage] = [:]
    /// The screen holding the web view.
    private(set) var holder: Screen.ID
    /// The holder's page hasn't drawn yet: its still, or a blank page, covers it.
    private(set) var covered = true
    private var reopening = false
    /// A tab to show once the first page has drawn: a notice tapped as Rufi opened.
    private var wanted: Tab?

    /// The document camera is up.
    var scanning = false
    /// Scanned pages are being added.
    private(set) var adding = false
    /// Why a scan couldn't be added, in one line.
    var scanProblem: String?

    /// The copies of the original Quick Look shows, and the one on screen;
    /// closing it deletes them.
    private(set) var originals: [URL] = []
    var original: URL? {
        didSet {
            if original == nil, !originals.isEmpty {
                Originals.shown.delete(originals)
                originals = []
            }
        }
    }
    /// An original is being fetched.
    private(set) var fetching = false
    /// Fetched while Rufi was hidden or locked: it shows once Rufi is seen again.
    private var waiting = false
    /// Rufi is on screen and unlocked.
    private let seen: () -> Bool
    /// Why the original couldn't be shown, in one line.
    var originalProblem: String?

    init(pairing: Pairing, key: String, seen: @escaping () -> Bool, refresh: @escaping () -> Void,
         unpaired: @escaping () -> Void) {
        self.pairing = pairing
        self.seen = seen
        self.door = Door(origin: pairing.origin, key: key)
        self.unpaired = unpaired
        screens = Screens(origin: pairing.origin)
        holder = UUID()
        holder = roots[.chat]!.id
        for tab in Tab.allCases {
            pages[roots[tab]!.id] = (tab.root(pairing.person.id), tab.title)
        }
        screens.onGo = { [weak self] path in Task { await self?.go(path) } }
        screens.onPage = { [weak self] path, title in self?.drawn(path, title) }
        screens.onEnded = { [weak self] in Task { await self?.reopen() } }
        screens.onUnreachable = { [weak self] in self?.state = .unreachable }
        screens.onRefresh = refresh
        screens.onScan = { [weak self] in self?.scan() }
        screens.onOriginal = { [weak self] document, files in Task { await self?.show(document, files) } }
    }

    /// The screen on top in `tab`.
    func top(_ tab: Tab) -> Screen {
        stacks[tab]?.last ?? roots[tab]!
    }

    func title(_ screen: Screen) -> String {
        if let tab = Tab.allCases.first(where: { roots[$0] == screen }) { return tab.title }
        return pages[screen.id]?.title ?? ""
    }

    func still(_ screen: Screen) -> UIImage? {
        stills[screen.id]
    }

    /// Opens Rufi's screens at the holder's page with a new launch link.
    func reopen() async {
        guard !reopening else { return }
        reopening = true
        defer { reopening = false }
        state = .opening
        covered = true
        do {
            let url = try await door.open(pages[holder]?.path ?? Tab.chat.root(pairing.person.id))
            screens.load(url)
            state = .open
        } catch .unreachable {
            state = .unreachable
        } catch .unpaired {
            unpaired()
        } catch .mismatch {
            state = .problem("Update Rufi on your iPhone (or on your Mac) so they match.")
        } catch let .refused(words) {
            state = .problem(words)
        } catch {
            state = .unreachable
        }
    }

    /// Scan: the document camera, where the iPhone has one.
    func scan() {
        guard !adding else { return }
        if DocumentCamera.available {
            scanning = true
        } else {
            scanProblem = "This iPhone can't scan documents. Add a photo with the paperclip instead."
        }
    }

    /// The camera's pages: added with the key, together as one document, and
    /// their chip goes in the chat box. They are only in memory meanwhile.
    func scanned(_ scan: DocumentCamera.Scan) async {
        scanning = false
        let pages: [Data]
        switch scan {
        case .cancelled: return
        case .failed:
            scanProblem = "The camera couldn't take that scan. Scan it again."
            return
        case let .pages(taken): pages = taken
        }
        adding = true
        defer { adding = false }
        do {
            screens.added(try await door.add(person: pairing.person.id, pages: pages))
        } catch .unpaired {
            unpaired()
        } catch .unreachable {
            scanProblem = "Can't reach your Mac. Scan again when it's awake and Rufi is open."
        } catch let .refused(words) {
            scanProblem = words
        } catch {
            scanProblem = "Update Rufi on your iPhone (or on your Mac) so they match."
        }
    }

    /// View original: fetches the document's files with the key and shows
    /// them in Quick Look.
    func show(_ document: String, _ files: [(id: String, name: String)]) async {
        guard !fetching, originals.isEmpty else { return }
        fetching = true
        defer { fetching = false }
        var copies: [URL] = []
        do {
            for file in files {
                let fetched = try await door.file(person: pairing.person.id, document: document, file: file.id,
                                                  into: Originals.shown.staging)
                copies.append(try Originals.shown.keep(fetched, named: file.name))
            }
        } catch {
            Originals.shown.delete(copies)
            switch error as? Door.Problem {
            case .unpaired: unpaired()
            case .unreachable: originalProblem = "Can't reach your Mac. Try again when it's awake and Rufi is open."
            case let .refused(words): originalProblem = words
            case .codeExpired, .mismatch: originalProblem = "Update Rufi on your iPhone (or on your Mac) so they match."
            case nil: originalProblem = "Rufi couldn't keep a copy to show. Try again."
            }
            return
        }
        originals = copies
        if seen() { original = copies.first } else { waiting = true }
    }

    /// Rufi is on screen and unlocked again: an original fetched meanwhile shows.
    func appeared() {
        guard waiting else { return }
        waiting = false
        original = originals.first
    }

    /// The person tapped a link to `path` in the page.
    func go(_ path: String) async {
        switch Route.of(path, person: pairing.person.id) {
        case let .tab(tab):
            await keepStill()
            stacks[tab] = []
            if self.tab == tab { await hold(top(tab)) } else { self.tab = tab }
        case let .push(path):
            await keepStill()
            let screen = Screen()
            pages[screen.id] = (path, "")
            stacks[tab, default: []].append(screen)
            await hold(screen)
        }
    }

    /// Shows `tab` at its first page: a notice was tapped. When Rufi is still
    /// opening, once its first page has drawn.
    func show(_ tab: Tab) async {
        if state == .open, !covered { await go(tab.root(pairing.person.id)) } else { wanted = tab }
    }

    /// A tab's stack changed: Back, or the edge swipe, finished.
    func popped() async {
        let top = top(tab)
        if top.id != holder { await hold(top) }
    }

    /// The tab changed: its top screen takes the web view.
    private func moved(from: Tab) async {
        await keepStill()
        await hold(top(tab))
    }

    private func keepStill() async {
        if !covered, let image = await screens.snapshot() { stills[holder] = image }
    }

    private func hold(_ screen: Screen) async {
        let kept = Set(Tab.allCases.flatMap { [roots[$0]!] + (stacks[$0] ?? []) }.map(\.id))
        stills = stills.filter { kept.contains($0.key) }
        holder = screen.id
        guard let path = pages[screen.id]?.path else { return }
        covered = screens.path != path
        if covered { screens.open(path) }
    }

    private func drawn(_ path: String, _ title: String) {
        pages[holder] = (path, title)
        covered = false
        state = .open
        if let tab = wanted {
            wanted = nil
            Task { await go(tab.root(pairing.person.id)) }
        }
    }
}

/// The tabs, each a stack of Rufi's pages with Apple's bars.
struct ShellView: View {
    @Bindable var shell: Shell
    @State private var settings = false
    @State private var reminding = false
    let app: AppModel

    var body: some View {
        TabView(selection: $shell.tab) {
            ForEach(Tab.allCases, id: \.self) { tab in
                SwiftUI.Tab(tab.label, systemImage: tab.symbol, value: tab) {
                    NavigationStack(path: stack(tab)) {
                        page(shell.roots[tab]!, root: true)
                            .navigationDestination(for: Screen.self) { page($0, root: false) }
                    }
                }
            }
        }
        .sheet(isPresented: $settings) {
            ThisIPhoneView(app: app, pairing: shell.pairing)
        }
        .sheet(isPresented: $reminding) {
            RemindersView(door: shell.door, person: shell.pairing.person.id, reminders: app.reminders)
        }
        .fullScreenCover(isPresented: $shell.scanning) {
            DocumentCamera { scan in Task { await shell.scanned(scan) } }
                .ignoresSafeArea()
        }
        .alert("Rufi Couldn't Add the Scan", isPresented: scanProblemShown) {
            Button("OK") {}
        } message: {
            Text(shell.scanProblem ?? "")
        }
        .quickLookPreview($shell.original, in: shell.originals)
        .overlay {
            if shell.fetching || shell.adding { ProgressView().controlSize(.large).padding(24).glassEffect() }
        }
        .alert("Rufi Couldn't Open the Original", isPresented: problemShown) {
            Button("OK") {}
        } message: {
            Text(shell.originalProblem ?? "")
        }
        .onChange(of: app.seen) { _, seen in
            if seen { shell.appeared() }
        }
        .task { await shell.reopen() }
    }

    private var scanProblemShown: Binding<Bool> {
        Binding { shell.scanProblem != nil } set: { if !$0 { shell.scanProblem = nil } }
    }

    private var problemShown: Binding<Bool> {
        Binding { shell.originalProblem != nil } set: { if !$0 { shell.originalProblem = nil } }
    }

    private func stack(_ tab: Tab) -> Binding<[Screen]> {
        Binding {
            shell.stacks[tab] ?? []
        } set: { screens in
            shell.stacks[tab] = screens
            Task { await shell.popped() }
        }
    }

    @ViewBuilder
    private func page(_ screen: Screen, root: Bool) -> some View {
        ScreenView(shell: shell, screen: screen, until: app.reminders?.until)
            .navigationTitle(shell.title(screen))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if root, screen == shell.roots[.medicines] {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Reminders", systemImage: "bell") { reminding = true }
                    }
                }
                if root {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            settings = true
                        } label: {
                            Image("Dog").resizable().scaledToFit().frame(width: 30, height: 30).clipShape(.circle)
                        }
                        .accessibilityLabel("This iPhone")
                    }
                }
            }
    }
}

/// One screen: the web view when it is on top, else a still of itself.
struct ScreenView: View {
    let shell: Shell
    let screen: Screen
    /// Until when reminders are set on this iPhone.
    let until: Date?

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea(.container)
            switch shell.state {
            case .unreachable:
                CantReachView(until: until) { Task { await shell.reopen() } }
            case let .problem(words):
                ContentUnavailableView("Rufi Can't Open", systemImage: "exclamationmark.triangle", description: Text(words))
            case .opening, .open:
                if shell.holder == screen.id {
                    WebSlot(screens: shell.screens).ignoresSafeArea(.container)
                }
                if shell.holder != screen.id || shell.covered {
                    if let still = shell.still(screen) {
                        Image(uiImage: still).resizable().ignoresSafeArea(.container)
                    } else {
                        Color(.systemBackground).ignoresSafeArea(.container)
                        if shell.state == .opening { ProgressView() }
                    }
                }
            }
        }
    }
}

/// Rufi can't reach the Mac: the chrome stays, with Try Again, and until
/// when the reminders already here ring.
struct CantReachView: View {
    let until: Date?
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Can't Reach Your Mac", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        } description: {
            Text("Check Rufi is open there and the Mac is awake, and Tailscale is on, on both.")
            if let until {
                Text("Reminders set on this iPhone until \(until.reminderWords).")
            }
        } actions: {
            Button("Try Again", systemImage: "arrow.clockwise", action: retry)
                .buttonStyle(.borderedProminent)
        }
    }
}
