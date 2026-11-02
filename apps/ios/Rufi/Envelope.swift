import Foundation

/// The heart types Rufi reads from Apple Health, in the order a sync sends
/// them. Only types on Rufi's own list (`core/devices/types.ts` on the Mac).
nonisolated enum HeartType: String, CaseIterable, Sendable {
    case restingHeartRate = "HKQuantityTypeIdentifierRestingHeartRate"
    case heartRate = "HKQuantityTypeIdentifierHeartRate"

    /// As a sentence names it: "a heart-rate value".
    var valueWords: String {
        switch self {
        case .restingHeartRate: "resting heart rate value"
        case .heartRate: "heart-rate value"
        }
    }

    /// As a status line names it while sending: "Sending heart rate…".
    var words: String {
        switch self {
        case .restingHeartRate: "resting heart rate"
        case .heartRate: "heart rate"
        }
    }
}

/// One value read from Apple Health, as plain data: no HealthKit here.
nonisolated struct HealthValue: Sendable {
    /// One reading of a condensed sample, with its own time.
    struct Reading: Sendable {
        let start: Date
        let end: Date
        let value: Double
    }

    /// Apple's own ID for the sample.
    let id: String
    let type: HeartType
    /// In beats per minute (count/min); a condensed sample's average.
    let value: Double
    let start: Date
    let end: Date
    /// Where it was measured, only when Apple Health says (its time zone
    /// metadata); never the phone's current zone.
    let timeZone: TimeZone?
    let device: String?
    /// A condensed sample's readings; empty for a single one.
    let readings: [Reading]
    let metadata: [String: Metadatum]
}

/// A metadata value as Apple gives it: text, a number, a yes or no, a date
/// (as UTC text) or a quantity (its value and unit).
nonisolated enum Metadatum: Encodable, Sendable {
    case text(String)
    case number(Double)
    case flag(Bool)
    case quantity(Double, String)

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .text(text): try container.encode(text)
        case let .number(number): try container.encode(number)
        case let .flag(flag): try container.encode(flag)
        case let .quantity(value, unit): try container.encode(Quantity(value: value, unit: unit))
        }
    }

    private struct Quantity: Encodable {
        let value: Double
        let unit: String
    }
}

/// One page of Apple Health as the batch Rufi on the Mac receives
/// (`core/devices/devices.ts`): a batch ID, the values and the IDs taken
/// back. Times are UTC; `utc_offset` and `time_zone` only when Apple
/// Health gave the sample's time zone; `count` and `series` only for a
/// condensed sample. The golden batch (`apps/server/tests/fixtures/device/
/// phone-batch.json`) is its example on both sides.
nonisolated enum Envelope {
    static func encode(batch: String, values: [HealthValue], deleted: [String]) -> Data {
        let envelope = Batch(batch: batch, values: values.map(Value.init), deleted: deleted.map(Deleted.init))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Plain values only: encoding can't fail.
        return (try? encoder.encode(envelope)) ?? Data()
    }

    static func instant(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    private struct Batch: Encodable {
        let batch: String
        let values: [Value]
        let deleted: [Deleted]
    }

    private struct Deleted: Encodable {
        let id: String
    }

    private struct Part: Encodable {
        let start: String
        let end: String
        let value: Double
    }

    private struct Value: Encodable {
        let id: String
        let type: String
        let value: Double
        let unit = "count/min"
        let start: String
        let end: String
        let utc_offset: Int?
        let time_zone: String?
        let device: String?
        let count: Int?
        let series: [Part]?
        let metadata: [String: Metadatum]?

        init(_ value: HealthValue) {
            id = value.id
            type = value.type.rawValue
            self.value = value.value
            start = Envelope.instant(value.start)
            end = Envelope.instant(value.end)
            utc_offset = value.timeZone.map { $0.secondsFromGMT(for: value.start) / 60 }
            time_zone = value.timeZone?.identifier
            device = value.device
            let condensed = value.readings.count > 1
            count = condensed ? value.readings.count : nil
            series = condensed
                ? value.readings.map { Part(start: Envelope.instant($0.start), end: Envelope.instant($0.end), value: $0.value) }
                : nil
            metadata = value.metadata.isEmpty ? nil : value.metadata
        }
    }
}
