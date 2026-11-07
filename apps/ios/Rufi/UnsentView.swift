import SwiftUI

/// Not on your Mac yet: the dose logs this iPhone keeps until the Mac has
/// them, each swiped left to discard. Shown only behind Rufi's lock.
struct UnsentSection: View {
    let outbox: Outbox
    /// The pairing now; none when unpaired.
    let pairing: Pairing?

    var body: some View {
        Section {
            ForEach(outbox.logs) { log in
                VStack(alignment: .leading, spacing: 2) {
                    Text(log.label)
                    Text("\(Self.when(log.doseAt)) · \(log.state == .cleared ? "undone" : log.state.rawValue)")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let refused = log.refused {
                        Text("Your Mac refused this log: \(refused)").font(.footnote).foregroundStyle(.red)
                    } else if pairing.map({ !log.made.matches($0) }) ?? false {
                        Text("From Rufi on \(log.made.mac), for \(log.made.name)").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .swipeActions {
                    Button("Discard", systemImage: "trash", role: .destructive) {
                        // A file that can't be written keeps the log: it shows still.
                        try? outbox.discard(log.id)
                    }
                }
            }
        } header: {
            Text("Not on your Mac yet")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        if let pairing, outbox.logs.contains(where: { $0.made.matches(pairing) }) {
            return "Sent when Rufi next reaches your Mac. Swipe left to discard one."
        }
        guard let made = outbox.logs.first?.made else { return "" }
        return "Kept here. Sent when you pair again for \(made.name) with Rufi on \(made.mac); never to another pairing. Swipe left to discard one."
    }

    /// "21:00, Mon 2 Nov".
    static func when(_ doseAt: String) -> String {
        guard let date = Notices.date(of: Notices.dose + doseAt, calendar: .phone()) else { return doseAt }
        return "\(doseAt.suffix(5)), \(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))"
    }

    /// "1 dose you logged isn't on your Mac yet."
    static func count(_ logs: Int) -> String {
        logs == 1 ? "1 dose you logged isn't on your Mac yet." : "\(logs) doses you logged aren't on your Mac yet."
    }
}
