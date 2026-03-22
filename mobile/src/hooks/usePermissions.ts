import { useState, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';

export type StateLabel = 'NJ' | 'PA' | 'NY' | null;

interface PermissionsState {
  micGranted: boolean;
  locationGranted: boolean;
  micDenied: boolean;
  locationDenied: boolean;
  requesting: boolean;
  hasRequested: boolean;
}

interface UsePermissionsReturn extends PermissionsState {
  requestAll: () => Promise<void>;
}

export function usePermissions(): UsePermissionsReturn {
  const [state, setState] = useState<PermissionsState>({
    micGranted: false,
    locationGranted: false,
    micDenied: false,
    locationDenied: false,
    requesting: false,
    hasRequested: false,
  });

  const requestAll = useCallback(async () => {
    setState((prev) => ({ ...prev, requesting: true }));

    try {
      const micResult = await Audio.requestPermissionsAsync();
      const locResult = await Location.requestForegroundPermissionsAsync();

      const micGranted = micResult.status === 'granted';
      const locationGranted = locResult.status === 'granted';
      const micDenied = micResult.status === 'denied' || micResult.canAskAgain === false;
      const locationDenied = locResult.status === 'denied' || locResult.canAskAgain === false;

      setState({
        micGranted,
        locationGranted,
        micDenied: !micGranted && micDenied,
        locationDenied: !locationGranted && locationDenied,
        requesting: false,
        hasRequested: true,
      });
    } catch (e) {
      console.log('[usePermissions] Error requesting permissions:', e);
      setState((prev) => ({ ...prev, requesting: false, hasRequested: true }));
    }
  }, []);

  return {
    ...state,
    requestAll,
  };
}

function getStateLabel(lat: number, lon: number): StateLabel {
  // NJ: lat 38.9-41.4, lon -75.6 to -73.9
  if (lat >= 38.9 && lat <= 41.4 && lon >= -75.6 && lon <= -73.9) {
    return 'NJ';
  }
  // PA: lat 39.7-42.5, lon -80.5 to -74.7
  if (lat >= 39.7 && lat <= 42.5 && lon >= -80.5 && lon <= -74.7) {
    return 'PA';
  }
  // NY: lat 40.5-45.0, lon -79.8 to -71.9
  if (lat >= 40.5 && lat <= 45.0 && lon >= -79.8 && lon <= -71.9) {
    return 'NY';
  }
  return null;
}

export function useStateLabel(locationGranted: boolean): StateLabel {
  const [label, setLabel] = useState<StateLabel>(null);

  useEffect(() => {
    if (!locationGranted) {
      setLabel(null);
      return;
    }

    let cancelled = false;

    async function fetchLocation() {
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Lowest,
        });
        if (!cancelled) {
          setLabel(getStateLabel(pos.coords.latitude, pos.coords.longitude));
        }
      } catch (e) {
        console.log('[useStateLabel] Location error:', e);
      }
    }

    fetchLocation();

    return () => {
      cancelled = true;
    };
  }, [locationGranted]);

  return label;
}
