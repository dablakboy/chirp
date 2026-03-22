# Chirp — Walkie-Talkie App

A real-time push-to-talk walkie-talkie app modeled after the Nextel "chirp" experience. Connect with anyone on the same network over cellular, WiFi, or Bluetooth.

## Features

- **Hold-to-Talk**: Press and hold the center button to transmit audio in real time
- **3 Button States**: Idle, Transmitting (outgoing), Receiving (incoming)
- **Auto Call Sign**: Each device gets a persistent random call sign (e.g. `KV-4821`)
- **Live Presence**: See who's online in the "ON AIR" section
- **Chirp Sounds**: Nextel-style chirp sounds on transmit/receive
- **Haptic Feedback**: Heavy impact on press, medium on release
- **Auto-Reconnect**: WebSocket reconnects automatically on disconnect

## Design

- Colors: Dark red/burgundy `#7C1A1A`, yellow `#F5C518`, black, white
- Clean white background with the button as the centered focal point
- Pulse animation when transmitting, ripple ring when receiving
- Monospace typography for the radio/military aesthetic

## Architecture

### Frontend (`mobile/`)
- Expo SDK 53, React Native 0.76.7
- Single-screen app (`src/app/(tabs)/index.tsx`)
- `expo-av` for audio recording (800ms chunks) and playback
- `expo-file-system` for audio chunk I/O
- `react-native-reanimated` for button animations
- WebSocket connection to backend for real-time relay
- `AsyncStorage` for persisting user identity

### Backend (`backend/`)
- Bun + Hono HTTP server on port 3000
- Native Bun WebSocket at `/ws`
- In-memory client map for presence tracking
- Audio relay: broadcasts chunks to all other connected clients

## WebSocket Protocol

**Connect**: `wss://<backend>/ws?userId=<id>&username=<callsign>`

**Client → Server:**
| Type | Description |
|------|-------------|
| `startTalk` | User pressed the button |
| `stopTalk` | User released the button |
| `audio` | Base64-encoded M4A audio chunk |
| `ping` | Keepalive ping |

**Server → Client:**
| Type | Description |
|------|-------------|
| `userList` | Full list of connected users (on connect) |
| `userJoined` | Another user connected |
| `userLeft` | A user disconnected |
| `startTalk` | Another user started transmitting |
| `stopTalk` | Another user stopped transmitting |
| `audio` | Relayed audio chunk from another user |
| `pong` | Response to ping |

## Default Channel

All users connect to Channel 1 by default. A channels system with named/numbered channels will be added in a future update.
