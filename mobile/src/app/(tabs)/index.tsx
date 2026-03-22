import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import { usePermissions, useStateLabel } from '../../hooks/usePermissions';
import PermissionScreen from '../../components/PermissionScreen';

// suppress unused import warning — expo-location is used via usePermissions hook
void Location;

// ─── Constants ────────────────────────────────────────────────────────────────

const BURGUNDY = '#7C1A1A';
const YELLOW = '#F5C518';
const BLACK = '#0A0A0A';
const WHITE = '#FFFFFF';
const GRAY = '#888888';
const LIGHT_GRAY = '#F0F0F0';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const BTN_SIZE = Math.min(SCREEN_WIDTH * 0.72, 300);

type ButtonState = 'idle' | 'transmitting' | 'receiving';

interface User {
  userId: string;
  username: string;
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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

async function loadChirpSounds() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
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
  const [buttonState, setButtonState] = useState<ButtonState>('idle');
  const [connectedUsers, setConnectedUsers] = useState<User[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [myUserId, setMyUserId] = useState<string>('');
  const [myUsername, setMyUsername] = useState<string>('');
  const [talkingUser, setTalkingUser] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonStateRef = useRef<ButtonState>('idle');

  // WebRTC refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidate[]>>(new Map());

  // Inactivity tracking: replay inbound chirp if > 10s since last activity
  const lastActivityRef = useRef<number>(0);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ─── Animations ────────────────────────────────────────────────────────────

  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);
  const buttonScale = useSharedValue(1);
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800 }),
        withTiming(0.2, { duration: 800 })
      ),
      -1,
      false
    );
  }, []);

  useEffect(() => {
    buttonStateRef.current = buttonState;
    if (buttonState === 'transmitting') {
      cancelAnimation(buttonScale);
      buttonScale.value = withTiming(1.0, { duration: 80 });
      pulseOpacity.value = 0;
    } else if (buttonState === 'receiving') {
      cancelAnimation(buttonScale);
      buttonScale.value = withSpring(1.0);
      pulseScale.value = 1;
      pulseOpacity.value = 0.5;
      pulseScale.value = withRepeat(
        withTiming(1.35, { duration: 1000, easing: Easing.out(Easing.ease) }),
        -1,
        false
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 0 }),
          withTiming(0, { duration: 1000, easing: Easing.out(Easing.ease) })
        ),
        -1,
        false
      );
    } else {
      cancelAnimation(buttonScale);
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
      buttonScale.value = withSpring(1.0);
      pulseOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [buttonState]);

  const buttonAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const pulseAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  const dotAnimStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  // ─── Init user identity ───────────────────────────────────────────────────

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
    loadChirpSounds();
  }, []);

  // ─── WebRTC helpers ───────────────────────────────────────────────────────

  const initLocalStream = useCallback(async () => {
    if (localStreamRef.current) return;
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false }) as MediaStream;
      // Start muted — PTT enables the track
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
      localStreamRef.current = stream;
      console.log('[WebRTC] Local stream ready');
    } catch (e) {
      console.log('[WebRTC] getUserMedia error:', e);
    }
  }, []);

  const createPeerConnection = useCallback((remoteUserId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current!);
    });

    (pc as any).addEventListener('icecandidate', (event: any) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'webrtc-ice-candidate',
          toUserId: remoteUserId,
          candidate: event.candidate,
        }));
      }
    });

    (pc as any).addEventListener('track', (event: any) => {
      console.log('[WebRTC] Remote track received from', remoteUserId);
    });

    (pc as any).addEventListener('connectionstatechange', () => {
      console.log('[WebRTC] Connection state with', remoteUserId, ':', pc.connectionState);
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
    const url = `${base}/ws?userId=${encodeURIComponent(myUserId)}&username=${encodeURIComponent(myUsername)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = async () => {
      setIsConnected(true);
      console.log('[WS] Connected');
      await initLocalStream();
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('[WS] Disconnected. Reconnecting in 3s...');
      reconnectTimeoutRef.current = setTimeout(() => connectWs(), 3000);
    };

    ws.onerror = (e) => {
      console.log('[WS] Error:', e);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string) as any;

        if (msg.type === 'userList') {
          setConnectedUsers(msg.users ?? []);
        } else if (msg.type === 'userJoined') {
          setConnectedUsers((prev) => {
            if (prev.find((u) => u.userId === msg.userId)) return prev;
            return [...prev, { userId: msg.userId ?? '', username: msg.username ?? '' }];
          });
          await initLocalStream();
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
        } else if (msg.type === 'userLeft') {
          setConnectedUsers((prev) => prev.filter((u) => u.userId !== msg.userId));
          closePeerConnection(msg.userId);
          if (buttonStateRef.current === 'receiving') {
            setButtonState('idle');
            setTalkingUser(null);
          }
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
        } else if (msg.type === 'webrtc-offer') {
          await initLocalStream();
          let pc = peerConnectionsRef.current.get(msg.fromUserId);
          if (!pc) pc = createPeerConnection(msg.fromUserId);
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const pending = pendingCandidatesRef.current.get(msg.fromUserId) ?? [];
            for (const c of pending) await pc.addIceCandidate(c);
            pendingCandidatesRef.current.delete(msg.fromUserId);
          }
        } else if (msg.type === 'webrtc-ice-candidate') {
          const pc = peerConnectionsRef.current.get(msg.fromUserId);
          const candidate = new RTCIceCandidate(msg.candidate);
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(candidate);
          } else {
            const arr = pendingCandidatesRef.current.get(msg.fromUserId) ?? [];
            arr.push(candidate);
            pendingCandidatesRef.current.set(msg.fromUserId, arr);
          }
        }
      } catch (e) {
        console.log('[WS] Message error:', e);
      }
    };
  }, [myUserId, myUsername, createPeerConnection, closePeerConnection, initLocalStream]);

  // Only connect WebSocket once mic is granted
  useEffect(() => {
    if (myUserId && myUsername && micGranted) {
      connectWs();
    }
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      peerConnectionsRef.current.forEach((pc) => pc.close());
      peerConnectionsRef.current.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      wsRef.current?.close();
    };
  }, [myUserId, myUsername, micGranted, connectWs]);

  // ─── Push-to-talk ─────────────────────────────────────────────────────────

  const handlePressIn = () => {
    if (!micGranted) return;
    if (buttonStateRef.current === 'receiving') return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setButtonState('transmitting');
    playChirpOut();

    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = true; });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'startTalk', userId: myUserId }));
    }
  };

  const handlePressOut = () => {
    if (buttonStateRef.current !== 'transmitting') return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setButtonState('idle');

    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stopTalk', userId: myUserId }));
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
        <Animated.View style={[styles.rippleRing, pulseAnimStyle]} />

        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          testID="ptt-button"
          style={[styles.buttonContainer, !micGranted && styles.buttonContainerDisabled]}
          disabled={!micGranted}
        >
          <Animated.View style={[styles.buttonWrapper, buttonAnimStyle]}>
            <Image
              source={IMAGES[buttonState]}
              style={[styles.buttonImage, !micGranted && styles.buttonImageDisabled]}
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
                  {user.username}
                </Text>
              </View>
            ))
          )}
        </View>
        {myUsername ? (
          <View style={styles.myCallSign}>
            <Text style={styles.myCallSignLabel}>YOUR CALL SIGN: </Text>
            <Text style={styles.myCallSignValue}>{myUsername}</Text>
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
    width: BTN_SIZE + 60,
    height: BTN_SIZE + 60,
    borderRadius: (BTN_SIZE + 60) / 2,
    borderWidth: 3,
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
    width: BTN_SIZE,
    height: BTN_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonImage: {
    width: BTN_SIZE,
    height: BTN_SIZE,
  },
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
    alignItems: 'center',
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
