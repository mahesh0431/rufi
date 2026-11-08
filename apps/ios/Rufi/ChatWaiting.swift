import SwiftUI

/// What waits to go to the AI, over the box, as the Mac's waiting list
/// (waiting.tsx): the person's messages and Rufi's notes, in the order they
/// go, a short list that scrolls when long. A waiting message can be
/// steered into the running reply, edited, moved (touch and hold, then
/// drag) or removed; one Rufi didn't send says Failed, or Not sent, with
/// why as it came, and goes only when the person sends it.
struct WaitingList: View {
    let chat: ChatModel
    @Environment(Theme.self) private var theme
    @State private var editing: QueueItem?
    @State private var height: CGFloat = 0

    var body: some View {
        let items = chat.waiting
        if !items.isEmpty || chat.queueProblem != nil {
            let running = chat.transcript.running != nil
            let movable = items.count { $0.state == "waiting" } > 1
            VStack(alignment: .leading, spacing: 2) {
                Text(Words.waitingHeading(items, running: running))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
                if let problem = chat.queueProblem {
                    Text(problem).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12)
                }
                List {
                    ForEach(items) { item in
                        WaitingRow(item: item, running: running, chat: chat) { editing = item }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 6))
                            .moveDisabled(!movable || item.state != "waiting" || item.held != nil)
                            .listRowSeparator(item.id == items.last?.id ? .hidden : .automatic, edges: .bottom)
                    }
                    .onMove { from, to in
                        var moved = items
                        moved.move(fromOffsets: from, toOffset: to)
                        Task { await chat.reorder(moved.filter { $0.state == "waiting" }.map(\.id)) }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 36)
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { height = $1 }
                // A long list scrolls here; the box stays where it is.
                .frame(height: min(max(height, 36), 160))
            }
            .background(theme.surface, in: .rect(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator), lineWidth: 0.5) }
            .padding(.horizontal, 10)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Waiting messages")
            .sheet(item: $editing) { EditWaiting(item: $0, chat: chat) }
        }
    }
}

/// A row of what waits: Rufi's note marked as Rufi's, its chips, its words,
/// why it is held, and what can be done with it now.
struct WaitingRow: View {
    enum Action: Hashable {
        /// A held message goes now: sent, or with the AI's thread opened again.
        case send
        /// A message whose AI thread didn't open goes in a new thread.
        case newThread
        /// A waiting message goes into the running reply.
        case steer
        case edit
        case remove
    }

    let item: QueueItem
    let running: Bool
    let chat: ChatModel
    let edit: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if item.origin != "person" {
                // Rufi's note for the AI: never the person's words.
                Image(systemName: "bell").font(.footnote).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                if item.origin != "person" { Text("Rufi's note").font(.caption).foregroundStyle(.secondary) }
                if !item.refs.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) { ForEach(item.refs.indices, id: \.self) { ChipLabel(chip: item.refs[$0]) } }
                    }
                }
                Text(item.text).font(.subheadline).lineLimit(2)
                if let why = Words.held(item) { Text(why).font(.caption).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Self.actions(item, running: running), id: \.self) { button($0) }
        }
    }

    /// What a row offers, as the Mac's: a held one, Send (and New thread
    /// when its AI thread didn't open, unless a reply runs); one free to go,
    /// Steer while a reply runs; a waiting message of the person's, Edit;
    /// any waiting row, Remove. One being given to the AI, nothing.
    static func actions(_ item: QueueItem, running: Bool) -> [Action] {
        let waiting = item.state == "waiting"
        var actions: [Action] = []
        if item.held == "open_failed", item.holdId != nil {
            actions.append(.send)
            if !running { actions.append(.newThread) }
        } else if waiting, item.held != nil {
            actions.append(.send)
        } else if waiting, running {
            actions.append(.steer)
        }
        if waiting, item.origin == "person" { actions.append(.edit) }
        if waiting { actions.append(.remove) }
        return actions
    }

    @ViewBuilder
    private func button(_ action: Action) -> some View {
        let one = "\(ChatModel.one(item))"
        switch action {
        case .send:
            icon("Send", "arrow.up") {
                if let hold = item.holdId, item.held == "open_failed" {
                    await chat.change("POST", "\(one)/recover", body: ["hold": hold, "choice": "retry"], sends: true)
                } else {
                    await chat.change("POST", "\(one)/send", sends: true)
                }
            }
        case .newThread:
            Button("New thread") {
                Task {
                    await chat.change("POST", "\(one)/recover", body: ["hold": item.holdId ?? "", "choice": "new_thread"],
                                      sends: true)
                }
            }
            .font(.caption)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        case .steer:
            icon("Steer", "arrow.triangle.merge") { await chat.change("POST", "\(one)/steer", sends: true) }
        case .edit:
            Button("Edit", systemImage: "pencil", action: edit)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .frame(width: 30, height: 30)
                .foregroundStyle(.secondary)
        case .remove:
            icon("Remove", "xmark") { await chat.change("DELETE", one) }
        }
    }

    private func icon(_ name: String, _ symbol: String, _ act: @escaping () async -> Void) -> some View {
        Button(name, systemImage: symbol) { Task { await act() } }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .frame(width: 30, height: 30)
            .foregroundStyle(.secondary)
    }
}

/// Edit: a waiting message's words, saved over it.
private struct EditWaiting: View {
    let item: QueueItem
    let chat: ChatModel
    @State private var text: String
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    init(item: QueueItem, chat: ChatModel) {
        self.item = item
        self.chat = chat
        _text = State(initialValue: item.text)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .focused($focused)
                .padding(.horizontal, 12)
                .accessibilityLabel("Waiting message")
                .navigationTitle("Waiting message")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", systemImage: "xmark") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        Button("Save", systemImage: "checkmark") {
                            dismiss()
                            Task { await chat.change("PUT", ChatModel.one(item), body: ["text": words]) }
                        }
                        .disabled(words.isEmpty)
                    }
                }
                .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }
}
