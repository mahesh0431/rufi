import QuickLook
import SwiftUI

/// The place shown and the pages on top of it, around Rufi's screens, with
/// the sidebar under them to go to another place. The web view moves to the
/// screen on top; a screen below shows a still of itself, taken as it was
/// covered, so Back and the edge swipe show it at once; when it is on top
/// again, the page is opened there.
@Observable
final class Shell {
    enum State: Equatable {
        case opening
        case open
        case problem(String)
    }

    /// Whether Rufi can be reached: a pill over the box says when it can't,
    /// and "Connected" for a moment when it can again.
    enum Reach: Equatable {
        case reachable, away, back
    }

    let pairing: Pairing
    let screens: Screens
    /// Dose logs not on the Mac yet: Today's and the reminders'.
    let outbox: Outbox
    /// Sends the dose logs waiting, then brings the reminders in line.
    private let refresh: () -> Void
    let door: Door
    let theme: Theme
    /// The person's chat: its transcript, stream and box.
    let chat: ChatModel
    /// The chat is open over the page on top, as a sheet.
    var chatShown = false
    /// The web page on top has a chat box: the bar shows under it.
    private(set) var webBox = false
    private let unpaired: () -> Void

    var state = State.opening
    /// The home indicator's area under the pages, which the bars at the
    /// bottom float into (`floating`).
    var indicator: CGFloat = 0
    private(set) var reach = Reach.reachable {
        didSet { chat.away = away }
    }
    var away: Bool { reach == .away }
    /// Messages sent while Rufi couldn't be reached.
    let pending: Pending
    /// The web view holds a page that drew: when Rufi comes back, the page
    /// reads again; without one, Rufi opens again.
    private var live = false
    /// Counts the runs of asking again, after a wait that grows, while Rufi
    /// can't be reached: only the latest run goes on.
    private var tries = 0
    private var checking = false
    /// Where the person is: what the sidebar marks, the title and Back.
    private(set) var navigator: Navigator
    /// The page is slid aside, showing the sidebar.
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
    /// Goes up when the pages drawn here should read again: Rufi is back.
    private(set) var fresh = 0
    /// The last read of each page drawn here, by its route, while Rufi is
    /// open: shown at once when the page opens again, and while Rufi can't
    /// be reached. Only in memory.
    @ObservationIgnored var kept: [String: any Sendable] = [:]
    /// Today's reads, which may overlap: only the newest answer is applied.
    @ObservationIgnored let todayReads = NewestRead()

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

