import React, { useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { Mic, MapPin } from 'lucide-react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

const BLACK = '#0A0A0A';
const BURGUNDY = '#7C1A1A';
const YELLOW = '#F5C518';
const WHITE = '#FFFFFF';
const GRAY = '#888888';
const LIGHT_GRAY = '#F0F0F0';
const DARK_GRAY = '#1A1A1A';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PermissionItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  granted: boolean;
  denied: boolean;
  index: number;
}

interface PermissionScreenProps {
  micGranted: boolean;
  locationGranted: boolean;
  micDenied: boolean;
  locationDenied: boolean;
  requesting: boolean;
  onAuthorize: () => void;
}

// ─── Permission Item ──────────────────────────────────────────────────────────

function PermissionItem({
  icon,
  title,
  description,
  granted,
  denied,
  index,
}: PermissionItemProps) {
  const translateY = useSharedValue(40);
  const opacity = useSharedValue(0);

  useEffect(() => {
    const delay = 400 + index * 120;
    translateY.value = withDelay(
      delay,
      withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) })
    );
    opacity.value = withDelay(
      delay,
      withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) })
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  const statusColor = granted ? '#22c55e' : denied ? '#ef4444' : GRAY;
  const statusText = granted ? 'GRANTED' : denied ? 'DENIED' : 'REQUIRED';

  return (
    <Animated.View style={[styles.permItem, animStyle]}>
      <View style={styles.permIconWrap}>{icon}</View>
      <View style={styles.permContent}>
        <Text style={styles.permTitle}>{title}</Text>
        <Text style={styles.permDesc}>{description}</Text>
      </View>
      <View style={[styles.permStatus, { borderColor: statusColor }]}>
        <Text style={[styles.permStatusText, { color: statusColor }]}>
          {statusText}
        </Text>
      </View>
    </Animated.View>
  );
}

// ─── Permission Screen ────────────────────────────────────────────────────────

