import SwiftUI

// Rufi AI's open question (docs/adr/0036), as the iPhone draws it: the
// question panel, in the box's place until the person answers. Rufi's dog
// peeks over its top; it says "Rufi asks" and the card's key, with
// Minimise, then the details, the question, each answer as a raised button
// that sends it (a short line under its label, and Recommended on one Rufi
// AI recommends), and a field for the person's own answer. A tap, or the
// own answer sent, is the person's message quoting the card, kept on the
// iPhone first as any send is; it shows in the chat (Pending while Rufi
// can't be reached), the panel goes and the box is back. A refused answer
// comes back to the panel, with why. Minimise folds it to one line, until
// the question changes. A message's quote opens its card read-only.

extension EnvironmentValues {
    /// Opens the card a message's quote names.
    @Entry var openQuestion: (Chip) -> Void = { _ in }
}

/// Rufi itself, apricot, beside its question.
struct ApricotDog: View {
    var size: CGFloat = 32

    var body: some View {
        Image(decorative: "Apricot").resizable().scaledToFit().frame(width: size, height: size)
    }
}

/// "Rufi asks · <key>", on one line.
private struct Asks: View {
    let key: String

    var body: some View {
        (Text("Rufi asks").fontWeight(.semibold) + Text(verbatim: " · \(key)").foregroundStyle(.secondary))
            .lineLimit(1)
    }
}

struct QuestionPanelView: View {
    let shell: Shell
    let chat: ChatModel
    let entry: Entry
    let card: QuestionCard
    @Environment(Theme.self) private var theme
    @State private var folded = false
    @FocusState private var typing: Bool

    var body: some View {
        VStack(spacing: 4) {
            if folded {
                QuestionLine(key: card.key) { folded = false }
            } else {
                panel
            }
            if !typing { Disclaimer().dynamicTypeSize(...DynamicTypeSize.xxxLarge) }
        }
        .padding(.horizontal)
        .floating(shell, keyboard: typing)
        .animation(.snappy(duration: 0.2), value: folded)
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Asks(key: card.key).font(.subheadline)
                Spacer(minLength: 0)
                Button {
                    typing = false
                    folded = true
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(theme.surface, in: .circle)
                        .overlay { Circle().strokeBorder(Color(.separator), lineWidth: 0.5) }
                }
                .accessibilityLabel("Minimise")
            }
            .padding(.leading, 34)
            .accessibilityElement(children: .contain)
            if let details = card.details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                RufiMarkdown(text: details)
                    // The details are Rufi AI's words: their links go nowhere.
                    .environment(\.openURL, OpenURLAction { _ in .discarded })
                    .padding(.horizontal, 4)
            }
            Text(verbatim: card.question)
                .fontWeight(.semibold)
                .textSelection(.enabled)
                .padding(.horizontal, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(card.answers.indices, id: \.self) { index in
                let answer = card.answers[index]
                AnswerButton(answer: answer) { chat.answer(index, on: entry) }
            }
            own
            if let said = chat.answerSaid[entry.id] {
                Text(said).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .background(theme.side, in: .rect(cornerRadius: 26))
        .overlay { RoundedRectangle(cornerRadius: 26).strokeBorder(Color(.separator).opacity(0.5), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.1), radius: 15, y: 6)
        .overlay(alignment: .topLeading) { ApricotDog().offset(x: 12, y: -14) }
        .padding(.top, 14)
    }

    /// The person's own answer: what the buttons don't offer.
    private var own: some View {
        let words = chat.ownAnswers[entry.id] ?? ""
        let can = !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && words.count <= ChatModel.maxText
        return HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: "pencil").foregroundStyle(.secondary).padding(.bottom, 12)
            TextField("Your own answer…", text: Binding { words } set: { chat.ownAnswers[entry.id] = $0 },
                      axis: .vertical)
                .lineLimit(1...5)
                .focused($typing)
                .padding(.vertical, 8)
                .accessibilityLabel("Your own answer")
            Button {
                typing = false
                chat.answer(nil, own: words, on: entry)
            } label: {
                // Fixed, as the chat box's: it fits its circle at every text size.
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(can ? theme.onAccent : .white)
                    .background(can ? theme.accent : Color(.systemGray3), in: .circle)
            }
            .disabled(!can)
            .accessibilityLabel("Send")
            .padding(.bottom, 3)
        }
        .padding(.leading, 14)
        .padding(.trailing, 5)
        .padding(.vertical, 4)
        .background(theme.surface, in: .rect(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(Color(.separator), lineWidth: 0.5) }
    }
}

/// One answer: a raised button with its send arrow. One Rufi AI
/// recommends has a ring, a tag and a filled arrow.
private struct AnswerButton: View {
    let answer: QuestionCard.Answer
    let send: () -> Void
    @Environment(Theme.self) private var theme

