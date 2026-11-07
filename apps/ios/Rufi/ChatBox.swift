import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The chat's box, drawn by the app. Its rules stay in the page (the draft
/// and its saves, the send, the chips, Ask Rufi, Stop, the model): the page
/// tells the box as it is (`took`), and the box asks the page for what the
/// person does (`ask`). apps/web/src/phone-box.tsx is the other side.
@Observable
final class ChatBox {
    /// Which box the page on top has: the chat page's, or a reading page's,
    /// where a tap opens the chat over the page.
    enum Kind: String {
        case page, bar
    }

    /// The box as the page last told it.
    struct State: Decodable, Equatable {
        struct Chip: Decodable, Equatable, Identifiable {
            let key: String
            let label: String
            let kind: String
            var id: String { key }
        }

        struct Choice: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
        }

        struct Model: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
            let available: Bool
        }

        struct Meter: Decodable, Equatable {
            let used: Int
            let words: String
        }

        let text: String?
        let placeholder: String
        let chips: [Chip]
        let ready: Bool
        let button: String
        let canSend: Bool
        let model: Choice
        let effort: Choice
        let models: [Model]
        let signIn: [String]
        let efforts: [Choice]
        let effortWords: String
        let meter: Meter?
        let line: String?
        let retry: Bool
        let closed: String?
        let asked: Int
        let panel: Bool
    }

    /// The page on top's box; none when it has none.
    var kind: Kind?
    private(set) var state: State?
    /// What is in the box now: typed here, or as the page last changed it.
    private(set) var text = ""
    /// Asks the page (`window.rufi.box`).
    var asking: ([String: Any]) -> Void = { _ in }
    /// Rufi can't be reached: Send keeps the message on the iPhone.
    var away = false
    /// Typed while Rufi couldn't be reached: these words, not the draft the
    /// page reads when it is back, stay in the box.
    private var typedAway = false

    /// The page told the box as it is. Its text only when the page changed
    /// it, so it never undoes typing.
    func took(_ data: Data) {
        guard let state = try? JSONDecoder().decode(State.self, from: data) else { return }
        if let text = state.text {
            if typedAway, !self.text.isEmpty {
                ask(["type": "text", "text": self.text])
            } else {
                self.text = text
            }
            typedAway = false
        }
        self.state = state
    }

    /// The person typed.
    func typed(_ text: String) {
        guard text != self.text else { return }
        self.text = text
        if away { typedAway = true }
        ask(["type": "text", "text": text])
    }

    func ask(_ command: [String: Any]) {
        asking(command)
    }

    /// One line, or open with its options: open while in use, or while
    /// something is in it.
    func open(focused: Bool) -> Bool {
        focused || !text.isEmpty || !(state?.chips.isEmpty ?? true)
    }

    /// The page opened again: until it tells, the box waits.
    func reset() {
        state = nil
    }
}

/// The box at the bottom of the screen: one line at rest, the text line and
/// its options while in use, and under it on the chat, a reminder.
struct ChatBoxView: View {
    let box: ChatBox
    let shell: Shell
    @Environment(Theme.self) private var theme
    @FocusState private var focused: Bool
    @State private var lit = false
    @State private var meter = false
    @State private var photos = false
    @State private var files = false
    @State private var picked: [PhotosPickerItem] = []
    /// Two or more photos, waiting to be added as one document or each its own.
    @State private var grouping: [Door.Upload] = []

