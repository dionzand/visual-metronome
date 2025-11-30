## What's New in v2.0.0

### 🎵 Click Track Feature
- **Synchronized audio click track** - Audio metronome clicks play on all connected client devices
- **Server-side volume control** - Adjust click volume for all clients from the main app
- **Client-side controls** - Each client can individually adjust volume and delay
- **Manual delay adjustment** - Fine-tune click timing with 1ms precision to compensate for network/audio latency
- **Accent patterns** - First beat and accented beats use higher-pitched clicks
- **Subdivision support** - Clicks for 8th notes, 16th notes, triplets, quintuplets, and sextuplets

### 🌐 Network Detection & Smart Warnings
- **Automatic network detection** - Detects Public/Private/Domain network profiles
- **Client isolation warnings** - Alerts when on public WiFi with device-to-device blocking
- **Firewall detection** - Tests server reachability and warns about potential firewall issues
- **Port fallback** - Automatically tries alternative ports (3001, 3002, 8080, 8000, 5000) if default port unavailable
- **Solution suggestions** - Provides step-by-step instructions for WiFi hotspot setup and network profile changes

### 🎨 UI Improvements
- **Better spacing** - Added spacing between tempo slider and playback buttons for improved readability
- **Reorganized sections** - Click Track Settings moved below Playback Control for better logical flow
- **Loading indicator** - Animated loading spinner during server startup with context-aware messages

### 🔧 Bug Fixes
- **Fixed accent beat timing** - Simplified timing model for accurate accent placement on first beat
- **Fixed click track stop issue** - Click track now properly stops when playback is paused/stopped
- **Fixed volume control** - Client-side volume slider now works correctly
- **Fixed sync adjustment** - Manual delay adjustment now properly affects click timing

### 🔒 Security Improvements
- **Removed tunnel feature** - Eliminated LocalTunnel functionality due to security risks of public internet exposure
- Network detection provides safer alternatives (WiFi hotspot, network profile changes)

### 📝 Documentation
- Updated README with comprehensive click track documentation
- Added network detection and troubleshooting sections
- Expanded feature descriptions and usage examples

## Installation

1. Download `Visual Metronome 2.0.0.exe`
2. Run the executable (Windows may show SmartScreen warning - click "More info" → "Run anyway")
3. Start creating synchronized metronome scores!

## Full Changelog

See the [README](https://github.com/dionzand/visual-metronome/blob/main/README.md) for complete documentation and usage guide.
