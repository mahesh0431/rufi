import SwiftUI

// A question card Rufi AI asked with (docs/adr/0036), as the iPhone draws it:
// its key, the details naming what the person approves, the question, a
// button for each answer, and Reply. A tap on an answer is the person's
// message, quoting the card, kept on the iPhone first as any send is; the
// box keeps its words. The card then shows the answer on its way (Pending
// while Rufi can't be reached, Sending, Waiting in the queue) and, once it
// reached Rufi AI, the answer chosen, with no buttons. Reply puts the card's
// quote in the box, for the person's own words; it answers nothing.

extension EnvironmentValues {
    /// Goes to a question card in the chat, by its entry.
    @Entry var goToQuestion: (String) -> Void = { _ in }
}

struct QuestionCardView: View {
    let entry: Entry
    let card: QuestionCard
    let chat: ChatModel
    let shell: Shell
    @Environment(Theme.self) private var theme

    var body: some View {
        let click = chat.click(on: entry)
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(verbatim: card.key)
            } icon: {
                Image(systemName: "questionmark.bubble")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
            if let details = card.details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                RufiMarkdown(text: details)
            }
            Text(verbatim: card.question).fontWeight(.medium).textSelection(.enabled)
            HStack(alignment: .center, spacing: 8) {
                if let click { state(click) } else { answers }
                Spacer(minLength: 0)
                Button("Reply", systemImage: "arrowshape.turn.up.left") {
                    let quote = Chip(ref: Pointer(type: "question", id: entry.id), label: card.key,
                                     detail: "Rufi AI's question")
                    Task { await shell.ask([quote]) }
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
            }
        }
        // The details are Rufi AI's words: their links go nowhere.
        .environment(\.openURL, OpenURLAction { _ in .discarded })
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator), lineWidth: 0.5) }
    }

    /// A button for each answer, as many to a line as fit.
    private var answers: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons }
            VStack(alignment: .leading, spacing: 8) { buttons }
        }
    }

    private var buttons: some View {
        ForEach(card.answers.indices, id: \.self) { index in
            Button {
                chat.choose(index, on: entry)
            } label: {
                Text(verbatim: card.answers[index])
            }
            .buttonStyle(.bordered)
        }
    }

    /// The answer chosen, and where it is.
    @ViewBuilder private func state(_ click: ChatModel.Click) -> some View {
        switch click {
        case let .answered(index):
            Label { Text(verbatim: words(index)) } icon: { Image(systemName: "checkmark").foregroundStyle(theme.accent) }
        case let .waiting(index):
            Label("\(words(index)) · Waiting", systemImage: "hourglass").foregroundStyle(.secondary)
        case let .sending(index):
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("\(words(index)) · Sending")
            }
            .foregroundStyle(.secondary)
        case let .pending(index):
            if shell.away {
                Label("\(words(index)) · Pending", systemImage: "clock").foregroundStyle(.secondary)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("\(words(index)) · Sending")
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    private func words(_ index: Int) -> String {
        card.answers.indices.contains(index) ? card.answers[index] : ""
    }
}

/// An answer's quote of its card, at the top of the person's message: it goes back to the card.
struct QuestionQuote: View {
    let chip: Chip
    @Environment(\.goToQuestion) private var goTo

    var body: some View {
        Button {
            goTo(chip.ref.id)
        } label: {
            HStack(spacing: 6) {
                Rectangle().fill(Color(.separator)).frame(width: 2)
                Image(systemName: "questionmark.bubble")
                Text(verbatim: chip.label).lineLimit(1)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chip.label)
        .accessibilityHint("Goes to the question")
    }
}
