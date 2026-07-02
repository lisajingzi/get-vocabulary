/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // `ws` uses optional native addons (`bufferutil`, `utf-8-validate`) for
    // fast frame masking. When webpack bundles `ws` for the server runtime it
    // silently drops those addons, causing `bufferUtil.mask is not a function`
    // at the very first `ws.send()`. Marking these as external forces Node to
    // `require()` them at runtime, where the native modules resolve correctly.
    // Used by /api/tts (Edge Neural TTS over WebSocket).
    serverComponentsExternalPackages: ["ws", "bufferutil", "utf-8-validate"],
  },
};

export default nextConfig;
