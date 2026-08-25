@preconcurrency import CoreSpotlight
import Foundation
import Security
import UniformTypeIdentifiers

nonisolated private struct SearchAssistSnapshot: Decodable {
    struct Item: Decodable {
        let id: String
        let url: String
        let title: String
        let visitedAt: Double
    }

    let version: String
    let generatedAt: Double
    let items: [Item]
}

nonisolated enum SearchAssistStore {
    static let appGroup = "group.com.ttt246llc.wtm"
    private static let keychainGroup = "2858MX5336.com.ttt246llc.wtm.shared"
    private static let service = "com.ttt246llc.wtm.search-assist"
    private static let account = "assist-token"
    private static let defaults = UserDefaults(suiteName: appGroup)!

    static var baseURL: URL? {
        guard let value = defaults.string(forKey: "assistBaseURL") else { return nil }
        return URL(string: value)
    }

    static var token: String? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static var isEnabled: Bool { token != nil && baseURL != nil }
    static var snapshotVersion: String? { defaults.string(forKey: "assistSnapshotVersion") }

    static func configure(token: String, baseURL: String, force: Bool = false) throws {
        if defaults.bool(forKey: "assistDisabledInApp") && !force {
            throw NSError(domain: "SearchAssist", code: 5, userInfo: [NSLocalizedDescriptionKey: "disabled_in_app"])
        }
        guard token.hasPrefix("wtm_"),
              let url = URL(string: baseURL),
              url.scheme == "https" || url.host == "localhost" else {
            throw NSError(domain: "SearchAssist", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid Search Assist configuration."])
        }
        guard let data = token.data(using: .utf8) else { throw NSError(domain: "SearchAssist", code: 2) }
        SecItemDelete(keychainQuery as CFDictionary)
        var add = keychainQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        defaults.set(url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "assistBaseURL")
        defaults.removeObject(forKey: "assistDisabledInApp")
        defaults.removeObject(forKey: "assistLastError")
    }

    static func disable(nativeUserInitiated: Bool = false) {
        if nativeUserInitiated { defaults.set(true, forKey: "assistDisabledInApp") }
        SecItemDelete(keychainQuery as CFDictionary)
        defaults.removeObject(forKey: "assistBaseURL")
        defaults.removeObject(forKey: "assistSnapshotVersion")
        defaults.removeObject(forKey: "assistLastError")
        defaults.set(0, forKey: "assistIndexedCount")
    }

    static func record(version: String, count: Int) {
        defaults.set(version, forKey: "assistSnapshotVersion")
        defaults.set(count, forKey: "assistIndexedCount")
        defaults.set(Date().timeIntervalSince1970, forKey: "assistLastRefresh")
        defaults.removeObject(forKey: "assistLastError")
    }

    static func record(error: Error) {
        defaults.set(error.localizedDescription, forKey: "assistLastError")
    }

    static func recordCleared() {
        defaults.removeObject(forKey: "assistSnapshotVersion")
        defaults.set(0, forKey: "assistIndexedCount")
    }

    static func statusPayload() -> [String: Any] {
        var payload: [String: Any] = [
            "enabled": isEnabled,
            "indexedCount": defaults.integer(forKey: "assistIndexedCount")
        ]
        let refreshed = defaults.double(forKey: "assistLastRefresh")
        if refreshed > 0 { payload["lastRefresh"] = refreshed }
        if let error = defaults.string(forKey: "assistLastError") { payload["lastError"] = error }
        if let version = defaults.string(forKey: "assistSnapshotVersion") { payload["version"] = version }
        return payload
    }

    private static var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: keychainGroup
        ]
    }
}

nonisolated final class SearchAssistIndexer: @unchecked Sendable {
    static let shared = SearchAssistIndexer()
    static let domainIdentifier = "io.webtm.history"

    private let index = CSSearchableIndex(
        name: "WebTimeMachineHistory",
        protectionClass: .completeUntilFirstUserAuthentication
    )

    func refresh(completion: @escaping (Result<Int, Error>) -> Void) {
        guard let token = SearchAssistStore.token, let baseURL = SearchAssistStore.baseURL else {
            completion(.failure(NSError(domain: "SearchAssist", code: 3, userInfo: [NSLocalizedDescriptionKey: "Enable Search Assist from the Safari extension first."])))
            return
        }
        guard let endpoint = URL(string: "/index-snapshot?limit=2000", relativeTo: baseURL)?.absoluteURL else {
            completion(.failure(NSError(domain: "SearchAssist", code: 4)))
            return
        }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { self.finish(.failure(error), completion: completion); return }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                self.finish(.failure(NSError(domain: "SearchAssist", code: status, userInfo: [NSLocalizedDescriptionKey: "History index request failed (\(status))."])), completion: completion)
                return
            }
            do {
                let snapshot = try JSONDecoder().decode(SearchAssistSnapshot.self, from: data)
                let searchable = snapshot.items.compactMap(Self.searchableItem)
                if SearchAssistStore.snapshotVersion == snapshot.version {
                    SearchAssistStore.record(version: snapshot.version, count: searchable.count)
                    completion(.success(searchable.count))
                    return
                }
                self.replaceIndex(with: searchable) { result in
                    switch result {
                    case .success:
                        SearchAssistStore.record(version: snapshot.version, count: searchable.count)
                        completion(.success(searchable.count))
                    case .failure(let error):
                        SearchAssistStore.record(error: error)
                        completion(.failure(error))
                    }
                }
            } catch {
                self.finish(.failure(error), completion: completion)
            }
        }.resume()
    }

    func clear(completion: @escaping (Error?) -> Void) {
        index.deleteSearchableItems(withDomainIdentifiers: [Self.domainIdentifier]) { error in
            if error == nil { SearchAssistStore.recordCleared() }
            completion(error)
        }
    }

    private func replaceIndex(with items: [CSSearchableItem], completion: @escaping (Result<Void, Error>) -> Void) {
        index.deleteSearchableItems(withDomainIdentifiers: [Self.domainIdentifier]) { error in
            if let error { completion(.failure(error)); return }
            guard !items.isEmpty else { completion(.success(())); return }
            self.index.indexSearchableItems(items) { error in
                if let error { completion(.failure(error)) }
                else { completion(.success(())) }
            }
        }
    }

    private static func searchableItem(_ item: SearchAssistSnapshot.Item) -> CSSearchableItem? {
        guard let url = URL(string: item.url), url.scheme == "http" || url.scheme == "https" else { return nil }
        let attributes = CSSearchableItemAttributeSet(contentType: UTType.url)
        attributes.title = item.title.isEmpty ? item.url : item.title
        attributes.contentDescription = item.url
        attributes.contentURL = url
        attributes.keywords = [url.host ?? "", "Web Time Machine", "browsing history"]
        attributes.lastUsedDate = Date(timeIntervalSince1970: item.visitedAt / 1000)
        return CSSearchableItem(
            uniqueIdentifier: item.url,
            domainIdentifier: Self.domainIdentifier,
            attributeSet: attributes
        )
    }

    private func finish(_ result: Result<Int, Error>, completion: @escaping (Result<Int, Error>) -> Void) {
        if case .failure(let error) = result { SearchAssistStore.record(error: error) }
        completion(result)
    }
}
