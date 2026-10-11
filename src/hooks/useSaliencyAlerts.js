import { useState, useEffect, useRef } from 'react';
import { Vibration } from 'react-native';
import { useLiveQuery } from './useLiveQuery';

const markerId = (marker) => marker._id || marker.id;

/**
 * useSaliencyAlerts - Monitors tactical markers for high-priority hazards.
 * When a new 'hazard' type marker is synced via the mesh, it triggers
 * a saliency event to alert the user immediately.
 *
 * Markers already present at startup, markers dropped by the current user
 * and marker removals do not raise an alert.
 */
export const useSaliencyAlerts = (currentUserId) => {
  const { markers, loading } = useLiveQuery();
  const [alert, setAlert] = useState(null);
  const seenIdsRef = useRef(null);

  useEffect(() => {
    if (loading) return;

    // First snapshot: remember what is already on the map without alerting
    if (seenIdsRef.current === null) {
      seenIdsRef.current = new Set(markers.map(markerId));
      return;
    }

    const newMarkers = markers.filter((m) => !seenIdsRef.current.has(markerId(m)));
    newMarkers.forEach((m) => seenIdsRef.current.add(markerId(m)));

    const hazard = newMarkers.find(
      (m) => (m.type === 'hazard' || m.type === 'emergency') && m.author_id !== currentUserId
    );

    if (hazard) {
      Vibration.vibrate([0, 500, 200, 500, 200, 500]);
      setAlert({
        id: markerId(hazard),
        title: '⚠️ CRITICAL HAZARD DETECTED',
        message: `${hazard.author_name || 'Unknown'} reported a hazard nearby!`,
        type: 'hazard',
        timestamp: hazard.timestamp,
      });
    }
  }, [markers, loading, currentUserId]);

  // Auto-clear alert after 5 seconds
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 5000);
    return () => clearTimeout(timer);
  }, [alert]);

  return { alert, clearAlert: () => setAlert(null) };
};