    var body: some View {
        let recommended = answer.recommended == true
        Button(action: send) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: answer.label).foregroundStyle(Color(.label))
                    if let description = answer.description,
                       !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(verbatim: description).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                if recommended {
                    Text("Recommended")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color(.label))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .overlay { Capsule().strokeBorder(theme.accent, lineWidth: 1) }
                }
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(recommended ? theme.onAccent : Color(.label))
                    .frame(width: 30, height: 30)
                    .background(recommended ? theme.accent : theme.side, in: .circle)
            }
            .padding(.leading, 15)
            .padding(.trailing, 8)
            .padding(.vertical, 7)
            .frame(minHeight: 48)
            .background(theme.surface, in: .rect(cornerRadius: 15))
            .overlay {
                RoundedRectangle(cornerRadius: 15)
                    .strokeBorder(recommended ? theme.accent : Color(.separator), lineWidth: recommended ? 2 : 0.5)
            }
        }
        .buttonStyle(Raised())
        .accessibilityHint("Sends this answer")
    }
}

/// A raised button that presses in while touched.
private struct Raised: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .shadow(color: .black.opacity(configuration.isPressed ? 0.04 : 0.1), radius: configuration.isPressed ? 1 : 3,
                    y: configuration.isPressed ? 0.5 : 2)
            .offset(y: configuration.isPressed ? 1 : 0)
            .animation(.snappy(duration: 0.1), value: configuration.isPressed)
    }
}

/// The question folded to one line, here and as a page's bar: a tap opens it.
struct QuestionLine: View {
    let key: String
    let open: () -> Void
    @Environment(Theme.self) private var theme

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                ApricotDog(size: 30)
                Asks(key: key).foregroundStyle(Color(.label))
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
                    .background(theme.surface, in: .circle)
                    .overlay { Circle().strokeBorder(Color(.separator), lineWidth: 0.5) }
            }
            .padding(.leading, 8)
            .padding(.trailing, 8)
            .padding(.vertical, 7)
            .background(theme.side, in: .capsule)
            .overlay { Capsule().strokeBorder(Color(.separator).opacity(0.5), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.1), radius: 12, y: 5)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rufi asks · \(key)")
        .accessibilityHint("Opens the question")
        .accessibilityAddTraits(.isButton)
    }
}

/// An answer's quote of its card, at the top of the person's message: it opens the whole question.
struct QuestionQuote: View {
    let chip: Chip
    @Environment(\.openQuestion) private var open

    var body: some View {
        Button {
            open(chip)
        } label: {
            HStack(spacing: 6) {
                ApricotDog(size: 18)
                Text(verbatim: chip.label).lineLimit(1)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(.separator)).frame(height: 0.5) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chip.label)
        .accessibilityHint("Shows the question")
    }
}

/// The card a quote opened, read-only, with the answer that message chose
/// marked. A card on an earlier page loads with it.
struct QuestionSheet: View {
    let quote: Chip
    let chat: ChatModel
    @Environment(Theme.self) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let card = chat.transcript.entries[quote.ref.id]?.question
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let card {
                        if let details = card.details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            RufiMarkdown(text: details)
                                .environment(\.openURL, OpenURLAction { _ in .discarded })
                        }
                        Text(verbatim: card.question).fontWeight(.semibold).textSelection(.enabled)
                        ForEach(card.answers.indices, id: \.self) { index in
                            row(card.answers[index], chosen: index == quote.ref.answer)
                        }
                    } else if chat.older == .failed || chat.transcript.before == nil {
                        Text("Can't load the question").foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(card.map { "Rufi asked · \($0.key)" } ?? "Rufi asked")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ApricotDog(size: 26) }
                ToolbarItem(placement: .topBarTrailing) { Button("Close", systemImage: "xmark") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task(id: quote.ref.id) {
            // Earlier pages load until the card is there, or the chat's start.
            while chat.transcript.entries[quote.ref.id] == nil, chat.transcript.before != nil, chat.older != .failed {
                if chat.older == .loading {
                    try? await Task.sleep(for: .milliseconds(50))
                } else {
                    await chat.loadOlder()
                }
            }
        }
    }

    private func row(_ answer: QuestionCard.Answer, chosen: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: answer.label)
                if let description = answer.description,
                   !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(verbatim: description).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if answer.recommended == true {
                Text("Recommended").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            if chosen { Image(systemName: "checkmark").foregroundStyle(theme.accentInk) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(chosen ? theme.accentSoft : theme.side, in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(chosen ? "Your answer: \(answer.label)" : answer.label)
    }
}
