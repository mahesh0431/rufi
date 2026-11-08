import SwiftUI

/// The chat's box: one line at rest, the text line and its options while in
/// use, and under it a reminder. Its rules are the chat's (`ChatModel`).
struct ChatBoxView: View {
    let shell: Shell
    let chat: ChatModel
    @Environment(Theme.self) private var theme
    @FocusState private var focused: Bool
    @State private var lit = false
    @State private var meter = false
    /// Where the paperclip adds from now.
    @State private var adding: AddFrom?

    var body: some View {
        let open = focused || !chat.text.isEmpty || !chat.chips.isEmpty
        let away = shell.away
        VStack(spacing: 4) {
            // While Rufi can't be reached, the pill over the box says so.
            if !away, let line = chat.line {
                HStack(spacing: 8) {
                    Text(line)
                    if chat.retry {
                        Button("Retry", systemImage: "arrow.clockwise") { chat.save() }
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
            VStack(alignment: .leading, spacing: 2) {
                if !chat.chips.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(chat.chips, id: \.ref.key) { chip in
                                ChipView(chip: chip, removable: chat.loaded) { Task { await chat.remove(chip) } }
                            }
                        }
                        .padding(.top, 6)
                    }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Ask or tell Rufi about \(shell.pairing.person.name)…",
                              text: Binding { chat.text } set: { chat.typed($0) }, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($focused)
                        .disabled(!chat.loaded)
                        .padding(.vertical, 8)
                        .accessibilityLabel("Message to Rufi")
                    if !open || away { send() }
                }
                // What needs Rufi waits until it can be reached.
                if open, !away {
                    HStack(spacing: 2) {
                        attach()
                        model()
                        Spacer(minLength: 4)
                        if let used { meter(used) }
                        send()
                    }
                    .padding(.bottom, 2)
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 5)
            .padding(.vertical, 4)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
            .overlay {
                if lit { RoundedRectangle(cornerRadius: 22).strokeBorder(theme.accent, lineWidth: 2) }
            }
            // Not with the keyboard up. At the accessibility sizes, as at
            // the largest other size: never more than two lines.
            if !focused { Disclaimer().dynamicTypeSize(...DynamicTypeSize.xxxLarge) }
        }
        .padding(.horizontal)
        .floating(shell, keyboard: focused)
        .animation(.snappy(duration: 0.2), value: open)
        .onChange(of: chat.asked) {
            lit = true
            Task {
                try? await Task.sleep(for: .milliseconds(900))
                lit = false
            }
        }
        // Leaving the screen keeps what is typed now.
        .onDisappear { if chat.loaded { chat.save() } }
        .addingDocuments(shell: shell, from: $adding)
    }

    /// How much of the AI's memory the chat uses, in percent.
    private var used: Int? {
        guard let context = chat.transcript.chat?.context, context.window > 0 else { return nil }
        return min(100, max(0, Int((100 * Double(context.tokens) / Double(context.window)).rounded())))
    }

    /// Send, or while a reply runs: Stop, or Steer or Queue (as the Mac's
    /// setting says) once there are words. While Rufi can't be reached,
    /// Send keeps the message to send when it can.
    @ViewBuilder
    private func send() -> some View {
        let button = chat.working && !shell.away ? (chat.hasText ? chat.whileReplying : "stop") : "send"
        let can = button == "stop" || (chat.loaded && chat.hasText)
        Button {
            if button == "stop" { Task { await chat.stop() } } else { chat.send() }
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
    private func attach() -> some View {
        Menu {
            AddFrom.choices { adding = $0 }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 17))
                .frame(width: 34, height: 34)
                .foregroundStyle(.secondary)
        }
        .menuOrder(.fixed)
        .disabled(!chat.loaded)
        .accessibilityLabel("Add Documents")
    }

    /// The model and the effort, from the next reply; a model whose
    /// provider is signed out on the Mac can't be chosen.
    private func model() -> some View {
        let info = chat.transcript.chat
        let available = Words.models.filter { chat.signedIn.contains($0.2) }
        let model = info?.model ?? available.first?.0 ?? Words.models[0].0
        let effort = info?.effort ?? "medium"
        let signIn = [("codex", "Sign in with ChatGPT on your Mac"), ("claude", "Sign in to Claude on your Mac")]
            .filter { !chat.signedIn.contains($0.0) }.map(\.1)
        return Menu {
            Picker("Model", selection: Binding { model } set: { id in Task { await chat.choose("model", id) } }) {
                ForEach(Words.models, id: \.0) { item in
                    Text(item.1).tag(item.0).selectionDisabled(!chat.signedIn.contains(item.2))
                }
            }
            .pickerStyle(.inline)
            ForEach(signIn, id: \.self) { Text($0) }
            Picker("Effort", selection: Binding { effort } set: { id in Task { await chat.choose("effort", id) } }) {
                ForEach(Words.efforts, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.inline)
            Text(Words.effortWords)
        } label: {
            HStack(spacing: 4) {
                Text(Words.model(model)).lineLimit(1)
                Text(Words.effort(effort)).foregroundStyle(.secondary).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .foregroundStyle(Color(.label))
            .padding(.horizontal, 6)
            .frame(minHeight: 34)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model and effort: \(Words.model(model)), \(Words.effort(effort))")
    }

    /// How much of the AI's memory the chat uses; a tap says what it means.
    private func meter(_ used: Int) -> some View {
        Button { meter = true } label: {
            HStack(spacing: 4) {
                ZStack {
                    Circle().stroke(.secondary.opacity(0.3), lineWidth: 2.5)
                    Circle().trim(from: 0, to: Double(used) / 100)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 14, height: 14)
                Text("\(used)%")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(minHeight: 34)
            .padding(.horizontal, 4)
        }
        .accessibilityLabel("Context used: \(used)%")
        .popover(isPresented: $meter) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Context used: \(used)%").bold()
                Text("Of the AI's memory for this chat. Near full, Codex compacts the chat history.")
            }
            .font(.footnote)
            .padding()
            .frame(width: 260)
            .presentationCompactAdaptation(.popover)
        }
    }
}

/// A chip in the box: what it is, and ✕ to take it out.
private struct ChipView: View {
    let chip: Chip
    let removable: Bool
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: ChipLabel.symbol(chip.ref.type))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(chip.label.isEmpty ? "Adding…" : chip.label)
                .font(.footnote)
                .lineLimit(1)
                .frame(maxWidth: 220, alignment: .leading)
            if chip.ref.readAgain == true {
                Text("· read again").font(.footnote).foregroundStyle(.secondary)
            }
            if removable {
                Button("Take \(chip.label) out of the message", systemImage: "xmark", action: remove)
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
