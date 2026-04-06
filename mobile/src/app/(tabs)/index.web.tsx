import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ─── Constants ────────────────────────────────────────────────────────────────

const BURGUNDY = '#7C1A1A';
const YELLOW = '#F5C518';
const BLACK = '#0A0A0A';
const WHITE = '#FFFFFF';
const GRAY = '#888888';
const LIGHT_GRAY = '#F0F0F0';

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

// ─── Web Audio helpers ────────────────────────────────────────────────────────

function playAudioFromBase64(base64Data: string) {
  try {
    const audio = document.createElement('audio');
    audio.src = `data:audio/webm;base64,${base64Data}`;
    audio.play().catch((e) => {
      console.log('[Audio] Playback error:', e);
    });
  } catch (e) {
    console.log('[Audio] Could not play received audio:', e);
  }
}

// ─── Web-only mouse event props helper ───────────────────────────────────────
// Pressable's TypeScript types don't include mouse events, but React Native Web
// passes them through at runtime. We spread them as `any` to satisfy the compiler.

function webMouseProps(
  onMouseDown: () => void,
  onMouseUp: () => void,
  onMouseLeave: () => void,
): any {
  return { onMouseDown, onMouseUp, onMouseLeave };
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ChirpScreenWeb() {
  const { width: SCREEN_WIDTH } = useWindowDimensions();
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

  // Web audio refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

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
        Animated.timing(dotOpacity.current, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: false }),
        Animated.timing(dotOpacity.current, { toValue: 0.2, duration: 800, easing: Easing.linear, useNativeDriver: false }),
      ])
    );
    dotLoopAnim.current.start();
    return () => { dotLoopAnim.current?.stop(); };
  }, []);

  useEffect(() => {
    buttonStateRef.current = buttonState;
    if (buttonState === 'transmitting') {
      buttonScale.current.stopAnimation();
      Animated.timing(buttonScale.current, { toValue: 1.0, duration: 80, useNativeDriver: false }).start();
      pulseOpacity.current.setValue(0);
      pulseLoopAnim.current?.stop();
      pulseOpacityLoopAnim.current?.stop();
    } else if (buttonState === 'receiving') {
      buttonScale.current.stopAnimation();
      Animated.spring(buttonScale.current, { toValue: 1.0, useNativeDriver: false }).start();
      pulseScale.current.setValue(1);
      pulseOpacity.current.setValue(0.5);
      pulseLoopAnim.current = Animated.loop(
        Animated.timing(pulseScale.current, { toValue: 1.35, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: false })
      );
      pulseLoopAnim.current.start();
      pulseOpacityLoopAnim.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseOpacity.current, { toValue: 0.5, duration: 0, useNativeDriver: false }),
          Animated.timing(pulseOpacity.current, { toValue: 0, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: false }),
        ])
      );
      pulseOpacityLoopAnim.current.start();
    } else {
      buttonScale.current.stopAnimation();
      pulseLoopAnim.current?.stop();
      pulseOpacityLoopAnim.current?.stop();
      Animated.spring(buttonScale.current, { toValue: 1.0, useNativeDriver: false }).start();
      Animated.timing(pulseOpacity.current, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
  }, [buttonState]);

  const buttonAnimStyle = { transform: [{ scale: buttonScale.current }] };
  const pulseAnimStyle = { transform: [{ scale: pulseScale.current }], opacity: pulseOpacity.current };
  const dotAnimStyle = { opacity: dotOpacity.current };

  // ─── Init user identity ───────────────────────────────────────────────────

  useEffect(() => {
    let uid = localStorage.getItem('chirp_userId');
    let uname = localStorage.getItem('chirp_username');
    if (!uid) {
      uid = generateUserId();
      localStorage.setItem('chirp_userId', uid);
    }
    if (!uname) {
      uname = generateCallSign();
      localStorage.setItem('chirp_username', uname);
    }
    setMyUserId(uid);
    setMyUsername(uname);
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

    ws.onopen = () => {
      setIsConnected(true);
      console.log('[WS] Connected');
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('[WS] Disconnected. Reconnecting in 3s...');
      reconnectTimeoutRef.current = setTimeout(() => {
        if (wsRef.current === ws) connectWs();
      }, 3000);
    };

    ws.onerror = (e) => {
      console.log('[WS] Error:', e);
    };

    ws.onmessage = (event) => {
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
        } else if (msg.type === 'userLeft') {
          setConnectedUsers((prev) => prev.filter((u) => u.userId !== msg.userId));
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
          }
        } else if (msg.type === 'stopTalk') {
          if (buttonStateRef.current === 'receiving') {
            setButtonState('idle');
            setTalkingUser(null);
          }
        } else if (msg.type === 'audio') {
          playAudioFromBase64(msg.data);
        }
      } catch (e) {
        console.log('[WS] Message error:', e);
      }
    };
  }, [myUserId, myUsername]);

  useEffect(() => {
    if (myUserId && myUsername) {
      connectWs();
    }
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [myUserId, myUsername, connectWs]);

  // ─── Push-to-talk (web) ───────────────────────────────────────────────────

  const handlePressIn = async () => {
    if (buttonStateRef.current === 'receiving') return;

    setButtonState('transmitting');

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'startTalk', userId: myUserId }));
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      recorder.start();
    } catch (e) {
      console.log('[Audio] getUserMedia error:', e);
    }
  };

  const handlePressOut = async () => {
    if (buttonStateRef.current !== 'transmitting') return;

    setButtonState('idle');

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stopTalk', userId: myUserId }));
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    recorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        if (base64 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'audio', data: base64, username: myUsername }));
        }
      };
      reader.readAsDataURL(blob);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];
    };

    recorder.stop();
  };

  // ─── Render helpers ───────────────────────────────────────────────────────

  const otherUsers = connectedUsers.filter((u) => u.userId !== myUserId);
  const totalOnline = connectedUsers.length;

  const getStatusText = () => {
    if (buttonState === 'transmitting') return 'TRANSMITTING...';
    if (buttonState === 'receiving') return `${talkingUser ?? 'UNIT'} TRANSMITTING`;
    return 'HOLD TO TALK';
  };

  const getStatusColor = () => {
    if (buttonState === 'transmitting') return YELLOW;
    if (buttonState === 'receiving') return BURGUNDY;
    return GRAY;
  };

  // ─── Tablet layout ────────────────────────────────────────────────────────

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
              {...webMouseProps(handlePressIn, handlePressOut, handlePressOut)}
              testID="ptt-button"
              style={styles.buttonContainer}
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
            <View style={tabletStyles.rightHeader}>
              <View style={styles.channelBadge}>
                <Animated.View style={[styles.dot, dotAnimStyle, { backgroundColor: isConnected ? '#22c55e' : '#ef4444' }]} />
                <Text style={tabletStyles.channelText}>CH 1</Text>
              </View>
              <View style={styles.titleArea}>
                <Text style={tabletStyles.appTitle}>CHIRP</Text>
              </View>
              <View style={styles.userBadge}>
                <Text style={styles.userBadgeText}>{totalOnline} ONLINE</Text>
              </View>
            </View>
            <View style={styles.headerDivider} />

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

            {myUsername ? (
              <View style={[styles.myCallSign, { paddingHorizontal: 28, paddingBottom: 24 }]}>
                <View style={styles.myCallSignTextGroup}>
                  <View style={styles.myCallSignRow}>
                    <Text style={styles.myCallSignLabel}>YOUR CALL SIGN: </Text>
                    <Text style={styles.myCallSignValue}>{myUsername}</Text>
                  </View>
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Mobile layout ────────────────────────────────────────────────────────

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
          {...webMouseProps(handlePressIn, handlePressOut, handlePressOut)}
          testID="ptt-button"
          style={styles.buttonContainer}
        >
          <Animated.View style={[styles.buttonWrapper, buttonAnimStyle, { width: BTN_SIZE, height: BTN_SIZE }]}>
            <Image
              source={IMAGES[buttonState]}
              style={[styles.buttonImage, { width: BTN_SIZE, height: BTN_SIZE }]}
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
    fontFamily: 'monospace',
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
    fontFamily: 'sans-serif-condensed',
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
  buttonWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonImage: {},
  statusText: {
    marginTop: 24,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: 'monospace',
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
    fontFamily: 'monospace',
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
    fontFamily: 'monospace',
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
    fontFamily: 'monospace',
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
    fontFamily: 'sans-serif-condensed',
  },
  channelText: {
    fontSize: 16,
    fontWeight: '700',
    color: BURGUNDY,
    letterSpacing: 2,
    fontFamily: 'monospace',
  },
  statusText: {
    marginTop: 32,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: 'monospace',
  },
  usersSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: BURGUNDY,
    letterSpacing: 3,
    marginBottom: 14,
    fontFamily: 'monospace',
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
    fontFamily: 'monospace',
  },
  userPillTextActive: {
    color: WHITE,
  },
});
