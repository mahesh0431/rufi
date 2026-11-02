import SwiftUI

/// This iPhone › Apple Health: connect it, the latest resting heart rate
/// and heart rate, Sync for the paired person, and Read History Again.
struct HealthView: View {
    let health: HealthSync
    let person: String
    private let reader = HealthReader()

    /// Whether Rufi asked Apple Health already; unknown until read.
    @State private var asked: Bool?
    @State private var numbers: [HeartType: HealthReader.Latest] = [:]
    @State private var earliest: [HeartType: Date] = [:]
    @State private var readingAgain = false

    var body: some View {
        Form {
            if asked == false {
                Section {
                    Button("Connect Apple Health", systemImage: "heart") {
                        Task {
                            await reader.ask()
                            await read()
                        }
                    }
                } footer: {
                    Text("Rufi reads your heart rate and resting heart rate from Apple Health and keeps them on your Mac.")
                }
            } else if asked == true {
                Section {
                    ForEach(HeartType.allCases, id: \.self) { type in
                        LabeledContent(type.label, value: numbers[type].map { words($0, type) } ?? "–")
                    }
                } footer: {
                    Text(numbersFooter)
                }
                Section {
                    if case let .sending(type, readings) = health.state {
                        HStack {
                            ProgressView()
                            Text("Sending \(type.words)… \(readings.formatted())")
                                .padding(.leading, 6)
                            Spacer()
                            Button("Stop", systemImage: "stop.fill") { Task { await health.stop() } }
                                .labelStyle(.titleAndIcon)
                        }
                    } else {
                        Button("Sync for \(person)", systemImage: "arrow.triangle.2.circlepath") {
                            Task {
                                await health.sync().value
                                await read()
                            }
                        }
                    }
                } footer: {
                    Text(status)
                }
                Section {
                    Button("Read History Again", systemImage: "clock.arrow.circlepath") { readingAgain = true }
                        .disabled(health.running)
                        .confirmationDialog("Read History Again?", isPresented: $readingAgain, titleVisibility: .hidden) {
                            Button("Read History Again") {
                                Task {
                                    await health.readAgain()
                                    await health.sync().value
                                    await read()
                                }
                            }
                        } message: {
                            Text("Rufi reads all the heart data Apple Health lets it read and sends it to your Mac again. What your Mac has stays.")
                        }
                }
            }
        }
        .navigationTitle("Apple Health")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read() }
    }

    private func read() async {
        asked = await reader.asked()
        guard asked == true else { return }
        for type in HeartType.allCases {
            numbers[type] = await reader.latest(type)
            earliest[type] = await reader.earliest(type)
        }
    }

    /// "58 · today" for resting heart rate; "72 · 09:10" for a heart rate
    /// measured today; the date when it wasn't.
    private func words(_ latest: HealthReader.Latest, _ type: HeartType) -> String {
        let value = latest.value.formatted(.number.precision(.fractionLength(0...1)))
        let today = Calendar.current.isDateInToday(latest.at)
        let when = switch (type, today) {
        case (.restingHeartRate, true): "today"
        case (.restingHeartRate, false): latest.at.formatted(.dateTime.day().month(.abbreviated))
        case (.heartRate, true): latest.at.formatted(date: .omitted, time: .shortened)
        case (.heartRate, false): latest.at.formatted(.dateTime.day().month(.abbreviated).hour().minute())
        }
        return "\(value) · \(when)"
    }

    private var numbersFooter: String {
        if numbers.isEmpty {
            return "No heart data from Apple Health. To allow it: Settings › Health › Data Access & Devices › Rufi."
        }
        let limited = HeartType.allCases.compactMap { type in
            earliest[type].map {
                "Apple Health lets Rufi read \(type.words) from \($0.formatted(.dateTime.day().month(.abbreviated).year()))."
            }
        }
        if limited.isEmpty { return "From Apple Health." }
        return (["From Apple Health."] + limited + ["To allow more: Settings › Health › Data Access & Devices › Rufi."])
            .joined(separator: " ")
    }

    private var status: String {
        if case let .stopped(why) = health.state { return why }
        return health.last.map(HealthView.lastWords) ?? "Sync sends \(person)'s heart data to Rufi on your Mac."
    }

    /// "Last sent 09:14 · 5,752 readings", or "Last checked 09:14 · nothing new".
    static func lastWords(_ last: HealthMemory.Last) -> String {
        let when = Calendar.current.isDateInToday(last.at)
            ? last.at.formatted(date: .omitted, time: .shortened)
            : last.at.formatted(.dateTime.day().month(.abbreviated).hour().minute())
        return last.batches == 0
            ? "Last checked \(when) · nothing new"
            : "Last sent \(when) · \(last.readings.formatted()) \(last.readings == 1 ? "reading" : "readings")"
    }
}

extension HeartType {
    var label: String {
        switch self {
        case .restingHeartRate: "Resting heart rate"
        case .heartRate: "Heart rate"
        }
    }
}
