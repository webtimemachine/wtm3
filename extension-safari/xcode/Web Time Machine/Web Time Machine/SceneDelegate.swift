//
//  SceneDelegate.swift
//  Web Time Machine
//
//  Created by alex newman on 6/29/26.
//

import UIKit
import CoreSpotlight

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        if let activity = connectionOptions.userActivities.first {
            openSpotlightResult(activity)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        openSpotlightResult(userActivity)
    }

    private func openSpotlightResult(_ activity: NSUserActivity) {
        guard activity.activityType == CSSearchableItemActionType,
              let raw = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              let url = URL(string: raw),
              url.scheme == "http" || url.scheme == "https" else { return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url)
        }
    }

}
