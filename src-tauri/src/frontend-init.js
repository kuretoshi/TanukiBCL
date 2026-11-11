(() => {
  const report = (message) => {
    window.__TAURI_INTERNALS__?.invoke('frontend_log', { message: String(message).slice(0, 8192) }).catch(() => {});
  };
  window.addEventListener('error', (event) => report(`${event.message}\n${event.error?.stack || ''}`));
  window.addEventListener('unhandledrejection', (event) => report(`Unhandled promise: ${event.reason?.stack || event.reason}`));
  window.addEventListener('securitypolicyviolation', (event) => report(`CSP: ${event.violatedDirective} ${event.blockedURI}`));
  window.addEventListener('DOMContentLoaded', () => report(JSON.stringify({
    ready: true, secureContext: window.isSecureContext,
    mediaDevices: !!navigator.mediaDevices, audioContext: typeof AudioContext, webRTC: typeof RTCPeerConnection,
  })));
})();
