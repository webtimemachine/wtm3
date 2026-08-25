//
//  ViewController.swift
//  Web Time Machine
//
//  Created by alex newman on 6/29/26.
//

import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.scrollView.isScrollEnabled = false

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        sendStatus()
        guard SearchAssistStore.isEnabled else { return }
        SearchAssistIndexer.shared.refresh { _ in
            DispatchQueue.main.async { self.sendStatus() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        sendStatus()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let action = message.body as? String else { return }
        switch action {
        case "refresh":
            SearchAssistIndexer.shared.refresh { _ in
                DispatchQueue.main.async { self.sendStatus() }
            }
        case "clear":
            SearchAssistIndexer.shared.clear { _ in
                DispatchQueue.main.async { self.sendStatus() }
            }
        case "disable":
            SearchAssistStore.disable(nativeUserInitiated: true)
            SearchAssistIndexer.shared.clear { _ in
                DispatchQueue.main.async { self.sendStatus() }
            }
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        default:
            break
        }
    }

    private func sendStatus() {
        guard webView != nil,
              let data = try? JSONSerialization.data(withJSONObject: SearchAssistStore.statusPayload()),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.wtmStatus(\(json))")
    }

}
