import Foundation
import HealthKit
import Testing
@testable import Rufi

/// What the Health reader makes of Apple's samples, without Apple Health
/// itself: samples made in memory, never saved or read from a store.
struct HealthReaderTests {
    private let perMinute = HKUnit.count().unitDivided(by: .minute())

    /// A quantity in a sample's metadata reaches the batch as its exact
    /// number and unit, as it came.
    @Test func sendsAQuantityInMetadataExactly() async throws {
        let at = Date(timeIntervalSince1970: 1_792_548_000)
        let sample = HKQuantitySample(
            type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: perMinute, doubleValue: 72),
            start: at, end: at,
            device: HKDevice(name: "Apple Watch", manufacturer: nil, model: nil, hardwareVersion: nil,
                             firmwareVersion: nil, softwareVersion: nil, localIdentifier: nil, udiDeviceIdentifier: nil),
            metadata: [HKMetadataKeyHeartRateEventThreshold: HKQuantity(unit: perMinute, doubleValue: 123.456789012345)])

        let value = try await HealthReader.value(of: sample, .heartRate)
        let body = Envelope.encode(batch: "b-1", values: [value], deleted: [])

        let sent = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let metadata = try #require((sent["values"] as? [[String: Any]])?.first?["metadata"] as? [String: Any])
        let threshold = try #require(metadata[HKMetadataKeyHeartRateEventThreshold] as? [String: Any])
        #expect(threshold["value"] as? Double == 123.456789012345)
        #expect(threshold["unit"] as? String == "count/min")
    }

    /// The latest heart rate of a workout's condensed sample is its last
    /// reading with its own time, never its average; when its readings
    /// can't be read, there is no number rather than the average.
    @Test func latestOfACondensedSampleIsItsLastReadingOrNothing() async {
        let start = Date(timeIntervalSince1970: 1_792_548_000)
        let readings = [
            HealthValue.Reading(start: start, end: start.addingTimeInterval(5), value: 110),
            HealthValue.Reading(start: start.addingTimeInterval(5), end: start.addingTimeInterval(10), value: 150),
        ]
        struct Locked: Error {}

        let read = await HealthReader.Latest.of(count: 2, value: 130, end: start.addingTimeInterval(10)) { readings }
        let unread = await HealthReader.Latest.of(count: 2, value: 130, end: start.addingTimeInterval(10)) {
            throw Locked()
        }
        let single = await HealthReader.Latest.of(count: 1, value: 64, end: start) { [] }

        #expect(read == .init(value: 150, at: start.addingTimeInterval(10)))
        #expect(unread == nil)
        #expect(single == .init(value: 64, at: start))
    }
}