export default function PermissionScreen({
  micGranted,
  locationGranted,
  micDenied,
  locationDenied,
  requesting,
  onAuthorize,
}: PermissionScreenProps) {
  const titleOpacity = useSharedValue(0);
  const titleTranslateY = useSharedValue(-20);
  const subtitleOpacity = useSharedValue(0);
  const cardOpacity = useSharedValue(0);
  const cardTranslateY = useSharedValue(30);
  const btnOpacity = useSharedValue(0);
  const btnTranslateY = useSharedValue(20);

  useEffect(() => {
    titleOpacity.value = withTiming(1, { duration: 600, easing: Easing.out(Easing.cubic) });
    titleTranslateY.value = withTiming(0, { duration: 600, easing: Easing.out(Easing.cubic) });

    subtitleOpacity.value = withDelay(
      200,
      withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) })
    );

    cardOpacity.value = withDelay(
      300,
      withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) })
    );
    cardTranslateY.value = withDelay(
      300,
      withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) })
    );

    btnOpacity.value = withDelay(
      700,
      withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic) })
    );
    btnTranslateY.value = withDelay(
      700,
      withTiming(0, { duration: 400, easing: Easing.out(Easing.cubic) })
    );
  }, []);

  const titleAnimStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: titleTranslateY.value }],
  }));

  const subtitleAnimStyle = useAnimatedStyle(() => ({
    opacity: subtitleOpacity.value,
  }));

  const cardAnimStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ translateY: cardTranslateY.value }],
  }));

  const btnAnimStyle = useAnimatedStyle(() => ({
    opacity: btnOpacity.value,
    transform: [{ translateY: btnTranslateY.value }],
  }));

  const anyPermanentlyDenied = micDenied || locationDenied;

  return (
    <SafeAreaView style={styles.container} testID="permission-screen">
      {/* Header stripe */}
      <View style={styles.stripe} />

      {/* Title */}
      <Animated.View style={[styles.titleWrap, titleAnimStyle]}>
        <Text style={styles.appTitle}>CHIRP</Text>
        <View style={styles.titleUnderline} />
      </Animated.View>

      {/* Subtitle */}
      <Animated.Text style={[styles.subtitle, subtitleAnimStyle]}>
        ACCESS REQUIRED
      </Animated.Text>
      <Animated.Text style={[styles.subtitleDesc, subtitleAnimStyle]}>
        This app requires the following permissions to operate.
      </Animated.Text>

      {/* Permissions card */}
      <Animated.View style={[styles.card, cardAnimStyle]}>
        <PermissionItem
          icon={<Mic size={22} color={micGranted ? '#22c55e' : BURGUNDY} strokeWidth={2.5} />}
          title="MICROPHONE ACCESS"
          description="Required to transmit audio to other units"
          granted={micGranted}
          denied={micDenied}
          index={0}
        />
        <View style={styles.divider} />
        <PermissionItem
          icon={<MapPin size={22} color={locationGranted ? '#22c55e' : BURGUNDY} strokeWidth={2.5} />}
          title="LOCATION ACCESS"
          description="Determines your operating region (NJ · PA · NY)"
          granted={locationGranted}
          denied={locationDenied}
          index={1}
        />
      </Animated.View>

      {/* Button */}
      <Animated.View style={[styles.btnWrap, btnAnimStyle]}>
        {anyPermanentlyDenied ? (
          <Pressable
            onPress={() => Linking.openSettings()}
            style={styles.settingsBtn}
            testID="open-settings-button"
          >
            <Text style={styles.settingsBtnText}>OPEN SETTINGS</Text>
          </Pressable>
        ) : null}

        {!micGranted || !locationGranted ? (
          <Pressable
            onPress={onAuthorize}
            disabled={requesting}
            style={[styles.authorizeBtn, requesting && styles.authorizeBtnDisabled]}
            testID="authorize-button"
          >
            <Text style={styles.authorizeBtnText}>
              {requesting ? 'AUTHORIZING...' : 'AUTHORIZE'}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>

      {/* Bottom note */}
      <Animated.Text style={[styles.note, subtitleAnimStyle]}>
        You can change permissions at any time in Settings.
      </Animated.Text>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
    paddingHorizontal: 24,
  },
  stripe: {
    height: 4,
    backgroundColor: BURGUNDY,
    marginHorizontal: -24,
    marginBottom: 0,
  },
  titleWrap: {
    marginTop: 48,
    alignItems: 'center',
  },
  appTitle: {
    fontSize: 56,
    fontWeight: '900',
    color: BLACK,
    letterSpacing: 14,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-condensed',
  },
  titleUnderline: {
    width: 60,
    height: 3,
    backgroundColor: YELLOW,
    marginTop: 8,
    borderRadius: 2,
  },
  subtitle: {
    marginTop: 32,
    fontSize: 11,
    fontWeight: '800',
    color: BURGUNDY,
    letterSpacing: 4,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  subtitleDesc: {
    marginTop: 8,
    fontSize: 13,
    color: GRAY,
    textAlign: 'center',
    lineHeight: 18,
  },
  card: {
    marginTop: 32,
    backgroundColor: DARK_GRAY,
    borderRadius: 16,
    paddingVertical: 8,
    shadowColor: BLACK,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  permItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
    gap: 14,
  },
  permIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(124, 26, 26, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  permContent: {
    flex: 1,
    gap: 3,
  },
  permTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: WHITE,
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  permDesc: {
    fontSize: 12,
    color: '#AAAAAA',
    lineHeight: 16,
  },
  permStatus: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  permStatusText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginHorizontal: 20,
  },
  btnWrap: {
    marginTop: 32,
    gap: 12,
  },
  authorizeBtn: {
    backgroundColor: BURGUNDY,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: BURGUNDY,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  authorizeBtnDisabled: {
    opacity: 0.5,
  },
  authorizeBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: WHITE,
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  settingsBtn: {
    backgroundColor: LIGHT_GRAY,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DDDDDD',
  },
  settingsBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: BLACK,
    letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  note: {
    marginTop: 20,
    fontSize: 11,
    color: GRAY,
    textAlign: 'center',
  },
});
