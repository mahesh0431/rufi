import HealthKit
import SwiftUI

/// Rufi Seed: writes fictional heart data into the Simulator's Apple Health,
/// for trying Sync. Simulator only, never published; its own app, so no
/// write code is in Rufi.
@main
struct RufiSeedApp: App {
    var body: some Scene {
        WindowGroup { SeedView() }
    }
}

struct SeedView: View {
    @State private var said = "Fictional data, for this Simulator only."
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    button("Write a Week of Heart Data", "heart") { try await Seed.week() }
                    button("Rewrite Today's Resting Heart Rate", "arrow.clockwise") { try await Seed.rewriteToday() }
                } footer: {
                    Text("A week of heart rate every 10 minutes, with one day without its time zone, a workout's 100 readings as one condensed value, and a resting heart rate each day.")
                }
                Section {
                    button("Add a Value Too Large for Rufi", "exclamationmark.triangle") { try await Seed.tooLarge() }
                    button("Remove the Value Too Large", "trash") { try await Seed.removeTooLarge() }
                } footer: {
                    Text("One condensed value of 60,000 readings, larger than one batch: Sync stops at it until it is removed.")
                }
                Section {
                    Text(said).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Rufi Seed")
            .disabled(busy)
        }
    }

    private func button(_ title: String, _ symbol: String, _ step: @escaping () async throws -> String) -> some View {
        Button(title, systemImage: symbol) {
            busy = true
            Task {
                do { said = try await step() } catch { said = "Couldn't: \(error.localizedDescription)" }
                busy = false
            }
        }
    }
}

/// The fictional samples, each marked with the seed's own metadata so it
/// can find its own again.
enum Seed {
    private static let store = HKHealthStore()
    private static let heartRate = HKQuantityType(.heartRate)
    private static let resting = HKQuantityType(.restingHeartRate)
    private static let perMinute = HKUnit.count().unitDivided(by: .minute())
    private static let watch = HKDevice(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch",
                                        hardwareVersion: nil, firmwareVersion: nil, softwareVersion: nil,
                                        localIdentifier: nil, udiDeviceIdentifier: nil)
    private static let mark = "RufiSeed"
    private static let zone = "Asia/Kolkata"

    private static func allowed() async throws {
        try await store.requestAuthorization(toShare: [heartRate, resting], read: [])
    }

    private static func bpm(_ value: Double) -> HKQuantity { HKQuantity(unit: perMinute, doubleValue: value) }

    static func week() async throws -> String {
        try await allowed()
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        var samples: [HKObject] = []
        for day in 0..<7 {
            guard let start = calendar.date(byAdding: .day, value: -day, to: today) else { continue }
            // Day 3 is written without its time zone: it has no local day.
            var metadata: [String: Any] = [mark: "week"]
            if day != 3 { metadata[HKMetadataKeyTimeZone] = zone }
            for slot in 0..<144 {
                let at = start.addingTimeInterval(Double(slot) * 600)
                if at > .now { break }
                var reading = metadata
                reading[HKMetadataKeyHeartRateMotionContext] = slot % 12 == 0 ? 2 : 1
                let value = 62 + 14 * sin(Double(slot) / 144 * 2 * .pi) + Double((slot * 7 + day) % 5)
                samples.append(HKQuantitySample(type: heartRate, quantity: bpm(value.rounded()), start: at, end: at,
                                                device: watch, metadata: reading))
            }
            if day > 0 {
                samples.append(HKQuantitySample(type: resting, quantity: bpm(Double(56 + day % 4)), start: start,
                                                end: start.addingTimeInterval(86_399), device: watch,
                                                metadata: [mark: "resting", HKMetadataKeyTimeZone: zone]))
            }
        }
        try await store.save(samples)
        // Yesterday's run at 18:00: 100 readings, 5 seconds apart, as one condensed value.
        let run = calendar.date(byAdding: .hour, value: -6, to: today) ?? today
        let builder = HKQuantitySeriesSampleBuilder(healthStore: store, quantityType: heartRate, startDate: run, device: watch)
        for index in 0..<100 {
            let at = run.addingTimeInterval(Double(index) * 5)
            try builder.insert(bpm(Double(120 + index % 20)), for: DateInterval(start: at, duration: 5))
        }
        _ = try await builder.finishSeries(metadata: [mark: "run", HKMetadataKeyTimeZone: zone,
                                                       HKMetadataKeyHeartRateMotionContext: 2])
        _ = try await rewriteToday()
        return "Wrote a week of heart rate, a run of 100 readings and a resting heart rate each day."
    }

    /// Apple often replaces a day's first estimate: today's goes, a new one comes.
    static func rewriteToday() async throws -> String {
        try await allowed()
        let start = Calendar.current.startOfDay(for: .now)
        _ = try await store.deleteObjects(of: resting,
                                          predicate: HKQuery.predicateForObjects(withMetadataKey: mark, allowedValues: ["today"]))
        let value = Double(Int.random(in: 55...60))
        try await store.save(HKQuantitySample(type: resting, quantity: bpm(value), start: start, end: .now,
                                              device: watch, metadata: [mark: "today", HKMetadataKeyTimeZone: zone]))
        return "Today's resting heart rate is now \(Int(value))."
    }

    static func tooLarge() async throws -> String {
        try await allowed()
        let start = Calendar.current.date(byAdding: .day, value: -30, to: .now) ?? .now
        let builder = HKQuantitySeriesSampleBuilder(healthStore: store, quantityType: heartRate, startDate: start, device: watch)
        for index in 0..<60_000 {
            try builder.insert(bpm(Double(60 + index % 40)), for: DateInterval(start: start.addingTimeInterval(Double(index)), duration: 1))
        }
        _ = try await builder.finishSeries(metadata: [mark: "too-large"])
        return "Added one heart-rate value of 60,000 readings, from \(start.formatted(date: .abbreviated, time: .omitted))."
    }

    static func removeTooLarge() async throws -> String {
        try await allowed()
        let removed = try await store.deleteObjects(
            of: heartRate, predicate: HKQuery.predicateForObjects(withMetadataKey: mark, allowedValues: ["too-large"]))
        return "Removed \(removed) value\(removed == 1 ? "" : "s") too large."
    }
}
