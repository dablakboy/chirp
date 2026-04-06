import { useState, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';

export type StateLabel = string | null;

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
        if (cancelled) return;

        const results = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });

        if (cancelled) return;

        const region = results?.[0]?.region ?? results?.[0]?.subregion ?? null;
        if (region) {
          // expo-location returns the full state name on some platforms — abbreviate it
          const abbrev = US_STATE_ABBREVS[region.toUpperCase()] ?? (region.length <= 3 ? region.toUpperCase() : null);
          setLabel((abbrev as StateLabel) ?? null);
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

const US_STATE_ABBREVS: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};
