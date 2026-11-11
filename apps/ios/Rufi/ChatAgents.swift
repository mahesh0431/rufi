import SwiftUI

// Rufi AI's agents, as the Mac's chat shows them (agents.tsx, transcript.tsx):
// a row of chips above the box for each of its own agents at work, and the
// sheet one opens, with the agent's own Activity and Stop. An agent whose
// turn ended leaves the row; its message to Rufi AI shows in the chat, and
// its name there opens the same sheet.

extension EnvironmentValues {
    /// Inside an agent's sheet: a helper's line opens its Activity below it.
    @Entry var inAgentSheet = false
}

/// The row above the box: Rufi AI's own agents that work now; none, no row.
struct AgentsAtWork: View {
    let chat: ChatModel
    @Environment(Theme.self) private var theme

    var body: some View {
        let agents = chat.agents.filter { $0.parent == nil && $0.working }
        if !agents.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(agents) { agent in
                        Button { chat.openAgent = .init(id: agent.id, title: agent.title) } label: {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.mini)
                                    Text(agent.title).fontWeight(.medium).lineLimit(1)
                                    if let since = agent.since.flatMap(Words.instant) {
                                        Text(Words.clock(context.date.timeIntervalSince(since)))
                                            .foregroundStyle(.secondary).monospacedDigit()
                                    }
                                }
                            }
                            .font(.footnote)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(theme.surface, in: .capsule)
                            .overlay { Capsule().strokeBorder(Color(.separator), lineWidth: 0.5) }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Agents at work")
        }
    }
}

/// An agent's sheet: its name, how it is now, Stop while it works, and its
/// own Activity.
struct AgentSheet: View {
    let open: ChatModel.OpenAgent
    let chat: ChatModel
    let shell: Shell
    @State private var stopping = false
    @State private var problem: String?
    @State private var step: Step?

    var body: some View {
        let agent = chat.agents.first { $0.id == open.id }
        let title = agent?.title ?? open.title
        ChatSheet(title: title) {
            if let agent {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(Words.agent(agent, among: chat.agents, now: context.date)).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.secondary) }
            AgentLogView(id: open.id, title: title) { step = $0 }
                .toolbar {
                    if agent?.working == true {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Stop", systemImage: "stop.fill") { Task { await stop() } }
                                .disabled(stopping)
                        }
                    }
                }
        }
        .environment(chat)
        .environment(\.inAgentSheet, true)
        .sheet(item: $step) { StepDetails(step: $0, shell: shell) }
    }

    /// Stops the agent and the agents it started; the agents' line says when.
    private func stop() async {
        stopping = true
        problem = nil
        do throws(Door.Problem) {
            try await chat.stop(agent: open.id)
        } catch {
            problem = error.shown ?? "Can't reach Rufi"
        }
        stopping = false
    }
}

/// A sheet over the chat for one line of its Activity, as an agent opens
/// in: its name at the top, Close, and all it holds, scrolling.
struct ChatSheet<Content: View>: View {
    let title: String
    let content: Content
    @Environment(\.dismiss) private var dismiss

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) { content }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }
}

/// A sub-agent's own Activity, as it reported it: its latest lines, and
/// earlier ones on request. Its helpers show as lines that open below
/// them, at any depth. Read again when the agents change.
struct AgentLogView: View {
    let id: String
    let title: String
    let open: (Step) -> Void
    @Environment(ChatModel.self) private var chat
    @State private var log: AgentLog?
    @State private var last = 50
    @State private var problem: String?
    @State private var gone = false
    @State private var reading = false

    var body: some View {
        let agent = chat.agents.first { $0.id == id }
        VStack(alignment: .leading, spacing: 8) {
            if gone {
                Text("Its Activity is gone with the AI's working state.").foregroundStyle(.secondary)
            } else if let log {
                if log.earlier {
                    Button(reading ? "Loading…" : "Show earlier", systemImage: "chevron.up.2") { last += 50 }
                        .font(.subheadline)
                        .disabled(reading)
                }
                ForEach(log.lines) { AgentLineView(line: $0, agent: id, open: open) }
                if let agent, agent.working, Self.thinking(log.lines) {
                    ThinkingLine(since: agent.since.flatMap(Words.instant) ?? .now)
                }
            } else if let problem {
                HStack(spacing: 8) {
                    Text(problem)
                    Button("Retry", systemImage: "arrow.clockwise") { Task { await read() } }
                }
                .foregroundStyle(.secondary)
            } else {
                Text("Loading…").foregroundStyle(.secondary)
            }
        }
        .font(.subheadline)
        // An agent's words: Rufi's, never links.
        .environment(\.openURL, OpenURLAction { _ in .discarded })
        .task(id: "\(chat.agentReads) \(last)") { await read() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title)'s Activity")
    }

