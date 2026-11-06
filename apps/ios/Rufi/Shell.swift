import QuickLook
import SwiftUI

/// The place shown and the pages on top of it, around Rufi's screens, with
/// the sidebar to go to another place. The web view moves to the screen on
/// top; a screen below shows a still of itself, taken as it was covered, so
/// Back and the edge swipe show it at once; when it is on top again, the
/// page is opened there.
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
    let theme: Theme
    /// The chat's box, drawn here; the page keeps its rules.
    let box = ChatBox()
    private let unpaired: () -> Void

    var state = State.opening
    /// Where the person is: what the sidebar marks, the title and Back.
    private(set) var navigator: Navigator
    /// The sidebar is open over the page.
    var sidebar = false {
        didSet { if sidebar, !oldValue { Task { await count() } } }
    }
    /// The sidebar's counts, as last read.
    private(set) var counts: Door.Counts?
    private(set) var stills: [Screen.ID: UIImage] = [:]
    /// The screen holding the web view.
    private(set) var holder: Screen.ID
    /// The holder's page hasn't drawn yet: its still, or a blank page, covers it.
    private(set) var covered = true
    private var reopening = false
    /// A place to show once the first page has drawn: a notice tapped as Rufi opened.
    private var wanted: Place?

    /// The document camera is up.
    var scanning = false
    /// Files from the box are being added.
    private(set) var adding = false
    /// Why files from the box couldn't be added, in one line.
    var addProblem: String?

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

    init(pairing: Pairing, key: String, theme: Theme, seen: @escaping () -> Bool, refresh: @escaping () -> Void,
         unpaired: @escaping () -> Void) {
        self.pairing = pairing
        self.theme = theme
        self.seen = seen
        self.door = Door(origin: pairing.origin, key: key)
        self.unpaired = unpaired
        screens = Screens(origin: pairing.origin)
        let navigator = Navigator(person: pairing.person.id, at: .chat)
        self.navigator = navigator
        holder = navigator.root.id
        screens.onGo = { [weak self] path, chat in Task { await self?.go(path, chat: chat) } }
        screens.onPage = { [weak self] path, title, box in
            self?.box.kind = box
            self?.drawn(path, title)
        }
        screens.onBox = { [weak self] data in self?.box.took(data) }
        screens.onEnded = { [weak self] in Task { await self?.reopen() } }
        screens.onUnreachable = { [weak self] in self?.state = .unreachable }
        screens.onRefresh = refresh
        box.asking = { [weak screens] command in screens?.box(command) }
        screens.onOriginal = { [weak self] document, files in Task { await self?.show(document, files) } }
        screens.view.backgroundColor = theme.pageColour
        screens.onTheme = { [weak self] colours, dark in
            guard let self else { return }
            self.theme.took(colours, dark: dark)
            screens.view.backgroundColor = self.theme.pageColour
        }
    }

    func title(_ screen: Screen) -> String {
        navigator.page(screen)?.title ?? ""
    }

    func still(_ screen: Screen) -> UIImage? {
        stills[screen.id]
    }

    /// Whether the page on top is Medicines' own, which has the bell, a row
    /// of it open or not.
    var onMedicines: Bool {
        navigator.stack.isEmpty && navigator.current == .medicines
    }

    /// Opens Rufi's screens at the holder's page with a new launch link.
    func reopen() async {
        guard !reopening else { return }
        reopening = true
        defer { reopening = false }
        state = .opening
        covered = true
        box.reset()
        do {
            let url = try await door.open(navigator.page(at: holder)?.path ?? Place.chat.path(pairing.person.id))
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

    /// Reads the sidebar's counts; when they can't be read, the last stay.
    func count() async {
        if let counts = try? await door.counts(for: pairing.person.id) { self.counts = counts }
    }

    /// Camera, in the box's paperclip: the document camera, where the iPhone has one.
    func scan() {
        guard !adding else { return }
        if DocumentCamera.available {
            scanning = true
        } else {
            addProblem = "This iPhone can't scan documents. Add a photo from Photos instead."
        }
    }

    /// The camera's pages: added together as one document.
    func scanned(_ scan: DocumentCamera.Scan) async {
        scanning = false
        switch scan {
        case .cancelled: return
        case .failed: addProblem = "The camera couldn't take that scan. Scan it again."
        case let .pages(pages):
            await attach(pages.enumerated().map { index, page in
                Door.Upload(name: "Scan page \(index + 1).jpg", type: "image/jpeg", data: page)
            }, together: true)
        }
    }

    /// Files from the box's paperclip: added with the key, as one document or
    /// each its own, and their chips go in the box. They are only in memory
    /// meanwhile.
    func attach(_ files: [Door.Upload], together: Bool) async {
        guard !adding, !files.isEmpty else { return }
        adding = true
        defer { adding = false }
        do {
            screens.added(try await door.add(person: pairing.person.id, files: files, together: together))
        } catch .unpaired {
            unpaired()
        } catch .unreachable {
            addProblem = "Can't reach your Mac. Add them again when it's awake and Rufi is open."
        } catch let .refused(words) {
            addProblem = words
        } catch {
            addProblem = "Update Rufi on your iPhone (or on your Mac) so they match."
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

    /// The person tapped a link to `path` in the page, or in the chat open
    /// over it (`chat`), which opens again on Back.
    func go(_ path: String, chat: Bool = false) async {
        await keepStill()
        await hold(navigator.go(path, chat: chat))
    }

    /// A place chosen in the sidebar: the sidebar closes on its page.
    func choose(_ place: Place) async {
        sidebar = false
        await keepStill()
        await hold(navigator.choose(place))
    }

    /// Shows `place` at its page: a notice was tapped. When Rufi is still
    /// opening, once its first page has drawn.
    func show(_ place: Place) async {
        if state == .open, !covered { await go(place.path(pairing.person.id)) } else { wanted = place }
    }

    /// The stack changed: Back, or the edge swipe, finished. The stack
    /// follows at once; the page on top takes the web view.
    func popped(to stack: [Screen]) {
        navigator.popped(to: stack)
        let top = navigator.top
        if top.id != holder { Task { await hold(top) } }
    }

    private func keepStill() async {
        if !covered, let image = await screens.snapshot() { stills[holder] = image }
    }

    private func hold(_ screen: Screen) async {
        let kept = Set(navigator.screens.map(\.id))
        stills = stills.filter { kept.contains($0.key) }
        holder = screen.id
        guard let path = navigator.page(screen)?.path else { return }
        // The same page stays as it is, its chat closed or opened as it was.
        covered = screens.path != path
        screens.open(path, chat: navigator.page(screen)?.chat ?? false)
    }

    private func drawn(_ path: String, _ title: String) {
        navigator.drawn(holder, path, title)
        covered = false
        state = .open
        if let place = wanted {
            wanted = nil
            Task { await go(place.path(pairing.person.id)) }
        }
    }
}

/// The stack of Rufi's pages with Apple's bars, and the sidebar over it.
struct ShellView: View {
    @Bindable var shell: Shell
    @State private var settings = false
    @State private var reminding = false
    let app: AppModel

    var body: some View {
        Drawer(open: $shell.sidebar, enabled: shell.navigator.stack.isEmpty) {
            NavigationStack(path: stack) {
                first(shell.navigator.place)
                    .navigationDestination(for: Screen.self) { page($0, root: false) }
            }
            // Another place: a stack of its own.
            .id(shell.navigator.root.id)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if boxShown {
                    ChatBoxView(box: shell.box, shell: shell)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
                            shell.screens.box(top: $0)
                        }
                        .onDisappear { shell.screens.box(top: nil) }
                }
            }
        } sidebar: {
            SidebarView(name: shell.pairing.person.name, current: shell.navigator.current,
                        counts: shell.counts, theme: shell.theme) { place in
                Task { await shell.choose(place) }
            } thisIPhone: {
                shell.sidebar = false
                settings = true
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
        .alert("Rufi Couldn't Add That", isPresented: addProblemShown) {
            Button("OK") {}
        } message: {
            Text(shell.addProblem ?? "")
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
        .task {
            await shell.reopen()
            await shell.count()
        }
    }

    /// The page on top has a chat box, and the page has told it.
    private var boxShown: Bool {
        shell.state == .open && shell.box.kind != nil && shell.box.state != nil
    }

    private var addProblemShown: Binding<Bool> {
        Binding { shell.addProblem != nil } set: { if !$0 { shell.addProblem = nil } }
    }

    private var problemShown: Binding<Bool> {
        Binding { shell.originalProblem != nil } set: { if !$0 { shell.originalProblem = nil } }
    }

    private var stack: Binding<[Screen]> {
        Binding {
            shell.navigator.stack
        } set: { screens in
            shell.popped(to: screens)
        }
    }

    /// What a place shows at the bottom of its stack: Rufi's page for it
    /// from the Mac. A place that gets a screen of the app's own returns it
    /// here. That screen also needs the bar items, which are `page`'s
    /// toolbar today, and the shell must then leave the web view where it
    /// is (`hold` moves it to every place); a screen of its own on top
    /// needs a kind of screen besides a page's address.
    @ViewBuilder
    private func first(_ place: Place) -> some View {
        page(shell.navigator.root, root: true)
    }

    @ViewBuilder
    private func page(_ screen: Screen, root: Bool) -> some View {
        ScreenView(shell: shell, screen: screen, until: app.reminders?.until, unsent: app.outbox.logs.count)
            .navigationTitle(shell.title(screen))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if root {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            shell.sidebar = true
                        } label: {
                            Initials(name: shell.pairing.person.name, size: 32)
                        }
                        .accessibilityLabel("Show Sidebar")
                    }
                }
                if root, shell.onMedicines {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Reminders", systemImage: "bell") { reminding = true }
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
    /// Dose logs not on the Mac yet.
    let unsent: Int

    var body: some View {
        ZStack {
            shell.theme.page.ignoresSafeArea(.container)
            switch shell.state {
            case .unreachable:
                CantReachView(until: until, unsent: unsent) { Task { await shell.reopen() } }
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
                        shell.theme.page.ignoresSafeArea(.container)
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
    let unsent: Int
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Can't Reach Your Mac", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        } description: {
            Text("Check Rufi is open there and the Mac is awake, and Tailscale is on, on both.")
            if let until {
                Text("Reminders set on this iPhone until \(until.reminderWords).")
            }
            if unsent > 0 { Text(UnsentSection.count(unsent)) }
        } actions: {
            Button("Try Again", systemImage: "arrow.clockwise", action: retry)
                .buttonStyle(.borderedProminent)
        }
    }
}
