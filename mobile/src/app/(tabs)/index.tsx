import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  Platform,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePermissions, useStateLabel } from '../../hooks/usePermissions';
import PermissionScreen from '../../components/PermissionScreen';

// suppress unused import warning — expo-location is used via usePermissions hook
void Location;

// ─── WebRTC availability detection ────────────────────────────────────────────
// In production builds (EAS / pod install), react-native-webrtc is compiled in.
// In sandbox / Expo Go builds the native module is absent — we fall back to
// expo-av recording + WebSocket audio relay automatically.

let RTCPeerConnectionClass: any = null;
let RTCSessionDescriptionClass: any = null;
let RTCIceCandidateClass: any = null;
let mediaDevicesAPI: any = null;

try {
  const webrtc = require('react-native-webrtc');
  if (webrtc.RTCPeerConnection && webrtc.mediaDevices) {
    RTCPeerConnectionClass = webrtc.RTCPeerConnection;
    RTCSessionDescriptionClass = webrtc.RTCSessionDescription;
    RTCIceCandidateClass = webrtc.RTCIceCandidate;
    mediaDevicesAPI = webrtc.mediaDevices;
  }
} catch (_) {}

const WEBRTC_AVAILABLE = !!RTCPeerConnectionClass;
console.log('[Transport] WebRTC available:', WEBRTC_AVAILABLE);

// ─── Constants ────────────────────────────────────────────────────────────────

const BURGUNDY = '#7C1A1A';
const YELLOW = '#F5C518';
const BLACK = '#0A0A0A';
const WHITE = '#FFFFFF';
const GRAY = '#888888';
const LIGHT_GRAY = '#F0F0F0';

const STUN_ONLY: any[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];


type ButtonState = 'idle' | 'transmitting' | 'receiving';

interface User {
  userId: string;
  username: string;
  location?: string;
}

// ─── Images ───────────────────────────────────────────────────────────────────

const IMAGES = {
  idle: require('../../../assets/images/talk_inactive.png'),
  transmitting: require('../../../assets/images/talk_outgoing.png'),
  receiving: require('../../../assets/images/talk_incoming.png'),
};

// ─── Utility ──────────────────────────────────────────────────────────────────

