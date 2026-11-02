import Foundation
import HealthKit

/// Rufi's reads of Apple Health, read only: Apple's own sheet to allow
/// them, one anchored page as one batch, the latest number of a type, and
/// how far back Apple Health lets Rufi read. It keeps nothing between calls.
nonisolated struct HealthReader: HealthReading {
    /// One per app, as Apple recommends.
    private static let store = HKHealthStore()
    private static let perMinute = HKUnit.count().unitDivided(by: .minute())

    /// A type's newest reading: a condensed sample's last, with its own time.
    struct Latest: Equatable, Sendable {
        let value: Double
        let at: Date
    }

    private var types: Set<HKObjectType> { Set(HeartType.allCases.map(\.quantityType)) }

    /// Whether Rufi asked Apple Health already; it never says what was allowed.
    func asked() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        let status = try? await Self.store.statusForAuthorizationRequest(toShare: [], read: types)
        return status == .unnecessary
    }

    /// Apple's own sheet for the heart types, read only. Whatever the
    /// person chose, it returns.
    func ask() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try? await Self.store.requestAuthorization(toShare: [], read: types)
    }

    func latest(_ type: HeartType) async -> Latest? {
        let newest = HKSampleQueryDescriptor(predicates: [.quantitySample(type: type.quantityType)],
                                             sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)], limit: 1)
        guard let sample = try? await newest.result(for: Self.store).first else { return nil }
        if sample.count > 1, let reading = try? await Self.readings(of: sample, type).last {
            return Latest(value: reading.value, at: reading.end)
        }
        return Latest(value: sample.quantity.doubleValue(for: Self.perMinute), at: sample.endDate)
    }

    /// The earliest date Apple Health lets Rufi read the type from, when the
    /// person allowed only recent history; none when it doesn't say.
    func earliest(_ type: HeartType) async -> Date? {
        try? await Self.store.earliestAuthorizedSampleDate(for: [type.quantityType])[type.quantityType]
    }

    @concurrent
    func page(_ type: HeartType, from anchor: Data?, limit: Int) async throws(HealthProblem) -> HealthPage {
        guard HKHealthStore.isHealthDataAvailable() else { throw .notAvailable }
        var bookmark: HKQueryAnchor?
        if let anchor {
            guard let read = try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: anchor)
            else { throw .badAnchor }
            bookmark = read
        }
        // Apple's limit counts added samples and deletions together.
        let query = HKAnchoredObjectQueryDescriptor(predicates: [.quantitySample(type: type.quantityType)],
                                                    anchor: bookmark, limit: limit)
        do {
            let result = try await query.result(for: Self.store)
            var values: [HealthValue] = []
            for sample in result.addedSamples {
                values.append(try await Self.value(of: sample, type))
            }
            let deleted = result.deletedObjects.map(\.uuid.uuidString)
            let body = Envelope.encode(batch: UUID().uuidString, values: values, deleted: deleted)
            let archived = try NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true)
            return HealthPage(body: body, values: values.count, entries: values.count + deleted.count,
                              anchor: archived, firstStart: values.first?.start)
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw .locked
        } catch let error as HKError where error.code == .errorHealthDataUnavailable {
            throw .notAvailable
        } catch {
            throw .failed
        }
    }

    private static func value(of sample: HKQuantitySample, _ type: HeartType) async throws -> HealthValue {
        let zone = (sample.metadata?[HKMetadataKeyTimeZone] as? String).flatMap(TimeZone.init(identifier:))
        let average = (sample as? HKDiscreteQuantitySample)?.averageQuantity ?? sample.quantity
        return HealthValue(id: sample.uuid.uuidString, type: type,
                           value: average.doubleValue(for: perMinute),
                           start: sample.startDate, end: sample.endDate, timeZone: zone,
                           device: sample.device?.name ?? sample.sourceRevision.source.name,
                           readings: sample.count > 1 ? try await readings(of: sample, type) : [],
                           metadata: (sample.metadata ?? [:]).compactMapValues(metadatum))
    }

    /// A condensed sample's readings, each with its own time, in order.
    private static func readings(of sample: HKQuantitySample, _ type: HeartType) async throws -> [HealthValue.Reading] {
        let query = HKQuantitySeriesSampleQueryDescriptor(
            predicate: .quantitySample(type: type.quantityType, predicate: HKQuery.predicateForObject(with: sample.uuid)),
            options: .orderByQuantitySampleStartDate)
        var readings: [HealthValue.Reading] = []
        for try await reading in query.results(for: store) {
            readings.append(.init(start: reading.dateInterval.start, end: reading.dateInterval.end,
                                  value: reading.quantity.doubleValue(for: perMinute)))
        }
        return readings
    }

    /// A metadata value as Apple gives it; a kind Rufi can't send is left out.
    private static func metadatum(_ value: Any) -> Metadatum? {
        switch value {
        case let text as String:
            return .text(text)
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? .flag(number.boolValue) : .number(number.doubleValue)
        case let date as Date:
            return .text(Envelope.instant(date))
        case let quantity as HKQuantity:
            // Apple writes a quantity as its value and unit: "120 count/min".
            let parts = quantity.description.split(separator: " ", maxSplits: 1)
            guard parts.count == 2, let number = Double(parts[0]) else { return .text(quantity.description) }
            return .quantity(number, String(parts[1]))
        default:
            return nil
        }
    }
}

extension HeartType {
    nonisolated var quantityType: HKQuantityType {
        HKQuantityType(HKQuantityTypeIdentifier(rawValue: rawValue))
    }
}