    init(pairing: Pairing, key: String, theme: Theme, pending: Pending, outbox: Outbox, seen: @escaping () -> Bool,
         refresh: @escaping () -> Void, unpaired: @escaping () -> Void) {
        self.pairing = pairing
        self.outbox = outbox
        self.refresh = refresh
        self.theme = theme
        self.pending = pending
        self.seen = seen
        self.door = Door(origin: pairing.origin, key: key)
        self.unpaired = unpaired
        chat = ChatModel(door: door, person: pairing.person.id, pending: pending)
        screens = Screens(origin: pairing.origin)
        let navigator = Navigator(person: pairing.person.id, at: .chat)
        self.navigator = navigator
        holder = navigator.root.id
        screens.onGo = { [weak self] path, chat in Task { await self?.go(path, chat: chat) } }
        screens.onPage = { [weak self] path, title, box in
            self?.webBox = box != nil
            self?.drawn(path, title)
        }
        screens.onEnded = { [weak self] in Task { await self?.reopen() } }
        screens.onUnreachable = { [weak self] in
            self?.live = false
            self?.lost()
        }
        screens.onConnection = { [weak self] reachable in
            guard let self else { return }
            if !reachable { self.lost() } else if self.away { Task { await self.reached() } }
        }
        screens.onRefresh = refresh
        chat.lost = { [weak self] in self?.lost() }
        chat.reached = { [weak self] in
            guard let self, self.away else { return }
            Task { await self.reached() }
        }
        chat.unpaired = unpaired
        chat.changed = { [weak self] change in
            guard let self else { return }
            // The pages drawn here read again; the reminders follow the
            // dose log and the record.
            fresh += 1
            if change != .documents { refresh() }
        }
        screens.onOriginal = { [weak self] document, files in Task { await self?.show(document, files) } }
        screens.onBriefPDF = { [weak self] brief in Task { await self?.showBrief(brief) } }
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

    /// The page `screen` shows when the iPhone draws it.
    func native(_ screen: Screen) -> NativePage? {
        navigator.page(screen).flatMap { NativePage.of($0.path, person: pairing.person.id) }
    }

    /// The person's page at `rest`: "documents/doc-1".
    func path(_ rest: String) -> String {
        "/people/\(pairing.person.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pairing.person.id)/\(rest)"
    }

    /// The chat's own page is on top.
    var onChat: Bool { native(navigator.top) == .chat }

    /// A page drawn here named itself: the title shows it.
    func titled(_ screen: Screen, _ title: String) {
        guard let page = navigator.page(screen), page.title != title else { return }
        navigator.drawn(screen.id, page.path, title)
    }

    /// Reads `path` under the person's routes for a page drawn here. Out of
    /// reach, the line shows and Rufi asks again; reached again, the pages
    /// read again.
    func read<Answer: Decodable>(_ path: String, query: [String: String] = [:]) async throws(Door.Problem) -> Answer {
        do {
            let answer: Answer = try await door.read(path, for: pairing.person.id, query: query)
            // Apart from the page's read: reaching Rufi reads the pages
            // again, which ends the read that asked.
            if away { Task { await reached() } }
            return answer
        } catch {
            // A read stopped because its page went isn't Rufi out of reach.
            if error == .unreachable, !Task.isCancelled { lost() }
            if error == .unpaired { unpaired() }
            throw error
        }
    }

    /// Posts for a page drawn here: a delete. Out of reach or unpaired, as a read.
    func post<Answer: Decodable>(_ path: String, body: [String: String]) async throws(Door.Problem) -> Answer {
        do {
            return try await door.post(path, for: pairing.person.id, body: body)
        } catch {
            if error == .unreachable { lost() }
            if error == .unpaired { unpaired() }
            throw error
        }
    }

    /// A document's page as an image, for its page drawn here.
    func page(of document: String, at position: Int) async throws(Door.Problem) -> Data {
        do {
            return try await door.page(person: pairing.person.id, document: document, position: position)
        } catch {
            if error == .unreachable, !Task.isCancelled { lost() }
            if error == .unpaired { unpaired() }
            throw error
        }
    }

    /// Whether the page on top is Medicines' own, which has the bell, a row
    /// of it open or not.
    var onMedicines: Bool {
        navigator.stack.isEmpty && navigator.current == .medicines
    }

    /// Opens Rufi's screens at the holder's page with a new launch link. Out
    /// of reach, what shows stays, and Rufi asks again.
    func reopen() async {
        guard !reopening else { return }
        reopening = true
        defer { reopening = false }
        do {
            // Behind a page drawn here, Help: it holds no chat, and keeps the theme.
            let held = navigator.page(at: holder)?.path
            let page = held.flatMap { NativePage.of($0, person: pairing.person.id) } == nil ? held : nil
            let url = try await door.open(page ?? Place.help.path(pairing.person.id))
            state = .opening
            covered = true
            live = false
            screens.load(url)
            state = .open
            connected()
            await chat.deliver()
        } catch .unreachable {
            lost()
        } catch .unpaired {
            unpaired()
        } catch .mismatch {
            state = .problem("Update Rufi on your iPhone (or on your Mac) so they match.")
        } catch let .refused(words) {
            state = .problem(words)
        } catch {
            lost()
        }
    }

    /// Asks whether Rufi can be reached: when it can, the page reads again
    /// (or Rufi opens again) and the waiting messages go.
    func check() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            _ = try await door.me()
        } catch .unreachable {
            lost()
            return
        } catch .unpaired {
            unpaired()
            return
        } catch {
            // Rufi answered: opening it says what is wrong.
        }
        await reached()
    }

    /// Rufi can't be reached: the line shows, and Rufi asks again after 2,
    /// 5, 10 and 20 seconds, then every 30, while it is on screen.
    private func lost() {
        guard reach != .away else { return }
        reach = .away
        tries += 1
        let these = tries
        // Never cancelled: a check it runs that reaches Rufi must finish.
        // It stops when Rufi answers, or when another run starts.
        Task { [weak self] in
            var waits = [2, 5, 10, 20]
            while true {
                try? await Task.sleep(for: .seconds(waits.isEmpty ? 30 : waits.removeFirst()))
                guard let self, tries == these, away else { return }
                if seen() { await check() }
            }
        }
    }

    /// Rufi answered: the line says so a moment, then goes.
    private func connected() {
        tries += 1
        guard reach == .away else { return }
        reach = .back
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if reach == .back { reach = .reachable }
        }
    }

    private func reached() async {
        let page = live
        connected()
        fresh += 1
        // Dose logs made meanwhile go now.
        refresh()
        chat.reconnect()
        if page {
            screens.reconnect()
            await chat.deliver()
        } else {
            await reopen()
        }
        await count()
    }

    /// Taken, Skipped or Undo on Today: kept in the outbox first, as a
    /// reminder's are, then sent; the reminders follow. Out of reach, it
    /// waits there, Pending. Why it couldn't be kept, in a few words.
    func log(_ state: UnsentLog.State, medicine: RecordRow, doseAt: String) async -> String? {
        // As the Mac takes an instant: "2026-11-02T15:32:00.000Z".
        let instant = ISO8601DateFormatter()
        instant.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = instant.string(from: .now)
        let log = UnsentLog(id: UUID().uuidString.lowercased(), made: .init(pairing), medicine: medicine.id,
                            label: [medicine.name, medicine.strength].compactMap { $0 }.joined(separator: " "),
                            doseAt: doseAt, state: state, loggedAt: now, takenAt: state == .taken ? now : nil)
        do {
            try outbox.add([log])
        } catch {
            return "Rufi couldn't keep that. Try again."
        }
        do {
            try await outbox.send(to: pairing, door.log)
        } catch {
            unpaired()
        }
        refresh()
        return nil
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
        do throws(Door.Problem) {
            let answer = try await door.add(person: pairing.person.id, files: files, together: together)
            guard let added = try? JSONDecoder().decode(Added.self, from: answer) else { throw Door.Problem.mismatch }
            chat.added(added)
            fresh += 1
            // Added from a page (Documents): the chat opens over it, with their chips.
            if !onChat { chatShown = true }
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

    /// From a page drawn here: chips, and text after what is typed, go in
    /// the chat's box, as Ask Rufi does on the Mac's pages, and the chat
    /// opens over the page. When the box can't take them now, its line says why.
    func ask(_ chips: [Chip], text: String = "") async {
        chat.append(text, chips)
        if !onChat { chatShown = true }
    }

    /// A link in the chat to a page of the person's: it opens on top. From
    /// the chat over a page, the chat closes first, and Back opens it again.
    func follow(_ path: String, fromSheet: Bool) async {
        if fromSheet { chatShown = false }
        await go(path, chat: fromSheet)
    }

    /// View original: fetches the document's files with the key and shows
    /// them in Quick Look.
    func show(_ document: String, _ files: [(id: String, name: String)]) async {
        await present { copies in
            for file in files {
                let fetched = try await door.file(person: pairing.person.id, document: document, file: file.id,
                                                  into: Originals.shown.staging)
                copies.append(try Originals.shown.keep(fetched, named: file.name))
            }
        }
    }

    /// View PDF: the visit brief's PDF, made by Rufi on the Mac, shown like
    /// an original, with its share button; deleted on close.
    func showBrief(_ brief: String) async {
        await present { copies in
            let fetched = try await door.briefPDF(person: pairing.person.id, brief: brief, into: Originals.shown.staging)
            copies.append(try Originals.shown.keep(fetched.file, named: fetched.name))
        }
    }

    /// Fetches copies to show in Quick Look, one fetch at a time; on a
    /// problem, none is kept and the problem shows.
    private func present(_ fetch: (inout [URL]) async throws -> Void) async {
        guard !fetching, originals.isEmpty else { return }
        fetching = true
        defer { fetching = false }
        var copies: [URL] = []
        do {
            try await fetch(&copies)
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
        await show(navigator.go(path, chat: chat))
    }

    /// A place chosen in the sidebar: the sidebar closes on its page.
    func choose(_ place: Place) async {
        sidebar = false
        await keepStill()
        await show(navigator.choose(place))
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
        // Its chat was open over it when a link in the chat covered it.
        if navigator.page(top)?.chat == true, !onChat { chatShown = true }
        if top.id != holder, native(top) == nil { Task { await hold(top) } }
    }

    /// A screen to show: a page drawn here needs nothing more; any other
    /// takes the web view.
    private func show(_ screen: Screen) async {
        if native(screen) == nil { await hold(screen) }
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
        // Help, kept behind a page drawn here, isn't that page.
        if let page = navigator.page(at: holder), NativePage.of(page.path, person: pairing.person.id) == nil {
            navigator.drawn(holder, path, title)
        }
        live = true
        covered = false
        state = .open
        if let place = wanted {
            wanted = nil
            Task { await go(place.path(pairing.person.id)) }
        }
    }
}

/// The stack of Rufi's pages with Apple's bars, and the sidebar under it.
struct ShellView: View {
    @Bindable var shell: Shell
    @State private var settings = false
    @State private var reminding = false
    let app: AppModel

    var body: some View {
        Drawer(open: $shell.sidebar, enabled: shell.navigator.stack.isEmpty, side: shell.theme.side) {
            NavigationStack(path: stack) {
                page(shell.navigator.root, root: true)
                    .navigationDestination(for: Screen.self) { page($0, root: false) }
            }
            // Another place: a stack of its own.
            .id(shell.navigator.root.id)
            // A bar, so the page scrolls under it in glass, as under the title.
            .safeAreaBar(edge: .bottom, spacing: 0) {
                // A page drawn here has its own bar (`page`); a web page
                // with a chat box, this one.
                if shell.native(shell.navigator.top) == nil, shell.webBox, shell.state == .open {
                    VStack(spacing: 8) {
                        ReachPill(shell: shell)
                        AskBar(name: shell.pairing.person.name, theme: shell.theme) { shell.chatShown = true }
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
                                shell.screens.box(top: $0)
                            }
                            .onDisappear { shell.screens.box(top: nil) }
                    }
                    .floating(shell)
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
        .background {
            Color.clear.ignoresSafeArea(.keyboard)
                .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { shell.indicator = $0 }
        }
        .sheet(isPresented: $shell.chatShown) {
            NavigationStack {
                ChatView(shell: shell, chat: shell.chat, sheet: true)
                    .navigationTitle(Place.chat.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Open as Page", systemImage: "arrow.up.left.and.arrow.down.right") {
                                shell.chatShown = false
                                Task { await shell.choose(.chat) }
                            }
                        }
                    }
            }
            .presentationDragIndicator(.visible)
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
        .onChange(of: app.active) { _, active in
            // Back on screen: is Rufi still there, or back? The chat's
            // stream runs while Rufi is on screen.
            if active {
                shell.chat.open()
                Task { await shell.check() }
            } else {
                shell.chat.close()
            }
        }
        .task {
            shell.chat.open()
            await shell.reopen()
            await shell.count()
        }
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

    @ViewBuilder
    private func page(_ screen: Screen, root: Bool) -> some View {
        ScreenView(shell: shell, screen: screen)
            // On the page itself, so its last row scrolls above the bar.
            .safeAreaBar(edge: .bottom, spacing: 0) {
                if let page = shell.native(screen) {
                    // The chat's own page has its box, and the pill over it.
                    if page != .chat {
                        VStack(spacing: 8) {
                            ReachPill(shell: shell)
                            AskBar(name: shell.pairing.person.name, theme: shell.theme) { shell.chatShown = true }
                        }
                        .floating(shell)
                    }
                } else if !shell.webBox || shell.state != .open {
                    // A web page with no box: the pill alone.
                    ReachPill(shell: shell).floating(shell)
                }
            }
            .navigationTitle(shell.title(screen))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if root {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Show Sidebar", systemImage: "sidebar.left") { shell.sidebar = true }
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

/// One screen: the web view when it is on top, else a still of itself; with
/// neither while Rufi can't be reached, the dog, resting.
struct ScreenView: View {
    let shell: Shell
    let screen: Screen

    var body: some View {
        if let page = shell.native(screen) {
            NativePageView(shell: shell, screen: screen, page: page)
        } else {
            web
        }
    }

    private var web: some View {
        ZStack {
            shell.theme.page.ignoresSafeArea(.container)
            switch shell.state {
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
                        if shell.away {
                            Image("Resting").resizable().scaledToFit().frame(width: 72)
                                .accessibilityLabel("Rufi, resting")
                        } else if shell.state == .opening {
                            ProgressView()
                        }
                    }
                }
            }
        }
    }
}

/// A pill over the box while Rufi can't be reached: it asks again by
/// itself, and a tap asks at once. When it can, "Connected" for a moment.
struct ReachPill: View {
    let shell: Shell

    var body: some View {
        Group {
            switch shell.reach {
            case .away:
                Button {
                    Task { await shell.check() }
                } label: {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Can't reach Rufi")
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
                .accessibilityHint("Tries again now")
            case .back:
                Label("Connected", systemImage: "checkmark")
                    .foregroundStyle(.green)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassEffect(in: .capsule)
            case .reachable:
                EmptyView()
            }
        }
        .font(.footnote)
        .animation(.snappy, value: shell.reach)
    }
}

extension View {
    /// A bar at the bottom of the screen, floating as the iPhone's own tab
    /// bar does: into the home indicator's area, 21 points over the screen's
    /// edge (as Apple's Health app has it); with the keyboard up, just over
    /// it. The page still ends at the bar's top, so its last row shows whole.
    func floating(_ shell: Shell, keyboard: Bool = false) -> some View {
        padding(.bottom, keyboard ? 6 : -max(0, shell.indicator - 21))
    }
}
