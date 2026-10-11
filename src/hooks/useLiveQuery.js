import { useState, useEffect, useCallback } from 'react';
import MeshBackend from '../services/MeshBackend';

/**
 * Custom hook to listen to tactical_markers in real-time.
 */
export const useLiveQuery = () => {
  const [markers, setMarkers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribe = null;

    const startListening = () => {
      unsubscribe = MeshBackend.subscribeToMarkers((docs) => {
        setMarkers(Array.isArray(docs) ? docs : []);
        setLoading(false);
      });

      // If subscription failed, stop loading
      if (!unsubscribe) {
        setLoading(false);
      }
    };

    // The mesh is initialized by MapScreen after this hook mounts, so wait for it
    const cancelReady = MeshBackend.onReady(startListening);

    return () => {
      cancelReady();
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  return { markers, loading };
};