function generateUserId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function generateCallSign(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTVWXYZ';
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${l1}${l2}-${num}`;
}

// ─── Audio Manager (chirp sounds only) ────────────────────────────────────────

let chirpInSound: Audio.Sound | null = null;
let chirpOutSound: Audio.Sound | null = null;

async function configureAudioSession() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      playThroughEarpieceAndroid: false,
      shouldDuckAndroid: false,
    });
  } catch (e) {
    console.log('[Audio] Could not configure audio session:', e);
  }
}

async function loadChirpSounds() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      playThroughEarpieceAndroid: false,
      shouldDuckAndroid: false,
    });
    const { sound: inSound } = await Audio.Sound.createAsync(
      require('../../../assets/audio/inbound.mp3'),
      { shouldPlay: false, volume: 1.0 }
    );
    chirpInSound = inSound;
    const { sound: outSound } = await Audio.Sound.createAsync(
      require('../../../assets/audio/outbound.mp3'),
      { shouldPlay: false, volume: 1.0 }
    );
    chirpOutSound = outSound;
  } catch (e) {
    console.log('[Audio] Could not load chirp sounds:', e);
  }
}

async function playChirpIn() {
  try {
    if (chirpInSound) {
      await chirpInSound.setPositionAsync(0);
      await chirpInSound.playAsync();
    }
  } catch (_) {}
}

async function playChirpOut() {
  try {
    if (chirpOutSound) {
      await chirpOutSound.setPositionAsync(0);
      await chirpOutSound.playAsync();
    }
  } catch (_) {}
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ChirpScreen() {
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
  const isTablet = SCREEN_WIDTH >= 768;
  const BTN_SIZE = Math.min(SCREEN_WIDTH * (isTablet ? 0.35 : 0.72), isTablet ? 320 : 300);

  const [buttonState, setButtonState] = useState<ButtonState>('idle');
  const [connectedUsers, setConnectedUsers] = useState<User[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [myUserId, setMyUserId] = useState<string>('');
  const [myUsername, setMyUsername] = useState<string>('');
  const [talkingUser, setTalkingUser] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonStateRef = useRef<ButtonState>('idle');

  // WebRTC refs (used only when WEBRTC_AVAILABLE)
  const localStreamRef = useRef<any>(null);
  const peerConnectionsRef = useRef<Map<string, any>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, any[]>>(new Map());
  const iceServersRef = useRef<any[]>(STUN_ONLY);

  // expo-av fallback refs (used only when !WEBRTC_AVAILABLE)
  const recordingRef = useRef<Audio.Recording | null>(null);

  // Inactivity tracking: replay inbound chirp if > 10s since last activity
  const lastActivityRef = useRef<number>(0);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Location ref to avoid re-creating WebSocket when location resolves
  const locationRef = useRef<string | null>(null);
  // Heartbeat interval to keep WebSocket alive through production proxies
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Permissions ───────────────────────────────────────────────────────────

  const {
    micGranted,
    locationGranted,
    micDenied,
    locationDenied,
    requesting,
    hasRequested,
    requestAll,
  } = usePermissions();

  const stateLabel = useStateLabel(locationGranted);

  // Keep locationRef in sync so connectWs can read it without being in the deps
  useEffect(() => {
    locationRef.current = stateLabel ?? null;
  }, [stateLabel]);

  // ─── Animations ────────────────────────────────────────────────────────────

  const pulseScale = useRef(new Animated.Value(1));
  const pulseOpacity = useRef(new Animated.Value(0));
  const buttonScale = useRef(new Animated.Value(1));
  const dotOpacity = useRef(new Animated.Value(1));
  const dotLoopAnim = useRef<Animated.CompositeAnimation | null>(null);
  const pulseLoopAnim = useRef<Animated.CompositeAnimation | null>(null);
  const pulseOpacityLoopAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    dotLoopAnim.current = Animated.loop(
      Animated.sequence([
        Animated.timing(dotOpacity.current, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(dotOpacity.current, { toValue: 0.2, duration: 800, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    dotLoopAnim.current.start();
    return () => { dotLoopAnim.current?.stop(); };
  }, []);

  useEffect(() => {
    buttonStateRef.current = buttonState;
    if (buttonState === 'transmitting') {
      buttonScale.current.stopAnimation();
      Animated.timing(buttonScale.current, { toValue: 1.0, duration: 80, useNativeDriver: Platform.OS !== 'web' }).start();
      pulseOpacity.current.setValue(0);
      pulseLoopAnim.current?.stop();
      pulseOpacityLoopAnim.current?.stop();
    } else if (buttonState === 'receiving') {
      buttonScale.current.stopAnimation();
      Animated.spring(buttonScale.current, { toValue: 1.0, useNativeDriver: Platform.OS !== 'web' }).start();
      pulseScale.current.setValue(1);
      pulseOpacity.current.setValue(0.5);
      pulseLoopAnim.current = Animated.loop(
        Animated.timing(pulseScale.current, { toValue: 1.35, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' })
      );
      pulseLoopAnim.current.start();
      pulseOpacityLoopAnim.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseOpacity.current, { toValue: 0.5, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(pulseOpacity.current, { toValue: 0, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        ])
      );
      pulseOpacityLoopAnim.current.start();
    } else {
      buttonScale.current.stopAnimation();
      pulseLoopAnim.current?.stop();
      pulseOpacityLoopAnim.current?.stop();
      Animated.spring(buttonScale.current, { toValue: 1.0, useNativeDriver: Platform.OS !== 'web' }).start();
      Animated.timing(pulseOpacity.current, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [buttonState]);

  const buttonAnimStyle = { transform: [{ scale: buttonScale.current }] };
  const pulseAnimStyle = { transform: [{ scale: pulseScale.current }], opacity: pulseOpacity.current };
  const dotAnimStyle = { opacity: dotOpacity.current };

  // ─── Init user identity ───────────────────────────────────────────────────

  const fetchIceServers = useCallback(async () => {
    try {
      const baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL!;
      const res = await fetch(`${baseUrl}/api/turn-credentials`);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data) && json.data.length > 0) {
          iceServersRef.current = json.data;
          console.log('[WebRTC] ICE servers loaded from backend:', json.data.length);
        }
      }
    } catch (e) {
      console.log('[WebRTC] Could not fetch ICE servers, using STUN only:', e);
    }
  }, []);

  useEffect(() => {
    async function initUser() {
      let uid = await AsyncStorage.getItem('chirp_userId');
      let uname = await AsyncStorage.getItem('chirp_username');
      if (!uid) {
        uid = generateUserId();
        await AsyncStorage.setItem('chirp_userId', uid);
      }
      if (!uname) {
        uname = generateCallSign();
        await AsyncStorage.setItem('chirp_username', uname);
      }
      setMyUserId(uid);
      setMyUsername(uname);
    }
    initUser();
    configureAudioSession();
    loadChirpSounds();
    if (WEBRTC_AVAILABLE) fetchIceServers();
  }, [fetchIceServers]);

  // ─── WebRTC helpers (production builds only) ──────────────────────────────

  const initLocalStream = useCallback(async () => {
    if (!WEBRTC_AVAILABLE || localStreamRef.current) return;
    try {
      const stream = await mediaDevicesAPI.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        } as any,
        video: false,
      });
      stream.getAudioTracks().forEach((t: any) => { t.enabled = false; });
      localStreamRef.current = stream;
      console.log('[WebRTC] Local stream ready');
    } catch (e) {
      console.log('[WebRTC] getUserMedia error:', e);
    }
  }, []);

  const createPeerConnection = useCallback((remoteUserId: string): any => {
    const pc = new RTCPeerConnectionClass({ iceServers: iceServersRef.current, iceCandidatePoolSize: 10 });

    localStreamRef.current?.getTracks().forEach((track: any) => {
      pc.addTrack(track, localStreamRef.current);
    });

    pc.addEventListener('icecandidate', (event: any) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'webrtc-ice-candidate',
          toUserId: remoteUserId,
          candidate: event.candidate,
        }));
      }
    });

    pc.addEventListener('track', (_event: any) => {
      console.log('[WebRTC] Remote track received from', remoteUserId);
    });

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      console.log('[WebRTC] Connection state with', remoteUserId, ':', state);
      if (state === 'connected') {
        const senders: any[] = pc.getSenders?.() ?? [];
        for (const sender of senders) {
          if (sender?.track?.kind === 'audio') {
            const params = sender.getParameters?.();
            if (params && Array.isArray(params.encodings) && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = 32000;
              params.encodings[0].minBitrate = 16000;
              sender.setParameters?.(params).catch(() => {});
            }
          }
        }
      }
      if (state === 'failed') {
        pc.close();
        peerConnectionsRef.current.delete(remoteUserId);
        pendingCandidatesRef.current.delete(remoteUserId);
      }
    });

    peerConnectionsRef.current.set(remoteUserId, pc);
    return pc;
  }, []);

  const closePeerConnection = useCallback((remoteUserId: string) => {
    const pc = peerConnectionsRef.current.get(remoteUserId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(remoteUserId);
    }
    pendingCandidatesRef.current.delete(remoteUserId);
  }, []);

  // ─── WebSocket ────────────────────────────────────────────────────────────

  const connectWs = useCallback(() => {
    if (!myUserId || !myUsername) return;
    const base = (process.env.EXPO_PUBLIC_BACKEND_URL ?? '')
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');
    const locationParam = locationRef.current ? `&location=${encodeURIComponent(locationRef.current)}` : '';
    const url = `${base}/ws?userId=${encodeURIComponent(myUserId)}&username=${encodeURIComponent(myUsername)}${locationParam}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = async () => {
      setIsConnected(true);
      console.log('[WS] Connected');
      // Send location immediately if already resolved
      if (locationRef.current) {
        try { ws.send(JSON.stringify({ type: 'updateLocation', location: locationRef.current })); } catch (_) {}
      }
      if (WEBRTC_AVAILABLE) await initLocalStream();
      // Heartbeat: ping every 25s to keep connection alive through Railway/production proxies
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
        }
      }, 25000);
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      console.log('[WS] Disconnected. Reconnecting in 3s...');
      reconnectTimeoutRef.current = setTimeout(() => {
        if (wsRef.current === ws) connectWs();
      }, 3000);
    };

    ws.onerror = (e) => {
      console.log('[WS] Error:', e);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string) as any;

        if (msg.type === 'userList') {
          setConnectedUsers((msg.users ?? []).map((u: any) => ({
            userId: u.userId,
            username: u.username,
            location: u.location,
          })));
        } else if (msg.type === 'userJoined') {
          setConnectedUsers((prev) => {
            if (prev.find((u) => u.userId === msg.userId)) return prev;
            return [...prev, { userId: msg.userId ?? '', username: msg.username ?? '', location: msg.location }];
          });
          if (WEBRTC_AVAILABLE) {
            await initLocalStream();
            await fetchIceServers();
            const pc = createPeerConnection(msg.userId);
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'webrtc-offer',
                toUserId: msg.userId,
                sdp: pc.localDescription,
              }));
            }
          }
        } else if (msg.type === 'userLeft') {
          setConnectedUsers((prev) => prev.filter((u) => u.userId !== msg.userId));
          if (WEBRTC_AVAILABLE) closePeerConnection(msg.userId);
          if (buttonStateRef.current === 'receiving') {
            setButtonState('idle');
            setTalkingUser(null);
          }
        } else if (msg.type === 'locationUpdate') {
          setConnectedUsers((prev) => prev.map((u) =>
            u.userId === msg.userId ? { ...u, location: msg.location } : u
          ));
        } else if (msg.type === 'startTalk') {
          if (buttonStateRef.current !== 'transmitting') {
            setButtonState('receiving');
            setTalkingUser(msg.username ?? null);
            const now = Date.now();
            const elapsed = now - lastActivityRef.current;
            if (lastActivityRef.current === 0 || elapsed > 10000) {
              playChirpIn();
            }
            lastActivityRef.current = now;
            if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
            inactivityTimerRef.current = setTimeout(() => {
              lastActivityRef.current = 0;
            }, 10000);
          }
        } else if (msg.type === 'stopTalk') {
          if (buttonStateRef.current === 'receiving') {
            setButtonState('idle');
            setTalkingUser(null);
          }
        } else if (msg.type === 'audio' && !WEBRTC_AVAILABLE) {
          // expo-av fallback: play received audio blob
          try {
            const tempUri = `${FileSystem.cacheDirectory}recv_${Date.now()}.m4a`;
            await FileSystem.writeAsStringAsync(tempUri, msg.data, {
              encoding: FileSystem.EncodingType.Base64,
            });
            await Audio.setAudioModeAsync({
              allowsRecordingIOS: false,
              playsInSilentModeIOS: true,
              staysActiveInBackground: true,
              playThroughEarpieceAndroid: false,
            });
            const { sound } = await Audio.Sound.createAsync(
              { uri: tempUri },
              { shouldPlay: true, volume: 1.0 }
            );
            sound.setOnPlaybackStatusUpdate((status: any) => {
              if (status.isLoaded && status.didJustFinish) {
                sound.unloadAsync().catch(() => {});
                FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
              }
            });
          } catch (e) {
            console.log('[Audio] Playback error:', e);
          }
        } else if (WEBRTC_AVAILABLE) {
          // WebRTC signaling messages
          if (msg.type === 'webrtc-offer') {
            await initLocalStream();
            await fetchIceServers();
            let pc = peerConnectionsRef.current.get(msg.fromUserId);
            if (!pc) pc = createPeerConnection(msg.fromUserId);
            await pc.setRemoteDescription(new RTCSessionDescriptionClass(msg.sdp));
            const pending = pendingCandidatesRef.current.get(msg.fromUserId) ?? [];
            for (const c of pending) await pc.addIceCandidate(c);
            pendingCandidatesRef.current.delete(msg.fromUserId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'webrtc-answer',
                toUserId: msg.fromUserId,
                sdp: pc.localDescription,
              }));
            }
          } else if (msg.type === 'webrtc-answer') {
            const pc = peerConnectionsRef.current.get(msg.fromUserId);
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescriptionClass(msg.sdp));
              const pending = pendingCandidatesRef.current.get(msg.fromUserId) ?? [];
              for (const c of pending) await pc.addIceCandidate(c);
              pendingCandidatesRef.current.delete(msg.fromUserId);
            }
          } else if (msg.type === 'webrtc-ice-candidate') {
            const pc = peerConnectionsRef.current.get(msg.fromUserId);
            const candidate = new RTCIceCandidateClass(msg.candidate);
            if (pc && pc.remoteDescription) {
              await pc.addIceCandidate(candidate);
            } else {
              const arr = pendingCandidatesRef.current.get(msg.fromUserId) ?? [];
              arr.push(candidate);
              pendingCandidatesRef.current.set(msg.fromUserId, arr);
            }
          }
        }
      } catch (e) {
        console.log('[WS] Message error:', e);
      }
    };
  }, [myUserId, myUsername, createPeerConnection, closePeerConnection, initLocalStream, fetchIceServers]);

  // Only connect WebSocket once mic is granted
  useEffect(() => {
    if (myUserId && myUsername && micGranted) {
      connectWs();
    }
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (WEBRTC_AVAILABLE) {
        peerConnectionsRef.current.forEach((pc) => pc.close());
        peerConnectionsRef.current.clear();
        localStreamRef.current?.getTracks().forEach((t: any) => t.stop());
        localStreamRef.current = null;
      } else {
        recordingRef.current?.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent stale reconnect from firing
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [myUserId, myUsername, micGranted, connectWs]);

  // Send location update over WS when stateLabel resolves (without reconnecting)
  useEffect(() => {
    if (!stateLabel) return;
    locationRef.current = stateLabel;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'updateLocation', location: stateLabel }));
    }
  }, [stateLabel]);

  // ─── Push-to-talk ─────────────────────────────────────────────────────────

  const handlePressIn = async () => {
    if (!micGranted) return;
    if (buttonStateRef.current === 'receiving') return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setButtonState('transmitting');
    playChirpOut();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'startTalk', userId: myUserId }));
    }

    if (WEBRTC_AVAILABLE) {
      // WebRTC: unmute the already-established local stream track
      localStreamRef.current?.getAudioTracks().forEach((t: any) => { t.enabled = true; });
    } else {
      // Fallback: start recording
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          playThroughEarpieceAndroid: false,
        });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );
        recordingRef.current = recording;
      } catch (e) {
        console.log('[Audio] Recording start error:', e);
      }
    }
  };

  const handlePressOut = async () => {
    if (buttonStateRef.current !== 'transmitting') return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setButtonState('idle');

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stopTalk', userId: myUserId }));
    }

    if (WEBRTC_AVAILABLE) {
      // WebRTC: mute the track — peer connections keep audio flowing silently
      localStreamRef.current?.getAudioTracks().forEach((t: any) => { t.enabled = false; });
    } else {
      // Fallback: stop recording and send audio over WebSocket
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (!recording) return;
      try {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        if (uri) {
          const base64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({ type: 'audio', data: base64, username: myUsername })
            );
          }
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          playThroughEarpieceAndroid: false,
        });
      } catch (e) {
        console.log('[Audio] Recording stop/send error:', e);
      }
    }
  };

  // ─── Permission gate ──────────────────────────────────────────────────────

  if (!hasRequested || (!micGranted && !micDenied)) {
    return (
      <PermissionScreen
        micGranted={micGranted}
        locationGranted={locationGranted}
        micDenied={micDenied}
        locationDenied={locationDenied}
        requesting={requesting}
        onAuthorize={requestAll}
      />
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const otherUsers = connectedUsers.filter((u) => u.userId !== myUserId);
  const totalOnline = connectedUsers.length;

  const getStatusText = () => {
    if (!micGranted) return 'MIC REQUIRED';
    if (buttonState === 'transmitting') return 'TRANSMITTING...';
    if (buttonState === 'receiving') return `${talkingUser ?? 'UNIT'} TRANSMITTING`;
    return 'HOLD TO TALK';
  };

  const getStatusColor = () => {
    if (!micGranted) return '#ef4444';
    if (buttonState === 'transmitting') return YELLOW;
    if (buttonState === 'receiving') return BURGUNDY;
    return GRAY;
  };

  if (isTablet) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={tabletStyles.layout}>
          {/* Left: button area */}
          <View style={tabletStyles.leftPanel}>
            <Animated.View style={[
              tabletStyles.rippleRing,
              pulseAnimStyle,
              { width: BTN_SIZE + 80, height: BTN_SIZE + 80 }
            ]} />
            <Pressable
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              testID="ptt-button"
              style={[styles.buttonContainer, !micGranted && styles.buttonContainerDisabled]}
              disabled={!micGranted}
            >
              <Animated.View style={[styles.buttonWrapper, buttonAnimStyle]}>
                <Image source={IMAGES[buttonState]} style={{ width: BTN_SIZE, height: BTN_SIZE }} resizeMode="contain" />
              </Animated.View>
            </Pressable>
            <Text style={[tabletStyles.statusText, { color: getStatusColor() }]}>{getStatusText()}</Text>
          </View>

          {/* Vertical divider */}
          <View style={tabletStyles.verticalDivider} />

          {/* Right: info panel */}
          <View style={tabletStyles.rightPanel}>
            {/* App header (title + badges) */}
            <View style={tabletStyles.rightHeader}>
              <View style={styles.channelBadge}>
                <Animated.View style={[styles.dot, dotAnimStyle, { backgroundColor: isConnected ? '#22c55e' : '#ef4444' }]} />
                <Text style={tabletStyles.channelText}>CH 1</Text>
              </View>
              <View style={styles.titleArea}>
                <Text style={tabletStyles.appTitle}>CHIRP</Text>
                {stateLabel ? <View style={styles.stateBadge}><Text style={styles.stateBadgeText}>{stateLabel}</Text></View> : null}
              </View>
              <View style={styles.userBadge}>
                <Text style={styles.userBadgeText}>{totalOnline} ONLINE</Text>
              </View>
            </View>
            <View style={styles.headerDivider} />

            {/* Users section fills remaining space */}
            <View style={tabletStyles.rightContent}>
              <Text style={tabletStyles.usersSectionTitle}>ON AIR</Text>
              <View style={tabletStyles.usersGrid}>
                {otherUsers.length === 0 ? (
                  <Text style={styles.noUsersText}>No other units online</Text>
                ) : (
                  otherUsers.slice(0, 12).map((user) => (
                    <View key={user.userId} style={[tabletStyles.userPill, talkingUser === user.username && styles.userPillActive]}>
                      <View style={[styles.userDot, { backgroundColor: talkingUser === user.username ? YELLOW : '#22c55e' }]} />
                      <Text style={[tabletStyles.userPillText, talkingUser === user.username && styles.userPillTextActive]}>
                        {user.location ? `${user.username} (${user.location})` : user.username}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </View>

            {/* My call sign at bottom */}
            {myUsername ? (
              <View style={[styles.myCallSign, { paddingHorizontal: 28, paddingBottom: 24 }]}>
                <View style={styles.myCallSignTextGroup}>
                  <View style={styles.myCallSignRow}>
                    <Text style={styles.myCallSignLabel}>YOUR CALL SIGN: </Text>
                    <Text style={styles.myCallSignValue}>{myUsername}</Text>
                  </View>
                  {stateLabel ? <Text style={styles.myCallSignLocation}>{stateLabel}</Text> : null}
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.channelBadge}>
          <Animated.View
            style={[
              styles.dot,
              dotAnimStyle,
              { backgroundColor: isConnected ? '#22c55e' : '#ef4444' },
            ]}
          />
          <Text style={styles.channelText}>CH 1</Text>
        </View>
        <View style={styles.titleArea}>
          <Text style={styles.appTitle}>CHIRP</Text>
          {stateLabel ? (
            <View style={styles.stateBadge}>
              <Text style={styles.stateBadgeText}>{stateLabel}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.userBadge}>
          <Text style={styles.userBadgeText}>{totalOnline} ONLINE</Text>
        </View>
      </View>
      <View style={styles.headerDivider} />

      {/* Button area */}
      <View style={styles.buttonArea}>
        <Animated.View style={[styles.rippleRing, pulseAnimStyle, { width: BTN_SIZE + 60, height: BTN_SIZE + 60 }]} />

        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          testID="ptt-button"
          style={[styles.buttonContainer, !micGranted && styles.buttonContainerDisabled]}
          disabled={!micGranted}
        >
          <Animated.View style={[styles.buttonWrapper, buttonAnimStyle, { width: BTN_SIZE, height: BTN_SIZE }]}>
            <Image
              source={IMAGES[buttonState]}
              style={[styles.buttonImage, { width: BTN_SIZE, height: BTN_SIZE }, !micGranted && styles.buttonImageDisabled]}
              resizeMode="contain"
            />
          </Animated.View>
        </Pressable>

        <Text style={[styles.statusText, { color: getStatusColor() }]}>
          {getStatusText()}
        </Text>
      </View>

      {/* Online users */}
      <View style={styles.usersSection}>
        <Text style={styles.usersSectionTitle}>ON AIR</Text>
        <View style={styles.usersRow}>
          {otherUsers.length === 0 ? (
            <Text style={styles.noUsersText}>No other units online</Text>
          ) : (
            otherUsers.slice(0, 6).map((user) => (
              <View
                key={user.userId}
                style={[
                  styles.userPill,
                  talkingUser === user.username && styles.userPillActive,
                ]}
              >
                <View
                  style={[
                    styles.userDot,
                    { backgroundColor: talkingUser === user.username ? YELLOW : '#22c55e' },
                  ]}
                />
                <Text
                  style={[
                    styles.userPillText,
                    talkingUser === user.username && styles.userPillTextActive,
                  ]}
                >
                  {user.location ? `${user.username} (${user.location})` : user.username}
                </Text>
              </View>
            ))
          )}
        </View>
        {myUsername ? (
          <View style={styles.myCallSign}>
            <View style={styles.myCallSignTextGroup}>
              <View style={styles.myCallSignRow}>
                <Text style={styles.myCallSignLabel}>YOUR CALL SIGN: </Text>
                <Text style={styles.myCallSignValue}>{myUsername}</Text>
              </View>
              {stateLabel ? (
                <Text style={styles.myCallSignLocation}>{stateLabel}</Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerDivider: {
    height: 2,
    backgroundColor: BURGUNDY,
    marginHorizontal: 20,
    opacity: 0.6,
  },
  channelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  channelText: {
    fontSize: 13,
    fontWeight: '700',
    color: BURGUNDY,
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  titleArea: {
    alignItems: 'center',
    gap: 4,
  },
  appTitle: {
    fontSize: 34,
    fontWeight: '900',
    color: BLACK,
    letterSpacing: 10,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-condensed',
  },
  stateBadge: {
    backgroundColor: BURGUNDY,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  stateBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: YELLOW,
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  userBadge: {
    backgroundColor: YELLOW,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  userBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: BLACK,
    letterSpacing: 1,
  },
  buttonArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rippleRing: {
    position: 'absolute',
    borderWidth: 3,
    borderRadius: 9999,
    borderColor: BURGUNDY,
  },
  buttonContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonContainerDisabled: {
    opacity: 0.35,
  },
  buttonWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonImage: {},
  buttonImageDisabled: {
    tintColor: GRAY,
  },
  statusText: {
    marginTop: 24,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  usersSection: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  usersSectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: BURGUNDY,
    letterSpacing: 3,
    marginBottom: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  usersRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    minHeight: 32,
  },
  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LIGHT_GRAY,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  userPillActive: {
    backgroundColor: BURGUNDY,
    borderColor: YELLOW,
  },
  userDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  userPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: BLACK,
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  userPillTextActive: {
    color: WHITE,
  },
  noUsersText: {
    fontSize: 12,
    color: GRAY,
    fontStyle: 'italic',
  },
  myCallSign: {
    flexDirection: 'row',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: LIGHT_GRAY,
    alignItems: 'flex-start',
  },
  myCallSignTextGroup: {
    flexDirection: 'column',
    gap: 2,
  },
  myCallSignRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  myCallSignLocation: {
    fontSize: 9,
    color: GRAY,
    fontWeight: '600',
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  myCallSignLabel: {
    fontSize: 10,
    color: GRAY,
    fontWeight: '600',
    letterSpacing: 1,
  },
  myCallSignValue: {
    fontSize: 12,
    color: BURGUNDY,
    fontWeight: '800',
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
});

const tabletStyles = StyleSheet.create({
  layout: {
    flex: 1,
    flexDirection: 'row',
  },
  leftPanel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WHITE,
  },
  rippleRing: {
    position: 'absolute',
    borderRadius: 9999,
    borderWidth: 3,
    borderColor: BURGUNDY,
  },
  verticalDivider: {
    width: 2,
    backgroundColor: BURGUNDY,
    opacity: 0.6,
    marginVertical: 20,
  },
  rightPanel: {
    width: 340,
    backgroundColor: WHITE,
    flexDirection: 'column',
  },
  rightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingVertical: 16,
  },
  rightContent: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 20,
  },
  appTitle: {
    fontSize: 42,
    fontWeight: '900',
    color: BLACK,
    letterSpacing: 10,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-condensed',
  },
  channelText: {
    fontSize: 16,
    fontWeight: '700',
    color: BURGUNDY,
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  statusText: {
    marginTop: 32,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  usersSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: BURGUNDY,
    letterSpacing: 3,
    marginBottom: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  usersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LIGHT_GRAY,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  userPillText: {
    fontSize: 14,
    fontWeight: '700',
    color: BLACK,
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
});