    var body: some View {
        let state = box.state
        let open = box.open(focused: focused)
        let away = box.away
        let kind = shell.boxKind
        VStack(spacing: 4) {
            ForEach(shell.pending.messages) { PendingRow(message: $0) }
            if !away, let line = state?.line {
                HStack(spacing: 8) {
                    Text(line)
                    if state?.retry == true {
                        Button("Retry", systemImage: "arrow.clockwise") { box.ask(["type": "retry"]) }
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let chips = state?.chips, !chips.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(chips) { chip in
                                ChipView(chip: chip, removable: state?.ready == true) {
                                    box.ask(["type": "remove", "key": chip.key])
                                }
                            }
                        }
                        .padding(.top, 6)
                    }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(state?.placeholder ?? "Ask or tell Rufi about \(shell.pairing.person.name)…",
                              text: Binding { box.text } set: { box.typed($0) }, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($focused)
                        .disabled(!away && state?.ready != true)
                        .padding(.vertical, 8)
                        .accessibilityLabel("Message to Rufi")
                    if !open || away { send(state) }
                }
                // What needs Rufi waits until it can be reached.
                if open, !away, let state {
                    HStack(spacing: 2) {
                        attach(state)
                        model(state)
                        Spacer(minLength: 4)
                        if let used = state.meter { meter(used) }
                        send(state)
                    }
                    .padding(.bottom, 2)
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 5)
            .padding(.vertical, 4)
            .background(theme.surface, in: .rect(cornerRadius: 22))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(lit ? theme.accent : Color(.separator), lineWidth: lit ? 2 : 0.5)
            }
            .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
            // Under the chat, not over a page, and not with the keyboard up.
            if !focused, kind == .page || state?.panel == true {
                // At the accessibility sizes, as at the largest other size:
                // never more than two lines.
                Disclaimer().dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, focused ? 6 : 2)
        .animation(.snappy(duration: 0.2), value: open)
        .onChange(of: focused) { _, now in
            // On a reading page, the box opens the chat over the page.
            if now, kind == .bar, !away, state?.panel != true { box.ask(["type": "open"]) }
        }
        // Another page: the keyboard goes, and a reading page's box is one line.
        .onChange(of: kind) { focused = false }
        .onChange(of: state?.panel) { was, now in
            if was == true, now == false { focused = false }
        }
        .onChange(of: state?.asked) { was, now in
            guard let was, let now, now > was else { return }
            lit = true
            Task {
                try? await Task.sleep(for: .milliseconds(900))
                lit = false
            }
        }
        .photosPicker(isPresented: $photos, selection: $picked, maxSelectionCount: 20, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await chose(await Chosen.photos(items)) }
        }
        .fileImporter(isPresented: $files, allowedContentTypes: [.pdf, .jpeg, .png, .heic, .heif],
                      allowsMultipleSelection: true) { result in
            switch result {
            case let .success(urls): Task { await chose(Chosen.files(urls)) }
            case .failure: Task { await chose(nil) }
            }
        }
        .confirmationDialog("Add \(grouping.count) photos", isPresented: groupingShown, titleVisibility: .visible) {
            Button("\(grouping.count) photos → one document") { add(grouping, together: true) }
            Button("\(grouping.count) documents") { add(grouping, together: false) }
        } message: {
            Text("Usually one report, photographed page by page.")
        }
    }

    private var groupingShown: Binding<Bool> {
        Binding { !grouping.isEmpty } set: { if !$0 { grouping = [] } }
    }

    /// Send, or while a reply runs: Stop, or Steer or Queue once there are words.
    @ViewBuilder
    private func send(_ state: ChatBox.State?) -> some View {
        // Rufi can't be reached: Send keeps the message to send when it can.
        let away = box.away
        let button = away ? "send" : state?.button ?? "send"
        let can = away ? !box.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : state?.canSend ?? false
        Button {
            if away {
                shell.pend(box.text)
            } else {
                box.ask(["type": button == "stop" ? "stop" : "send"])
            }
        } label: {
            Image(systemName: Self.symbol(button))
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .foregroundStyle(button == "stop" ? Color(.systemBackground) : can ? theme.onAccent : .white)
                .background(button == "stop" ? Color(.label) : can ? theme.accent : Color(.systemGray3), in: .circle)
        }
        .disabled(!can)
        .accessibilityLabel(button.capitalized)
        .padding(.bottom, 3)
    }

    private static func symbol(_ button: String) -> String {
        switch button {
        case "stop": "stop.fill"
        case "steer": "arrow.triangle.merge"
        case "queue": "text.badge.plus"
        default: "arrow.up"
        }
    }

