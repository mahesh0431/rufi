import Foundation
import Testing
@testable import Rufi

/// A page of Apple Health encodes to the batch Rufi on the Mac converts: the
/// golden batch, which the server's tests receive and convert too.
struct EnvelopeTests {
    @Test func encodesTheGoldenBatch() throws {
        let golden = try Data(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "../../server/tests/fixtures/device/phone-batch.json"))
        let india = try #require(TimeZone(identifier: "Asia/Kolkata"))
        let values = [
            HealthValue(id: "A5E1C0DE-0001-4000-8000-000000000001", type: .heartRate, value: 64,
                        start: at("2026-10-21T01:30:00.000Z"), end: at("2026-10-21T01:30:00.000Z"),
                        timeZone: india, device: "Apple Watch", readings: [],
                        metadata: ["HKMetadataKeyHeartRateMotionContext": .number(1),
                                   "HKMetadataKeyTimeZone": .text("Asia/Kolkata")]),
            // No time zone in Apple Health: none is sent, not the phone's own.
            HealthValue(id: "A5E1C0DE-0002-4000-8000-000000000002", type: .heartRate, value: 71.5,
                        start: at("2026-10-21T04:12:30.250Z"), end: at("2026-10-21T04:12:30.250Z"),
                        timeZone: nil, device: "Apple Watch", readings: [],
                        metadata: ["HKMetadataKeyHeartRateMotionContext": .number(0)]),
            // A workout's condensed sample: its average, and each reading.
            HealthValue(id: "A5E1C0DE-0003-4000-8000-000000000003", type: .heartRate, value: 120,
                        start: at("2026-10-21T12:00:00.000Z"), end: at("2026-10-21T12:00:15.000Z"),
                        timeZone: india, device: "Apple Watch",
                        readings: [
                            .init(start: at("2026-10-21T12:00:00.000Z"), end: at("2026-10-21T12:00:05.000Z"), value: 115),
                            .init(start: at("2026-10-21T12:00:05.000Z"), end: at("2026-10-21T12:00:10.000Z"), value: 125),
                            .init(start: at("2026-10-21T12:00:10.000Z"), end: at("2026-10-21T12:00:15.000Z"), value: 120),
                        ],
                        metadata: ["HKMetadataKeyHeartRateMotionContext": .number(2),
                                   "HKMetadataKeyTimeZone": .text("Asia/Kolkata")]),
        ]

        let body = Envelope.encode(batch: "6F1C2B7E-4A0D-4C55-9E21-3B8A90D1C001", values: values,
                                   deleted: ["A5E1C0DE-0099-4000-8000-000000000099"])

        let sent = try JSONSerialization.jsonObject(with: body) as? NSDictionary
        let expected = try JSONSerialization.jsonObject(with: golden) as? NSDictionary
        #expect(sent == expected)
    }

    private func at(_ text: String) -> Date {
        try! Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
