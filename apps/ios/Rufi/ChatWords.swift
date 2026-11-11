import Foundation

// The Mac's words for the chat, ported from transcript.tsx, activity.tsx,
// thinking.ts and dates.ts. Days and times are this iPhone's.

extension Words {
    static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// The line before a day's first entry: "Today", "Yesterday", "Thu 8 Oct",
    /// and the year when it isn't this one.
    static func dayLine(_ iso: String, now: Date = .now, calendar: Calendar = .current) -> String {
        guard let at = instant(iso) else { return iso }
        if calendar.isDate(at, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(at, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let parts = calendar.dateComponents([.weekday, .day, .month, .year], from: at)
        let day = "\(weekdays[(parts.weekday ?? 1) - 1]) \(parts.day ?? 0) \(months[(parts.month ?? 1) - 1])"
        return parts.year == calendar.component(.year, from: now) ? day : "\(day) \(parts.year ?? 0)"
    }

    /// How long something took: "0.4s", "12s", "1m 36s".
    static func took(_ seconds: Double) -> String {
        if seconds < 60 { return seconds < 10 ? String(format: "%.1fs", seconds) : "\(Int(seconds.rounded()))s" }
        let whole = Int(seconds.rounded())
        return "\(whole / 60)m \(whole % 60)s"
    }

    /// A running clock: "0:12", "3:05".
    static func clock(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds))
        return "\(whole / 60):\(String(format: "%02d", whole % 60))"
    }

    static func steps(_ count: Int) -> String {
        plural(count, "step", "steps")
    }

    /// The latest heading of a thinking summary (a paragraph that starts in
    /// bold), else its first line, without the bold.
    static func heading(_ summary: String) -> String {
        let paragraphs = summary.split(separator: /\n\s*\n/)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let paragraph = paragraphs.last { $0.hasPrefix("**") } ?? paragraphs.first ?? ""
        let line = paragraph.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return line.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces)
    }

    /// The four models' names; another shows its id.
    static let models = [
        ("gpt-6-astra", "GPT-6-Astra", "codex"), ("gpt-6.1-sol", "GPT-6.1-Sol", "codex"),
        ("claude-fable-5-1", "Claude Fable 5.1", "claude"), ("claude-opus-5-5", "Claude Opus 5.5", "claude"),
    ]
    static let efforts = [("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "XHigh")]
    static let effortWords = "Medium: careful answers at a good speed. Low is faster; High and XHigh think longer."

    static func model(_ id: String) -> String {
        models.first { $0.0 == id }?.1 ?? id
    }

    static func effort(_ id: String) -> String {
        efforts.first { $0.0 == id }?.1 ?? id
    }

    /// "Model changed: GPT-6-Astra XHigh → Claude Opus 5.5 High".
    static func modelChanged(_ turn: Turn) -> String {
        modelChanged(from: turn.before, to: Turn.RanOn(model: turn.model, effort: turn.effort))
    }

    static func modelChanged(from: Turn.RanOn?, to: Turn.RanOn) -> String {
        let ran = { (model: String, effort: String?) in ([model.isEmpty ? nil : self.model(model), effort.map(self.effort)])
            .compactMap { $0 }.joined(separator: " ") }
        return "Model changed: \(ran(from?.model ?? "", from?.effort)) → \(ran(to.model, to.effort))"
    }

    /// The waiting list's heading: what happens to its rows now.
    static func waitingHeading(_ items: [QueueItem], running: Bool) -> String {
        if running { return "Waiting · these go in order after the reply" }
        // Held for the sign-in, a row goes by itself once signed in; any other hold waits for the person.
        if items.contains(where: { $0.held != nil && $0.held != "signed_out" }) {
            return "Not sent · Rufi sends these only when you say"
        }
        if items.contains(where: { $0.held == "signed_out" }) { return "Waiting until you sign in" }
        return "Waiting"
    }

    /// Why a waiting row doesn't go by itself: Failed, or Not sent, and why as it came.
    static func held(_ item: QueueItem) -> String? {
        switch item.held {
        case "restored": "Not sent · From a backup: it waited when the backup was made."
        case "stopped": "Not sent · \(item.heldText ?? "")"
        case "failed", "open_failed": "Failed · \(item.heldText ?? "")"
        case "signed_out": item.heldText
        default: nil
        }
    }

    /// An agent's line in its sheet: "running · 1:05 · GPT-6-Astra · Medium".
    static func agent(_ agent: SubAgent, among agents: [SubAgent], now: Date) -> String {
        let elapsed = agent.working ? agent.since.flatMap(instant).map { clock(now.timeIntervalSince($0)) } : nil
        return [status(agent, among: agents), elapsed, model(agent.model), effort(agent.effort)].compactMap { $0 }.joined(separator: " · ")
    }

    /// An agent's status in words: what a waiting one waits for, the answer of
    /// the agent that started it (Rufi AI, or one of `agents`) or a sign-in.
    static func status(_ agent: SubAgent, among agents: [SubAgent]) -> String {
        switch agent.waiting {
        case "signed_out": "signed out"
        case "asked": "waiting for \(agents.first { $0.id == agent.parent }?.title ?? "Rufi AI")"
        default: agent.status
        }
    }

    /// How a reply that didn't complete ended, as Rufi says it.
    static func ending(_ turn: Turn, calendar: Calendar = .current) -> String {
        if let text = turn.endText { return text }
        guard turn.endReason == "usage_limit", let resets = turn.resetsAt, let at = instant(resets) else {
            return "This reply didn't finish."
        }
        let parts = calendar.dateComponents([.hour, .minute, .day, .month, .year], from: at)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return "This reply didn't finish. It resets at \(time) on \(parts.day ?? 0) \(months[(parts.month ?? 1) - 1]) \(parts.year ?? 0)."
    }

    /// An Activity's label once its reply ended: "Activity · 12 steps · 1 failed · 1m 36s".
    static func activity(_ turn: Turn, steps: [Entry]) -> String {
        let failed = steps.count { $0.status == "failed" }
        let stopped = steps.count { $0.status == "stopped" }
        var parts = ["Activity", self.steps(steps.count)]
        if failed > 0 { parts.append("\(failed) failed") }
        if stopped > 0 { parts.append("\(stopped) stopped") }
        // A crash leaves no end to count to.
        if !(turn.status == "interrupted" && turn.endReason == nil), let start = instant(turn.startedAt),
           let end = turn.endedAt.flatMap(instant) {
            parts.append(took(end.timeIntervalSince(start)))
        }
        return parts.joined(separator: " · ")
    }

    /// A step's one line: its text, and its detail when it has one.
    static func step(_ entry: Entry) -> String {
        step(entry.text, entry.detail)
    }

    static func step(_ text: String, _ detail: String?) -> String {
        let line = detail.map { "\(text) · \($0)" } ?? text
        return line.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