    /// The paperclip: Photos, Files and Camera.
    private func attach(_ state: ChatBox.State) -> some View {
        Menu {
            Button("Photos", systemImage: "photo.on.rectangle") { photos = true }
            Button("Files", systemImage: "folder") { files = true }
            Button("Camera", systemImage: "camera") { shell.scan() }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 17))
                .frame(width: 34, height: 34)
                .foregroundStyle(.secondary)
        }
        .menuOrder(.fixed)
        .disabled(state.closed != nil)
        .accessibilityLabel("Add Documents")
    }

    /// The model and the effort, from the next reply.
    private func model(_ state: ChatBox.State) -> some View {
        Menu {
            Picker("Model", selection: Binding { state.model.id } set: { box.ask(["type": "model", "id": $0]) }) {
                ForEach(state.models) { model in
                    Text(model.name).tag(model.id).selectionDisabled(!model.available)
                }
            }
            .pickerStyle(.inline)
            ForEach(state.signIn, id: \.self) { Text($0) }
            Picker("Effort", selection: Binding { state.effort.id } set: { box.ask(["type": "effort", "id": $0]) }) {
                ForEach(state.efforts) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.inline)
            Text(state.effortWords)
        } label: {
            HStack(spacing: 4) {
                Text(state.model.name).lineLimit(1)
                Text(state.effort.name).foregroundStyle(.secondary).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .foregroundStyle(Color(.label))
            .padding(.horizontal, 6)
            .frame(minHeight: 34)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model and effort: \(state.model.name), \(state.effort.name)")
    }

    /// How much of the AI's memory the chat uses; a tap says what it means.
    private func meter(_ meter: ChatBox.State.Meter) -> some View {
        Button { self.meter = true } label: {
            HStack(spacing: 4) {
                ZStack {
                    Circle().stroke(.secondary.opacity(0.3), lineWidth: 2.5)
                    Circle().trim(from: 0, to: Double(meter.used) / 100)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 14, height: 14)
                Text("\(meter.used)%")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(minHeight: 34)
            .padding(.horizontal, 4)
        }
        .accessibilityLabel("Context used: \(meter.used)%")
        .popover(isPresented: $meter) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Context used: \(meter.used)%").bold()
                Text(meter.words)
            }
            .font(.footnote)
            .padding()
            .frame(width: 260)
            .presentationCompactAdaptation(.popover)
        }
    }

    /// Files chosen: added now, or first asked how when two or more are photos.
    /// When one couldn't be read, none are added: a report must not go in
    /// part, so the person chooses them again.
    private func chose(_ files: [Door.Upload]?) async {
        guard let files else {
            shell.addProblem = "Rufi couldn't read one of them, so it added none. Choose them again."
            return
        }
        guard !files.isEmpty else { return }
        if files.filter({ $0.type.hasPrefix("image/") }).count >= 2 {
            grouping = files
        } else {
            add(files, together: true)
        }
    }

    private func add(_ files: [Door.Upload], together: Bool) {
        grouping = []
        Task { await shell.attach(files, together: together) }
    }
}

/// What the person chose in Photos or Files, read into memory: all of it,
/// or nothing when one couldn't be read.
enum Chosen {
    /// The chosen photos as they are kept, named by their kind.
    static func photos(_ items: [PhotosPickerItem]) async -> [Door.Upload]? {
        var files: [Door.Upload] = []
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
            let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
            files.append(Door.Upload(name: "Photo \(index + 1).\(type.preferredFilenameExtension ?? "jpg")",
                                     type: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        return files
    }

    /// The chosen files, read while Files lets the app see them.
    static func files(_ urls: [URL]) -> [Door.Upload]? {
        var files: [Door.Upload] = []
        for url in urls {
            let seen = url.startAccessingSecurityScopedResource()
            defer { if seen { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension) ?? .data
            files.append(Door.Upload(name: url.lastPathComponent,
                                     type: type.preferredMIMEType ?? "application/octet-stream", data: data))
        }
        return files
    }
}

/// A message waiting to send, above the box: its words, and Pending (or
/// why Rufi refused it).
private struct PendingRow: View {
    let message: PendingMessage
    @Environment(Theme.self) private var theme

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(message.text).font(.subheadline).lineLimit(1)
                if let refused = message.refused {
                    Text(refused).font(.caption).foregroundStyle(.red)
                } else {
                    Label("Pending", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(theme.surface, in: .rect(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Color(.separator), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }
}

/// A chip in the box: what it is, and ✕ to take it out.
private struct ChipView: View {
    let chip: ChatBox.State.Chip
    let removable: Bool
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: chip.kind == "document" ? "doc.text" : "list.bullet.rectangle")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(chip.label.isEmpty ? "Adding…" : chip.label)
                .font(.footnote)
                .lineLimit(1)
                .frame(maxWidth: 220, alignment: .leading)
            if removable {
                Button("Remove \(chip.label)", systemImage: "xmark", action: remove)
                    .labelStyle(.iconOnly)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 10))
    }
}

/// Under the chat: a reminder to check what the AI says. One line, a little
/// smaller where needed; two lines at the largest text sizes.
private struct Disclaimer: View {
    private let words = "AI can make mistakes. Check important health decisions with your doctor."
    @ScaledMetric(relativeTo: .caption2) private var size: CGFloat = 11

    var body: some View {
        ViewThatFits(in: .horizontal) {
            Text(words).font(.system(size: size)).lineLimit(1)
            Text(words).font(.system(size: size * 0.88)).lineLimit(1)
            Text(words).font(.system(size: size)).multilineTextAlignment(.center)
        }
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}