    private func read() async {
        reading = true
        defer { reading = false }
        do throws(Door.Problem) {
            log = try await chat.log(of: id, last: last)
            problem = nil
        } catch let .refused(words) where words == "Not found." {
            gone = true
        } catch {
            // Lines already read stay; the next change reads them again.
            if log == nil { problem = error.shown ?? "Can't reach Rufi" }
        }
    }

    /// Nothing shows yet since the agent's last message: no lines, or its
    /// last line that shows is a message it took.
    static func thinking(_ lines: [AgentLog.Line]) -> Bool {
        (lines.last { $0.kind != "reasoning" || !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }?.kind
            ?? "message") == "message"
    }
}

/// One line of an agent's Activity.
private struct AgentLineView: View {
    let line: AgentLog.Line
    let agent: String
    let open: (Step) -> Void

    var body: some View {
        switch line.kind {
        case "message":
            VStack(alignment: .leading, spacing: 2) {
                Text("From \(line.from ?? "")").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                RufiMarkdown(text: line.text, muted: true)
            }
        case "reply":
            RufiMarkdown(text: line.text)
        case "question":
            Text("Asks: \(line.text)" + (line.detail.map { " (\($0))" } ?? "")).foregroundStyle(.secondary)
        case "end":
            HStack(spacing: 6) {
                StatusSign(status: line.status)
                Text([line.status ?? "", line.text].filter { !$0.isEmpty }.joined(separator: " · "))
            }
            .foregroundStyle(.secondary)
        case "model":
            if let changed = line.changed { QuietLine(words: Words.modelChanged(from: changed.from, to: changed.to)) }
        default:
            StepView(step: Step(line, of: agent), open: open)
        }
    }
}

/// A step that started a sub-agent: its name, its status and the start of
/// its result. In the chat it opens the agent's sheet; in a sheet, its
/// Activity below it. Until the agents are read, the step's own words.
struct SubAgentLine: View {
    let id: String
    let reported: String
    let open: (Step) -> Void
    @Environment(ChatModel.self) private var chat
    @Environment(\.inAgentSheet) private var below
    @State private var unfolded = false

    var body: some View {
        let agent = chat.agents.first { $0.id == id }
        let title = agent?.title ?? reported
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if below { unfolded.toggle() } else { chat.openAgent = .init(id: id, title: title) }
            } label: {
                HStack(spacing: 6) {
                    StatusSign(status: agent.map { $0.working ? "running" : $0.status } ?? "running")
                    Text(title).fontWeight(.medium).foregroundStyle(.primary).fixedSize()
                    if let agent {
                        Text("· " + ([Words.status(agent, among: chat.agents)] + [agent.result].compactMap { $0 }).joined(separator: " · "))
                            .lineLimit(1)
                    }
                    Image(systemName: below ? "chevron.right" : "arrow.up.right")
                        .font(.caption2)
                        .rotationEffect(.degrees(below && unfolded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            if unfolded {
                AgentLogView(id: id, title: title, open: open)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Color(.separator)).frame(width: 1) }
            }
        }
    }
}

/// A step's sign: running, failed, stopped, waiting, or done.
struct StatusSign: View {
    let status: String?

    var body: some View {
        switch status {
        case "running": ProgressView().controlSize(.mini)
        case "failed": Image(systemName: "xmark").font(.caption)
        case "stopped": Image(systemName: "square.fill").font(.system(size: 9))
        case "waiting": Image(systemName: "hourglass").font(.caption)
        default: Image(systemName: "checkmark").font(.caption)
        }
    }
}
