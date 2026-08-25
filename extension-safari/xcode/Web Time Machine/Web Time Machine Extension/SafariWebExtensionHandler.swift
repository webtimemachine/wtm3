//
//  SafariWebExtensionHandler.swift
//  Web Time Machine Extension
//
//  Created by alex newman on 6/29/26.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received Search Assist native message (profile: %@)", profile?.uuidString ?? "none")
        guard let payload = message as? [String: Any], let type = payload["type"] as? String else {
            complete(context, ["ok": false, "error": "invalid_message"])
            return
        }

        switch type {
        case "configureSearchAssist":
            guard let token = payload["token"] as? String,
                  let baseURL = payload["baseUrl"] as? String else {
                complete(context, ["ok": false, "error": "missing_configuration"])
                return
            }
            do {
                try SearchAssistStore.configure(
                    token: token,
                    baseURL: baseURL,
                    force: payload["force"] as? Bool ?? false
                )
                SearchAssistIndexer.shared.refresh { result in
                    switch result {
                    case .success(let count): self.complete(context, ["ok": true, "indexedCount": count])
                    case .failure(let error): self.complete(context, ["ok": false, "error": error.localizedDescription])
                    }
                }
            } catch {
                complete(context, ["ok": false, "error": error.localizedDescription])
            }
        case "disableSearchAssist":
            SearchAssistStore.disable(nativeUserInitiated: false)
            SearchAssistIndexer.shared.clear { error in
                self.complete(context, error == nil
                    ? ["ok": true]
                    : ["ok": false, "error": error!.localizedDescription])
            }
        case "refreshSearchAssist":
            SearchAssistIndexer.shared.refresh { result in
                switch result {
                case .success(let count): self.complete(context, ["ok": true, "indexedCount": count])
                case .failure(let error): self.complete(context, ["ok": false, "error": error.localizedDescription])
                }
            }
        default:
            complete(context, ["ok": false, "error": "unknown_message"])
        }
    }

    private func complete(_ context: NSExtensionContext, _ message: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: message]
        } else {
            response.userInfo = ["message": message]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
